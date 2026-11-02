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
//   * Branding, per upstream's trademark policy for forks
//     (worldmonitor/docs/trademark-policy.mdx): distinct name ("Clone
//     Monitor") in the title, manifest and header (the header text is set by
//     cm-snapshot.js), no Open Graph / Twitter / JSON-LD identity claiming to
//     be World Monitor, and "Based on World Monitor" attribution in the
//     snapshot notice. Copyright and author notices are kept. Upsell, sign-in
//     and locked "Pro" panels are hidden: this copy has no accounts.
//
// After recording, `--stamp` writes the capture time into every page
// (data-captured-at on the shim tag) so the shim can show the snapshot as of
// that moment.
//
// Usage:
//   node snapshot/assemble.mjs --dist worldmonitor/dist --out site \
//     [--base /Clone_Monitor/] [--source https://github.com/<owner>/<repo>]
//   node snapshot/assemble.mjs --stamp --out site

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
    stamp: { type: 'boolean', default: false },
  },
});

function htmlFiles(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) htmlFiles(p, acc);
    else if (ent.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

if (opts.stamp) {
  const OUT_DIR = path.resolve(opts.out || '');
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'snapshot', 'manifest.json'), 'utf8'));
  const at = String(manifest.generatedAt || '');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at)) {
    console.error(`assemble --stamp: bad generatedAt ${JSON.stringify(at)}`);
    process.exit(1);
  }
  let n = 0;
  for (const file of htmlFiles(OUT_DIR)) {
    const html = fs.readFileSync(file, 'utf8');
    const out = html.replace('data-captured-at=""', `data-captured-at="${at}"`);
    if (out !== html) {
      fs.writeFileSync(file, out);
      n++;
    }
  }
  console.log(`assemble: stamped capture time ${at} into ${n} pages`);
  process.exit(0);
}

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
  ' data-captured-at=""></script>';
const robotsTag = '<meta name="robots" content="noindex, nofollow">';
const TITLE = 'Clone Monitor \u00b7 daily snapshot, based on World Monitor';
const brandCss = `<style nonce="wm-static-bootstrap" id="cm-snapshot-style">
      .pro-banner, .pro-banner-slot, .auth-signin-btn, .auth-signup-link, .variant-switcher { display: none !important; }
      html.wm-pro-banner-reserved #app::before { display: none !important; height: 0 !important; }
      .panel.panel-is-locked { display: none !important; }
    </style>`;

// Identity tags that would present this copy as World Monitor itself.
function rebrandHead(html) {
  return html
    .replace(/<title>[^<]*<\/title>/i, `<title>${TITLE}</title>`)
    .replace(/<meta name="title" content="[^"]*"\s*\/?>/i, `<meta name="title" content="${TITLE}" />`)
    .replace(/<meta name="application-name" content="[^"]*"\s*\/?>/i, '<meta name="application-name" content="Clone Monitor" />')
    .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/?>/i, '<meta name="apple-mobile-web-app-title" content="Clone Monitor" />')
    .replace(/[ \t]*<meta (?:property="og:|name="twitter:)[^>]*>\r?\n?/gi, '')
    .replace(/[ \t]*<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>\r?\n?/gi, '')
    .replace(/[ \t]*<link rel="(?:preconnect|dns-prefetch)" href="https:\/\/[^"]*worldmonitor\.app[^"]*"[^>]*>\r?\n?/gi, '');
}

function injectHead(html) {
  if (html.includes('cm-snapshot.js')) return html;
  const m = html.match(/<head[^>]*>/i);
  if (!m) return null;
  const at = m.index + m[0].length;
  // Keep <meta charset> first if it is the first thing in <head>.
  const rest = html.slice(at);
  const charset = rest.match(/^\s*<meta\s+charset=[^>]*>/i);
  const insertAt = charset ? at + charset[0].length : at;
  return rebrandHead(`${html.slice(0, insertAt)}\n    ${shimTag}\n    ${robotsTag}\n    ${brandCss}${html.slice(insertAt)}`);
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

const webManifest = path.join(OUT, 'manifest.webmanifest');
if (fs.existsSync(webManifest)) {
  try {
    const m = JSON.parse(fs.readFileSync(webManifest, 'utf8'));
    m.name = 'Clone Monitor (snapshot of World Monitor)';
    m.short_name = 'Clone Monitor';
    fs.writeFileSync(webManifest, JSON.stringify(m));
  } catch (err) {
    console.warn(`assemble: manifest.webmanifest not rebranded: ${err.message}`);
  }
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
