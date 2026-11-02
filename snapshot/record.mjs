#!/usr/bin/env node
// Records every /api/* response the World Monitor dashboard makes while it
// loads against the live backend running in the CI job.
//
// The page is the SAME built site that gets published, served under the
// Pages base by serve.mjs (with /api proxied to the backend). The snapshot
// shim (cm-snapshot.js) runs in record mode and hands each response to
// window.__cmRecord, so record and replay share one request-key function.
//
// With --site-origin (e.g. https://vivekj-94.github.io) the browser believes
// it is on the real Pages host: every request to that origin is routed to
// the local server, so hostname-dependent app code behaves as in production.
//
// Each pass: load, sweep every scrollable area so lazy panels mount, then
// jump the clock forward (--fast-forward) so refresh loops fire and their
// requests are captured too. The first pass also requests every on-demand
// bootstrap key directly, so drill-downs a visitor opens later can hydrate.
//
// Output (--out):
//   manifest.json   { generatedAt, upstreamSha, passes, entries: { key: {...} } }
//   r/<file>        raw response bodies
// and in --report-dir: record-<pass>.png, record-report.json.
//
// Usage:
//   node snapshot/record.mjs --url http://127.0.0.1:8090/Clone_Monitor/ --out site/snapshot \
//     [--site-origin https://vivekj-94.github.io]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const WM_DIR = path.resolve(
  process.env.WM_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'worldmonitor'),
);

// Playwright comes from worldmonitor's own devDependencies (@playwright/test)
// in CI; fall back to one resolvable from here (e.g. a global install).
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
    out: { type: 'string' },
    'site-origin': { type: 'string', default: '' },
    seconds: { type: 'string', default: '75' },
    'fast-forward': { type: 'string', default: '31:00,31:00' },
    passes: { type: 'string', default: 'desktop,mobile' },
    'upstream-sha': { type: 'string', default: process.env.UPSTREAM_SHA || '' },
    // Names of env vars whose VALUES must never appear in published output.
    'secret-env': { type: 'string', default: process.env.CM_SECRET_ENV_NAMES || '' },
    'report-dir': { type: 'string' },
  },
});

if (!opts.url || !opts.out) {
  console.error('record.mjs: --url and --out are required');
  process.exit(2);
}

