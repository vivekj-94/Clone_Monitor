#!/usr/bin/env node
// Local stand-in for GitHub Pages (project site) used while recording and
// testing the snapshot.
//
//   * Files are served ONLY under --base (default /Clone_Monitor/), exactly
//     like https://<user>.github.io/<repo>/. Every other path is a 404, so an
//     absolute-path asset the app forgot to prefix fails here the same way it
//     would fail on Pages.
//   * GitHub Pages semantics: "/dir/" -> dir/index.html, "/name" -> name.html
//     when name has no file of its own, "/dir" -> 301 "/dir/", and a miss
//     serves <base>404.html with status 404.
//   * --api <origin> (record mode only) forwards "/api/*" (root-absolute, as
//     the dashboard calls it) to the live backend, adding any --api-header
//     "Name: value" pairs the backend expects from its reverse proxy.
//
// Usage:
//   node snapshot/serve.mjs --root site --port 8080 [--api http://127.0.0.1:46123]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    root: { type: 'string' },
    base: { type: 'string', default: '/Clone_Monitor/' },
    port: { type: 'string', default: '8080' },
    host: { type: 'string', default: '127.0.0.1' },
    api: { type: 'string' },
    'api-header': { type: 'string', multiple: true, default: [] },
    quiet: { type: 'boolean', default: false },
  },
});

if (!opts.root) {
  console.error('serve.mjs: --root <dir> is required');
  process.exit(2);
}
const ROOT = path.resolve(opts.root);
const BASE = opts.base.endsWith('/') ? opts.base : `${opts.base}/`;
const API = opts.api ? new URL(opts.api) : null;
const API_HEADERS = Object.fromEntries(
  opts['api-header'].map((h) => {
    const i = h.indexOf(':');
    return [h.slice(0, i).trim().toLowerCase(), h.slice(i + 1).trim()];
  }),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pbf': 'application/x-protobuf',
  '.pmtiles': 'application/octet-stream',
  '.geojson': 'application/geo+json',
  '.csv': 'text/csv; charset=utf-8',
  '.bin': 'application/octet-stream',
};

function log(...args) {
  if (!opts.quiet) console.log(...args);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sendFile(res, file, status = 200, method = 'GET') {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const stat = fs.statSync(file);
  res.writeHead(status, {
    'content-type': type,
    'content-length': stat.size,
    // GitHub Pages sends max-age=600; mimic it so caching bugs show up locally.
    'cache-control': 'max-age=600',
  });
  if (method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function notFound(res, method) {
  const custom = path.join(ROOT, '404.html');
  if (isFile(custom)) return sendFile(res, custom, 404, method);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found (outside the Pages site or missing)\n');
}

function proxyApi(req, res) {
  const target = new URL(req.url, API);
  const headers = { ...req.headers, ...API_HEADERS };
  headers.host = target.host;
  headers['x-real-ip'] = '127.0.0.1';
  headers['x-forwarded-for'] = '127.0.0.1';
  headers['x-forwarded-proto'] = 'http';
  const upstream = http.request(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy_error', message: String(err) }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  if (API && pathname.startsWith('/api/')) {
    log(`[api] ${req.method} ${url.pathname}${url.search}`);
    return proxyApi(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  if (pathname === BASE.slice(0, -1)) {
    res.writeHead(301, { location: BASE + url.search });
    return res.end();
  }
  if (!pathname.startsWith(BASE)) {
    log(`[404 outside base] ${pathname}`);
    return notFound(res, req.method);
  }

  const rel = pathname.slice(BASE.length);
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT)) return notFound(res, req.method);

  if (rel === '' || rel.endsWith('/')) {
    const index = path.join(abs, 'index.html');
    if (isFile(index)) return sendFile(res, index, 200, req.method);
    return notFound(res, req.method);
  }
  if (isFile(abs)) return sendFile(res, abs, 200, req.method);
  if (isDir(abs)) {
    res.writeHead(301, { location: `${pathname}/${url.search}` });
    return res.end();
  }
  if (isFile(`${abs}.html`)) return sendFile(res, `${abs}.html`, 200, req.method);
  log(`[404] ${pathname}`);
  return notFound(res, req.method);
});

server.listen(Number(opts.port), opts.host, () => {
  console.log(
    `serve.mjs: http://${opts.host}:${opts.port}${BASE} -> ${ROOT}` +
      (API ? ` (api -> ${API.origin})` : ' (static only)'),
  );
});
