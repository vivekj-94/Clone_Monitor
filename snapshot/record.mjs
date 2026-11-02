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

// GPU-less runners only have SwiftShader WebGL, which the app rejects by
// renderer name and falls back to its SVG map. Real visitors get the
// DeckGL/MapLibre map, which loads different data, so force it the same way
// upstream's own e2e tests do (worldmonitor/e2e/mcp-news-map.spec.ts).
export const WEBGL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
export function hideSoftwareRenderer() {
  for (const Ctx of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!Ctx) continue;
    const getExtension = Ctx.prototype.getExtension;
    Ctx.prototype.getExtension = function (name) {
      return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(getExtension, this, [name]);
    };
  }
}

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
// 429 is a rate limit of the recording run itself, never worth replaying.
const NEVER_STORE_STATUS = new Set([401, 403, 429]);

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

// Bodies are stored per run (r/<run><id>): a tab still holding yesterday's
// manifest after a deploy gets clean misses, never today's bodies under
// yesterday's status and headers.
const RUN_ID = Date.now().toString(36);

// Two successful answers for the same request (passes, refresh loops): a
// later one may be degraded (a seed key expired meanwhile). Bootstrap
// payloads are merged per data key; other bodies are only replaced by one
// at least half as large.
function mergeBootstrap(prevBuf, nextBuf) {
  try {
    const a = JSON.parse(prevBuf.toString('utf8'));
    const b = JSON.parse(nextBuf.toString('utf8'));
    if (!a || !b || typeof a.data !== 'object' || typeof b.data !== 'object') return nextBuf;
    const data = { ...a.data, ...b.data };
    const missing = [...new Set([...(a.missing || []), ...(b.missing || [])])].filter((k) => !(k in data));
    return Buffer.from(JSON.stringify({ ...b, data, missing }), 'utf8');
  } catch {
    return nextBuf;
  }
}

function onRecord(e) {
  if (NEVER_STORE_PATHS.has(e.path) || NEVER_STORE_STATUS.has(e.status)) {
    const why = NEVER_STORE_PATHS.has(e.path) ? e.path : `HTTP ${e.status}`;
    report.skipped[why] = (report.skipped[why] || 0) + 1;
    return;
  }
  const prev = entries.get(e.key);
  // Never let an error overwrite data.
  if (prev && isOk(prev.s) && !isOk(e.status)) return;
  const headers = {};
  for (const [k, v] of Object.entries(e.headers || {})) {
    headers[k] = secrets.some((s) => v.includes(s)) ? '[redacted]' : v;
  }
  let body = redact(Buffer.from(e.data, 'base64'));
  if (prev && isOk(prev.s) && isOk(e.status)) {
    const prevBody = fs.readFileSync(path.join(OUT, 'r', prev.f));
    if (e.path === '/api/bootstrap') body = mergeBootstrap(prevBody, body);
    else if (body.length < prevBody.length / 2) {
      report.keptLarger = (report.keptLarger || 0) + 1;
      return;
    }
  }
  const file = `${RUN_ID}${e.file}`;
  fs.writeFileSync(path.join(OUT, 'r', file), body);
  entries.set(e.key, {
    f: file,
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

// Every bootstrap key the app may request lazily, from upstream's registry,
// as the public single-key read (?keys=<k>&public=1). Credentialed
// single-key reads (no public=1) fall back to these by fuzzy match at
// replay time; the one multi-key credentialed read is requested as such.
async function onDemandBootstrapUrls() {
  try {
    const mod = await import(pathToFileURL(path.join(WM_DIR, 'shared', 'bootstrap-tier-keys.js')).href);
    const names = new Set(Object.keys(mod.BOOTSTRAP_TIERS || {}));
    if (mod.PUBLIC_WEATHER_BOOTSTRAP_KEY) names.add(mod.PUBLIC_WEATHER_BOOTSTRAP_KEY);
    const urls = [...names].map((k) => `/api/bootstrap?keys=${encodeURIComponent(k)}&public=1`);
    urls.push('/api/bootstrap?keys=bisDsr,bisPropertyResidential,bisPropertyCommercial');
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
  await context.addInitScript(hideSoftwareRenderer);
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
    // Paced: the API allows 120 requests per minute per client, and the
    // page's own refresh traffic shares that budget.
    const done = await page
      .evaluate(async (urls) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let ok = 0;
        let limited = 0;
        for (const u of urls) {
          for (let attempt = 0; attempt < 3; attempt++) {
            let r;
            try {
              r = await fetch(u);
              await r.arrayBuffer();
            } catch {
              break;
            }
            if (r.status === 429) {
              limited++;
              await sleep(Math.min(65, Number(r.headers.get('retry-after')) || 30) * 1000);
              continue;
            }
            if (r.ok) ok++;
            break;
          }
          await sleep(650);
        }
        return { ok, limited };
      }, extraUrls)
      .catch(() => ({ ok: 0, limited: 0 }));
    passReport.onDemandBootstrap = { requested: extraUrls.length, ...done };
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
  passReport.mapMode = await page
    .evaluate(() => ['deckgl-mode', 'globe-mode', 'svg-mode'].find((c) => document.querySelector(`.${c}`)) || 'none')
    .catch(() => 'unknown');
  report.passes[name] = passReport;
  await context.close();
  console.log(`record: pass ${name}: ${entries.size} unique API responses so far (${sweeps} sweeps, ${FAST_FORWARDS.length} clock jumps)`);
}

// Warm the API's caches so the page's first bootstrap fetch fits the app's
// 1.2 s budget (a cold local API can exceed it).
for (const p of [
  '/api/bootstrap?tier=fast&public=1',
  '/api/bootstrap?tier=slow&public=1',
  '/api/news/v1/list-feed-digest?variant=full&lang=en&public=1',
]) {
  await fetch(new URL(p, LOCAL.origin), { signal: AbortSignal.timeout(60_000) }).then((r) => r.arrayBuffer()).catch(() => {});
}

let browser = await chromium.launch({ args: WEBGL_ARGS });
try {
  const extra = await onDemandBootstrapUrls();
  let first = true;
  for (const name of opts.passes.split(',').map((s) => s.trim()).filter(Boolean)) {
    // One retry per pass: headless Chromium occasionally crashes on runners.
    for (let attempt = 1; ; attempt++) {
      try {
        await runPass(browser, name, first ? extra : []);
        break;
      } catch (err) {
        console.warn(`record: pass ${name} attempt ${attempt} failed: ${err.message}`);
        if (attempt >= 2) throw err;
        await browser.close().catch(() => {});
        browser = await chromium.launch({ args: WEBGL_ARGS });
      }
    }
    first = false;
  }
} finally {
  await browser.close().catch(() => {});
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