const LOCAL = new URL(opts.url);
const SITE_ORIGIN = opts['site-origin'] ? new URL(opts['site-origin']).origin : '';
const PAGE_URL = SITE_ORIGIN ? `${SITE_ORIGIN}${LOCAL.pathname}${LOCAL.search}` : LOCAL.href;
const OUT = path.resolve(opts.out);
const REPORT_DIR = path.resolve(opts['report-dir'] || path.dirname(OUT));
const SECONDS = Number(opts.seconds);
const FAST_FORWARDS = opts['fast-forward'].split(',').map((s) => s.trim()).filter(Boolean);
fs.mkdirSync(path.join(OUT, 'r'), { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

const secrets = opts['secret-env']
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((name) => process.env[name])
  .filter((v) => typeof v === 'string' && v.length >= 8);

const PASSES = {
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  laptop: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
};

// Not stored: the session is synthesized at replay time, and 401/403 would
// push the app into auth recovery (see cm-snapshot.js).
const NEVER_STORE_PATHS = new Set(['/api/wm-session']);
const NEVER_STORE_STATUS = new Set([401, 403]);

const entries = new Map(); // key -> entry
const report = { pageUrl: PAGE_URL, passes: {}, redactions: 0, skipped: {}, consoleErrors: [], pageErrors: [], notFound: [] };

function isOk(status) {
  return status >= 200 && status < 300;
}

function redact(buf) {
  if (!secrets.length) return buf;
  let text = buf.toString('latin1');
  let hit = false;
  for (const s of secrets) {
    for (const v of new Set([s, encodeURIComponent(s)])) {
      if (text.includes(v)) {
        text = text.split(v).join('[redacted]');
        hit = true;
      }
    }
  }
  if (!hit) return buf;
  report.redactions++;
  return Buffer.from(text, 'latin1');
}

function onRecord(e) {
  if (NEVER_STORE_PATHS.has(e.path) || NEVER_STORE_STATUS.has(e.status)) {
    const why = NEVER_STORE_PATHS.has(e.path) ? e.path : `HTTP ${e.status}`;
    report.skipped[why] = (report.skipped[why] || 0) + 1;
    return;
  }
  const prev = entries.get(e.key);
  // Keep the newest successful response; never let an error overwrite data.
  if (prev && isOk(prev.s) && !isOk(e.status)) return;
  const headers = {};
  for (const [k, v] of Object.entries(e.headers || {})) {
    headers[k] = secrets.some((s) => v.includes(s)) ? '[redacted]' : v;
  }
  const body = redact(Buffer.from(e.data, 'base64'));
  fs.writeFileSync(path.join(OUT, 'r', e.file), body);
  entries.set(e.key, {
    f: e.file,
    m: e.method,
    p: e.path,
    q: e.query,
    b: e.bodyHash,
    s: e.status,
    st: e.statusText,
    h: headers,
    n: body.length,
  });
}

// Every bootstrap key the app may request lazily, from upstream's registry.
async function onDemandBootstrapUrls() {
  try {
    const mod = await import(pathToFileURL(path.join(WM_DIR, 'shared', 'bootstrap-tier-keys.js')).href);
    const names = Object.keys(mod.BOOTSTRAP_TIERS || {});
    const urls = [];
    for (const k of names) {
      urls.push(`/api/bootstrap?keys=${encodeURIComponent(k)}&public=1`);
      urls.push(`/api/bootstrap?keys=${encodeURIComponent(k)}`);
    }
    return urls;
  } catch (err) {
    console.warn(`record: bootstrap key registry unavailable (${err.message}); skipping on-demand keys`);
    return [];
  }
}

// Scroll the window and every scrollable container step by step so lazily
// rendered panels mount and fetch their data.
async function sweep(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const scrollables = [document.scrollingElement || document.documentElement];
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight > el.clientHeight + 80) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') scrollables.push(el);
      }
    }
    for (const el of scrollables.slice(0, 60)) {
      const step = Math.max(200, Math.floor((el.clientHeight || innerHeight) * 0.8));
      for (let y = 0; y <= el.scrollHeight; y += step) {
        el.scrollTop = y;
        if (el === document.scrollingElement) window.scrollTo(0, y);
        await sleep(250);
      }
    }
    for (const el of scrollables) el.scrollTop = 0;
    window.scrollTo(0, 0);
  });
}

