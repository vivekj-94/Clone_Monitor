#!/usr/bin/env node
// Opens the assembled static site in headless Chromium in REPLAY mode (no
// backend anywhere) and reports how well the snapshot covers what the
// dashboard asks for. Used locally and as the last gate in CI before deploy.
//
// With --site-origin the browser believes it is on the real Pages host and
// every request to that origin is served by the local static server, so an
// /api call that slipped past the shim shows up as a request to
// <origin>/api/... exactly as it would on GitHub Pages.
//
// After the initial load it jumps the clock forward (--fast-forward) and
// measures again: that is what a tab left open sees when refresh loops fire.
//
// Fails (exit 1) when the page throws on boot, the shim is missing, or the
// initial-load replay hit rate is below --min-hit-rate.
//
// Usage:
//   node snapshot/verify.mjs --url http://127.0.0.1:8091/Clone_Monitor/ --report-dir out \
//     [--site-origin https://vivekj-94.github.io]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const WM_DIR = path.resolve(
  process.env.WM_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'worldmonitor'),
);
function loadPlaywright() {
  for (const from of [path.join(WM_DIR, 'package.json'), import.meta.url]) {
    try {
      return createRequire(from)('playwright');
    } catch {}
  }
  throw new Error('playwright not found: run npm ci in worldmonitor/ first');
}
const { chromium } = loadPlaywright();

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    'site-origin': { type: 'string', default: '' },
    'report-dir': { type: 'string', default: '.' },
    seconds: { type: 'string', default: '40' },
    'fast-forward': { type: 'string', default: '31:00' },
    'min-hit-rate': { type: 'string', default: '0.6' },
    viewport: { type: 'string', default: '1920x1080' },
  },
});
if (!opts.url) {
  console.error('verify.mjs: --url is required');
  process.exit(2);
}
const LOCAL = new URL(opts.url);
const SITE_ORIGIN = opts['site-origin'] ? new URL(opts['site-origin']).origin : '';
const PAGE_URL = SITE_ORIGIN ? `${SITE_ORIGIN}${LOCAL.pathname}${LOCAL.search}` : LOCAL.href;
const PAGE_ORIGIN = SITE_ORIGIN || LOCAL.origin;
const BASE = LOCAL.pathname;
const [vw, vh] = opts.viewport.split('x').map(Number);
const REPORT_DIR = path.resolve(opts['report-dir']);
fs.mkdirSync(REPORT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: vw, height: vh },
  locale: 'en-US',
  timezoneId: 'UTC',
  serviceWorkers: 'block',
});
if (SITE_ORIGIN) {
  await context.route(`${SITE_ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `${LOCAL.origin}${u.pathname}${u.search}`, maxRedirects: 0 });
      await route.fulfill({ response });
    } catch {
      await route.abort('failed').catch(() => {});
    }
  });
}
const page = await context.newPage();
if (opts['fast-forward']) await page.clock.install();
const pageErrors = [];
const outside = new Set();
const apiOnNetwork = new Set();
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('request', (req) => {
  const u = new URL(req.url());
  if (u.origin !== PAGE_ORIGIN) return;
  if (u.pathname.startsWith('/api/')) apiOnNetwork.add(`${req.method()} ${u.pathname}`);
  else if (!u.pathname.startsWith(BASE)) outside.add(u.pathname);
});

const snap = () => page.evaluate(() => (window.__cmSnapshot ? JSON.parse(JSON.stringify(window.__cmSnapshot)) : null));

await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 120_000 });
await page.waitForTimeout(Number(opts.seconds) * 1000);
await page.screenshot({ path: path.join(REPORT_DIR, 'verify.png') });
const initial = await snap();
const banner = await page.evaluate(() => !!document.getElementById('cm-snapshot-banner'));

let later = null;
if (opts['fast-forward'] && initial) {
  await page.clock.fastForward(opts['fast-forward']);
  await page.waitForTimeout(15_000);
  later = await snap();
  await page.screenshot({ path: path.join(REPORT_DIR, 'verify-later.png') });
}
await browser.close();

const rate = (s) => {
  const served = s ? s.hits + s.fuzzy : 0;
  const asked = s ? served + s.misses : 0;
  return { served, asked, hitRate: asked ? served / asked : 0 };
};
const r0 = rate(initial);
const r1 = later ? rate(later) : null;
const report = {
  url: PAGE_URL,
  shim: initial,
  banner,
  hitRate: Number(r0.hitRate.toFixed(3)),
  afterFastForward: later && {
    by: opts['fast-forward'],
    newRequests: r1.asked - r0.asked,
    newMisses: later.misses - initial.misses,
    missed: later.missed.slice(initial.missed.length),
  },
  pageErrors,
  apiRequestsThatReachedTheNetwork: [...apiOnNetwork].sort(),
  sameOriginRequestsOutsideBase: [...outside].sort(),
};
fs.writeFileSync(path.join(REPORT_DIR, 'verify-report.json'), JSON.stringify(report, null, 2));
console.log(
  `verify: ${r0.served}/${r0.asked} API requests served from snapshot (exact ${initial?.hits ?? 0}, fuzzy ${initial?.fuzzy ?? 0}, miss ${initial?.misses ?? 0}); ` +
    `hit rate ${(r0.hitRate * 100).toFixed(1)}%; banner ${banner}; page errors ${pageErrors.length}; ` +
    `outside-base requests ${outside.size}; api on network ${apiOnNetwork.size}` +
    (report.afterFastForward
      ? `; after +${opts['fast-forward']}: ${report.afterFastForward.newRequests} more requests, ${report.afterFastForward.newMisses} missed`
      : ''),
);

const problems = [];
if (!initial) problems.push('snapshot shim did not load');
if (r0.hitRate < Number(opts['min-hit-rate'])) problems.push(`hit rate ${r0.hitRate.toFixed(2)} < ${opts['min-hit-rate']}`);
if (pageErrors.length) problems.push(`${pageErrors.length} uncaught page errors`);
if (problems.length) {
  console.error(`verify: FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
