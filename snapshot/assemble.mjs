#!/usr/bin/env node
// Turns World Monitor's Vite output (built with --base <base>) into the
// static GitHub Pages site:
//
//   * dashboard.html becomes index.html (upstream's index.html is the
//     marketing landing page; the self-hosted image also serves the
//     dashboard at "/", see worldmonitor/docker/nginx.conf).
//   * cm-snapshot.js is injected as the first <script> of every HTML page
//     so it wraps fetch before any app code runs.
//   * <meta name="robots" content="noindex"> on every page: this is a copy,
//     it should not compete with worldmonitor.app in search results.
//   * The PWA service worker is replaced by a no-op that unregisters itself:
//     a precaching SW would pin visitors to yesterday's snapshot.
//   * Brotli twins (*.br) are dropped (GitHub Pages compresses on its own).
//   * .nojekyll, and a 404.html that sends deep links back to the dashboard.
//
// Usage:
//   node snapshot/assemble.mjs --dist worldmonitor/dist --out site \
//     [--base /Clone_Monitor/] [--source https://github.com/<owner>/<repo>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({
  options: {
    dist: { type: 'string' },
    out: { type: 'string' },
    base: { type: 'string', default: '/Clone_Monitor/' },
    source: { type: 'string', default: '' },
    entry: { type: 'string', default: 'dashboard.html' },
  },
});
if (!opts.dist || !opts.out) {
  console.error('assemble.mjs: --dist and --out are required');
  process.exit(2);
}
const DIST = path.resolve(opts.dist);
const OUT = path.resolve(opts.out);
const BASE = opts.base.endsWith('/') ? opts.base : `${opts.base}/`;

if (!fs.existsSync(path.join(DIST, opts.entry))) {
  console.error(`assemble.mjs: ${opts.entry} not found in ${DIST}`);
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(DIST, OUT, {
  recursive: true,
  filter: (src) => !src.endsWith('.br') && !src.endsWith('.gz'),
});

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
// nonce: upstream's header CSP (nginx/Vercel) allows scripts carrying its
// static nonce; Pages sends no CSP, but this keeps the HTML valid under both.
const shimTag =
  `<script src="${BASE}cm-snapshot.js" nonce="wm-static-bootstrap" data-base="${escapeAttr(BASE)}"` +
  (opts.source ? ` data-source="${escapeAttr(opts.source)}"` : '') +
  '></script>';
const robotsTag = '<meta name="robots" content="noindex, nofollow">';

function injectHead(html) {
  if (html.includes('cm-snapshot.js')) return html;
  const m = html.match(/<head[^>]*>/i);
  if (!m) return null;
  const at = m.index + m[0].length;
  // Keep <meta charset> first if it is the first thing in <head>.
  const rest = html.slice(at);
  const charset = rest.match(/^\s*<meta\s+charset=[^>]*>/i);
  const insertAt = charset ? at + charset[0].length : at;
  return `${html.slice(0, insertAt)}\n    ${shimTag}\n    ${robotsTag}${html.slice(insertAt)}`;
}

let injected = 0;
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.html')) {
      const html = fs.readFileSync(p, 'utf8');
      // Only pages that boot app code need the shim.
      if (!/<script\b[^>]*type="module"/i.test(html)) continue;
      const out = injectHead(html);
      if (out) {
        fs.writeFileSync(p, out);
        injected++;
      }
    }
  }
}
walk(OUT);

// Root-absolute literals in the bundles that name a file of this site
// ("/data/countries.geojson", "/textures/earth-topo-bathy.jpg", ...). Vite's
// base option does not touch string literals, and some of these are loaded
// through <img>/<iframe>, which the fetch shim cannot see. Only literals that
// resolve to an existing file are rewritten; /sw.js stays put so the app's
// service worker registration fails harmlessly outside the site.
const LITERAL_EXCLUDE = new Set(['/sw.js']);
const literalRe = /(["'`])(\/[A-Za-z0-9][A-Za-z0-9._~\/-]*)(?=[?#"'`])/g;
const rewritten = {};
function isSiteFile(p) {
  try {
    return fs.statSync(path.join(OUT, p)).isFile();
  } catch {
    return false;
  }
}
if (BASE !== '/') {
  const assetsDir = path.join(OUT, 'assets');
  for (const name of fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []) {
    if (!/\.(m?js|css)$/.test(name)) continue;
    const file = path.join(assetsDir, name);
    const src = fs.readFileSync(file, 'utf8');
    const out = src.replace(literalRe, (m, q, p) => {
      if (p.startsWith('/api/') || p.startsWith(BASE) || LITERAL_EXCLUDE.has(p) || !isSiteFile(p)) return m;
      rewritten[p] = (rewritten[p] || 0) + 1;
      return q + BASE + p.slice(1);
    });
    if (out !== src) fs.writeFileSync(file, out);
  }
}
const nRewritten = Object.values(rewritten).reduce((a, b) => a + b, 0);
console.log(`assemble: rebased ${nRewritten} root-absolute literals: ${Object.keys(rewritten).sort().join(', ') || 'none'}`);

// The dashboard is the site's front page.
const upstreamIndex = path.join(OUT, 'index.html');
if (fs.existsSync(upstreamIndex) && opts.entry !== 'index.html') {
  fs.renameSync(upstreamIndex, path.join(OUT, 'landing.html'));
}
fs.copyFileSync(path.join(OUT, opts.entry), path.join(OUT, 'index.html'));

fs.copyFileSync(path.join(here, 'cm-snapshot.js'), path.join(OUT, 'cm-snapshot.js'));

// No-op service worker that removes itself (and any older precache).
const killSw = `// Clone Monitor: the app's precaching service worker is disabled for the
// daily snapshot, so visitors always get the newest one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
  })());
});
`;
for (const name of ['sw.js', 'service-worker.js', 'registerSW.js']) {
  const p = path.join(OUT, name);
  if (fs.existsSync(p)) fs.writeFileSync(p, name === 'registerSW.js' ? '/* disabled */\n' : killSw);
}

fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(
  path.join(OUT, '404.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Not found</title><meta http-equiv="refresh" content="0; url=${BASE}">
<style>body{font:15px system-ui,sans-serif;background:#111;color:#ddd;padding:2rem}a{color:#8ab4f8}</style></head>
<body><p>This page is not part of the snapshot. <a href="${BASE}">Open the dashboard</a>.</p></body></html>
`,
);

console.log(`assemble: ${OUT} (shim injected into ${injected} pages, front page = ${opts.entry})`);