async function routeSiteOrigin(context) {
  if (!SITE_ORIGIN) return;
  await context.route(`${SITE_ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `${LOCAL.origin}${u.pathname}${u.search}`, maxRedirects: 0 });
      await route.fulfill({ response });
    } catch (err) {
      await route.abort('failed').catch(() => {});
    }
  });
}

async function runPass(browser, name, extraUrls) {
  const ctxOpts = PASSES[name];
  if (!ctxOpts) throw new Error(`unknown pass ${name}`);
  const context = await browser.newContext({
    ...ctxOpts,
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
  });
  await routeSiteOrigin(context);
  await context.addInitScript(() => {
    window.__CM_MODE__ = 'record';
  });
  await context.exposeFunction('__cmRecord', onRecord);
  const page = await context.newPage();
  if (FAST_FORWARDS.length) await page.clock.install();
  const passReport = { recordedBefore: entries.size, apiStatuses: {} };
  page.on('console', (msg) => {
    if (msg.type() === 'error' && report.consoleErrors.length < 300) {
      report.consoleErrors.push(`[${name}] ${msg.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (err) => {
    if (report.pageErrors.length < 100) report.pageErrors.push(`[${name}] ${String(err).slice(0, 300)}`);
  });
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith('/api/')) {
      const k = `${res.status()}`;
      passReport.apiStatuses[k] = (passReport.apiStatuses[k] || 0) + 1;
    } else if (res.status() === 404 && report.notFound.length < 300) {
      report.notFound.push(`[${name}] ${u.origin === SITE_ORIGIN || u.origin === LOCAL.origin ? u.pathname : u.href}`);
    }
  });

  const t0 = Date.now();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('load', { timeout: 120_000 }).catch(() => {});
  // Let first-paint fetches and deferred panels settle, sweeping a few times.
  const deadline = t0 + SECONDS * 1000;
  let sweeps = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.min(15_000, Math.max(0, deadline - Date.now())));
    if (Date.now() < deadline) {
      await sweep(page).catch(() => {});
      sweeps++;
    }
  }

  if (extraUrls.length) {
    // Through window.fetch, i.e. the app's own wrapper chain (session header
    // included) and the shim, so keys match what the app would ask for.
    const done = await page
      .evaluate(async (urls) => {
        let ok = 0;
        for (let i = 0; i < urls.length; i += 6) {
          const batch = urls.slice(i, i + 6).map((u) =>
            fetch(u).then(
              (r) => { if (r.ok) ok++; return r.arrayBuffer(); },
              () => null,
            ),
          );
          await Promise.all(batch);
        }
        return ok;
      }, extraUrls)
      .catch(() => 0);
    passReport.onDemandBootstrap = { requested: extraUrls.length, ok: done };
  }

  for (const step of FAST_FORWARDS) {
    // Refresh loops, retries and deferred loaders fire on timers; jump ahead
    // so the requests a visitor's open tab will make later get captured.
    await page.clock.fastForward(step).catch((err) => console.warn(`record: fastForward ${step}: ${err.message}`));
    await page.waitForTimeout(12_000);
    await sweep(page).catch(() => {});
    await page.waitForTimeout(5_000);
  }

  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.screenshot({ path: path.join(REPORT_DIR, `record-${name}.png`) }).catch(() => {});
  passReport.sweeps = sweeps;
  passReport.fastForwards = FAST_FORWARDS;
  passReport.recordedAfter = entries.size;
  passReport.shim = await page.evaluate(() => window.__cmSnapshot && { ...window.__cmSnapshot, missed: undefined }).catch(() => null);
  report.passes[name] = passReport;
  await context.close();
  console.log(`record: pass ${name}: ${entries.size} unique API responses so far (${sweeps} sweeps, ${FAST_FORWARDS.length} clock jumps)`);
}

const browser = await chromium.launch();
try {
  const extra = await onDemandBootstrapUrls();
  let first = true;
  for (const name of opts.passes.split(',').map((s) => s.trim()).filter(Boolean)) {
    await runPass(browser, name, first ? extra : []);
    first = false;
  }
} finally {
  await browser.close();
}

const manifest = {
  generatedAt: new Date().toISOString(),
  upstreamSha: opts['upstream-sha'] || null,
  passes: opts.passes,
  entries: Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));

const statusHist = {};
let bytes = 0;
for (const e of entries.values()) {
  statusHist[e.s] = (statusHist[e.s] || 0) + 1;
  bytes += e.n;
}
report.summary = { entries: entries.size, statusHist, bytes };
fs.writeFileSync(path.join(REPORT_DIR, 'record-report.json'), JSON.stringify(report, null, 2));
console.log(
  `record: ${entries.size} responses, ${(bytes / 1e6).toFixed(1)} MB, statuses ${JSON.stringify(statusHist)}, ` +
    `skipped ${JSON.stringify(report.skipped)}, redactions ${report.redactions}`,
);
if (entries.size === 0) {
  console.error('record: nothing was recorded; refusing to publish an empty snapshot');
  process.exit(1);
}
