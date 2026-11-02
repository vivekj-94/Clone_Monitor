/*!
 * Clone Monitor snapshot shim: record/replay of World Monitor's /api traffic.
 *
 * Loaded as the FIRST classic <script> in <head>, before the app's module
 * code, so it wraps the native fetch and every fetch wrapper the app installs
 * later (session, billing retry, failure attribution...) sits on top of it.
 * It therefore sees each request exactly as it would leave the browser.
 *
 * Modes
 *   replay (default, what GitHub Pages serves): /api/* requests are answered
 *     from recorded responses under <base>snapshot/. Nothing reaches a server.
 *   record (set by the recorder via window.__CM_MODE__ = 'record' in a
 *     Playwright init script): /api/* goes to the same-origin backend proxy
 *     and every response is handed to window.__cmRecord(entry).
 *
 * In both modes:
 *   - API calls aimed at *.worldmonitor.app are rewritten to same origin, so
 *     a snapshot never talks to the hosted World Monitor API.
 *   - Same-origin absolute paths outside the Pages base ("/data/x.json") are
 *     prefixed with the base, because the app assumes it is served from "/".
 *
 * The request key is computed by this one file in both modes, so recording
 * and replay agree by construction. Values that change between runs
 * (timestamps, UUIDs, random tokens) are normalized before keying; misses
 * fall back to the closest recorded request on the same endpoint.
 *
 * Source: https://github.com/vivekj-94/Clone_Monitor (AGPL-3.0-only, as is
 * the World Monitor code it wraps: https://github.com/koala73/worldmonitor).
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var ds = (script && script.dataset) || {};
  var BASE = ds.base || '/';
  if (BASE.charAt(BASE.length - 1) !== '/') BASE += '/';
  var MODE = window.__CM_MODE__ === 'record' ? 'record' : 'replay';
  var SNAPSHOT_DIR = BASE + 'snapshot/';
  // AGPL-3.0 section 13: point visitors at the source of THIS modified copy.
  var SOURCE_URL = /^https:\/\//.test(ds.source || '') ? ds.source : 'https://github.com/koala73/worldmonitor';
  var ORIGIN = location.origin;
  var nativeFetch = window.fetch.bind(window);
  var RealDate = Date;
  var NOW = RealDate.now();

  // Show the dashboard as of the capture time. The app judges freshness
  // against the clock (sources older than 6 h read "No data", vessels older
  // than 1 h are dropped, ...), so with the real clock a day-old snapshot
  // would hide data it actually has. Date.now() and new Date() are moved
  // back to the capture instant; time still advances from there. The notice
  // shows the real age. Dates built from explicit values are untouched.
  var CAPTURED_MS = RealDate.parse(ds.capturedAt || '');
  if (MODE === 'replay' && isFinite(CAPTURED_MS) && typeof Reflect !== 'undefined') {
    (function (offset) {
      var ShiftedDate = function Date() {
        if (!new.target) return new RealDate(RealDate.now() + offset).toString();
        var args = arguments.length ? Array.prototype.slice.call(arguments) : [RealDate.now() + offset];
        return Reflect.construct(RealDate, args, new.target);
      };
      Object.setPrototypeOf(ShiftedDate, RealDate);
      ShiftedDate.prototype = RealDate.prototype;
      ShiftedDate.now = function now() { return RealDate.now() + offset; };
      ShiftedDate.parse = RealDate.parse;
      ShiftedDate.UTC = RealDate.UTC;
      window.Date = ShiftedDate;
    })(CAPTURED_MS - NOW);
  }

  var stats = { mode: MODE, hits: 0, fuzzy: 0, misses: 0, recorded: 0, rewritten: 0, missed: [], clockShifted: window.Date !== RealDate };
  window.__cmSnapshot = stats;

  // ---------------------------------------------------------------- helpers

  function cyrb53(str, seed) {
    var h1 = 0xdeadbeef ^ seed;
    var h2 = 0x41c6ce57 ^ seed;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function fileIdFor(key) {
    return cyrb53(key, 0).toString(36) + cyrb53(key, 7).toString(36);
  }

  var RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var RE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
  var RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
  var RE_INT = /^\d{10,13}$/;
  var RE_TOKEN = /^(wms_)?[A-Za-z0-9_-]{24,}(\.[A-Za-z0-9_-]+){0,2}$/;
  var DAY = 86400000;

  // Map run-specific values to placeholders so the same logical request
  // keys identically today and tomorrow.
  function normValue(v) {
    if (typeof v !== 'string') v = String(v);
    if (RE_INT.test(v)) {
      var n = Number(v);
      var ms = v.length <= 10 ? n * 1000 : n;
      if (ms > NOW - 400 * DAY && ms < NOW + 30 * DAY) return '<t>';
      return v;
    }
    if (RE_ISO.test(v)) return '<t>';
    if (RE_DATE.test(v)) {
      var d = Date.parse(v);
      if (!isNaN(d) && d > NOW - 400 * DAY && d < NOW + 30 * DAY) return '<d>';
      return v;
    }
    if (RE_UUID.test(v)) return '<id>';
    if (v.length >= 24 && RE_TOKEN.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) return '<tok>';
    return v;
  }

  // Query params that are pure cache busters: dropped entirely.
  var DROP_PARAMS = { _: 1, _t: 1, t: 1, ts: 1, cb: 1, cachebust: 1, cachebuster: 1, nocache: 1, rand: 1, nonce: 1, v: 0 };

  function normQuery(searchParams) {
    var pairs = [];
    searchParams.forEach(function (value, name) {
      if (DROP_PARAMS[name.toLowerCase()] === 1) return;
      pairs.push(name + '=' + normValue(value));
    });
    pairs.sort();
    return pairs.join('&');
  }

  function normJson(value) {
    if (Array.isArray(value)) return value.map(normJson);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value)
        .sort()
        .forEach(function (k) {
          out[k] = normJson(value[k]);
        });
      return out;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      var nv = normValue(value);
      return nv === String(value) ? value : nv;
    }
    return value;
  }

  function normBody(text) {
    if (!text) return '';
    try {
      return JSON.stringify(normJson(JSON.parse(text)));
    } catch (e) {
      return text;
    }
  }

  function isWorldMonitorHost(hostname) {
    return hostname === 'worldmonitor.app' || /\.worldmonitor\.app$/.test(hostname);
  }

  // Returns {url: URL, api: boolean, path: string} for a request URL.
  function inspectUrl(raw) {
    var u;
    try {
      u = new URL(raw, location.href);
    } catch (e) {
      return null;
    }
    if (u.origin === ORIGIN) {
      if (u.pathname.indexOf(BASE + 'api/') === 0) {
        return { url: u, api: true, path: u.pathname.slice(BASE.length - 1) };
      }
      if (u.pathname.indexOf('/api/') === 0) {
        return { url: u, api: true, path: u.pathname };
      }
      return { url: u, api: false, path: u.pathname };
    }
    if (isWorldMonitorHost(u.hostname) && u.pathname.indexOf('/api/') === 0) {
      return { url: u, api: true, path: u.pathname, foreign: true };
    }
    return { url: u, api: false, path: null, external: true };
  }

  // "/data/x.json" -> "/Clone_Monitor/data/x.json" for same-origin paths the
  // app wrote assuming it lives at "/".
  function rebaseSameOrigin(info) {
    if (!info || info.api || info.external || BASE === '/') return null;
    if (info.url.pathname.indexOf(BASE) === 0) return null;
    stats.rewritten++;
    return ORIGIN + BASE + info.url.pathname.slice(1) + info.url.search + info.url.hash;
  }

  function bodyToText(body) {
    if (body == null) return Promise.resolve('');
    if (typeof body === 'string') return Promise.resolve(body);
    if (body instanceof URLSearchParams) return Promise.resolve(body.toString());
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text();
    if (body instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(body));
    if (ArrayBuffer.isView(body)) return Promise.resolve(new TextDecoder().decode(body));
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      var parts = [];
      body.forEach(function (v, k) {
        parts.push(k + '=' + (typeof v === 'string' ? v : '<file>'));
      });
      return Promise.resolve(parts.sort().join('&'));
    }
    return Promise.resolve('');
  }

  // Normalize a fetch() call into the pieces the key is built from.
  function describe(input, init) {
    var isReq = typeof Request !== 'undefined' && input instanceof Request;
    var rawUrl = isReq ? input.url : input instanceof URL ? input.href : String(input);
    var method = ((init && init.method) || (isReq ? input.method : 'GET') || 'GET').toUpperCase();
    var info = inspectUrl(rawUrl);
    if (!info || !info.api) return Promise.resolve({ info: info, method: method });
    var bodyPromise;
    if (init && init.body != null) bodyPromise = bodyToText(init.body);
    else if (isReq && method !== 'GET' && method !== 'HEAD') bodyPromise = input.clone().text();
    else bodyPromise = Promise.resolve('');
    return bodyPromise.then(
      function (text) {
        var q = normQuery(info.url.searchParams);
        var b = normBody(text);
        return {
          info: info,
          method: method,
          path: info.path,
          query: q,
          body: b,
          key: method + ' ' + info.path + '?' + q + (b ? ' #' + cyrb53(b, 3).toString(36) : ''),
        };
      },
      function () {
        var q = normQuery(info.url.searchParams);
        return { info: info, method: method, path: info.path, query: q, body: '', key: method + ' ' + info.path + '?' + q };
      },
    );
  }

  // --------------------------------------------------------------- replay

  var manifestPromise = null;
  function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = nativeFetch(SNAPSHOT_DIR + 'manifest.json', { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('manifest HTTP ' + r.status);
          return r.json();
        })
        .then(function (m) {
          var byPath = {};
          Object.keys(m.entries).forEach(function (key) {
            var e = m.entries[key];
            var pk = e.m + ' ' + e.p;
            (byPath[pk] = byPath[pk] || []).push(e);
          });
          m.byPath = byPath;
          window.__cmManifest = m;
          prefetchBootstrap(m);
          return m;
        })
        .catch(function (err) {
          console.warn('[snapshot] manifest unavailable:', err);
          return { entries: {}, byPath: {}, generatedAt: null };
        });
    }
    return manifestPromise;
  }

  function pairsOf(q) {
    return q ? q.split('&') : [];
  }

  // Closest recorded request on the same METHOD + path: most shared query
  // pairs, then same body, then fewest extra pairs.
  function fuzzyMatch(m, d) {
    var cands = m.byPath[d.method + ' ' + d.path];
    if (!cands || !cands.length) return null;
    var want = pairsOf(d.query);
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (NEVER_REPLAY_STATUS[c.s]) continue;
      var have = pairsOf(c.q);
      var shared = 0;
      for (var j = 0; j < want.length; j++) if (have.indexOf(want[j]) !== -1) shared++;
      var score = shared * 10 - (have.length - shared) - (want.length - shared) + (c.b === (d.body ? cyrb53(d.body, 3).toString(36) : '') ? 5 : 0) + (c.s >= 200 && c.s < 300 ? 3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  // Bodies are fetched once and kept in memory. The bootstrap tiers are
  // prefetched as soon as the manifest arrives: the app aborts the fast tier
  // after 1.2 s and the slow one after 3 s.
  var bodyCache = {};
  function getBody(m, file) {
    if (!bodyCache[file]) {
      var v = m.generatedAt ? '?v=' + encodeURIComponent(m.generatedAt) : '';
      bodyCache[file] = nativeFetch(SNAPSHOT_DIR + 'r/' + file + v).then(function (r) {
        if (!r.ok) throw new Error('snapshot body HTTP ' + r.status);
        return r.arrayBuffer();
      });
      bodyCache[file].catch(function () {
        delete bodyCache[file];
      });
    }
    return bodyCache[file];
  }

  function prefetchBootstrap(m) {
    Object.keys(m.entries).forEach(function (key) {
      var e = m.entries[key];
      if (e.p === '/api/bootstrap' && /(^|&)tier=(fast|slow)(&|$)/.test(e.q) && e.s >= 200 && e.s < 300) {
        getBody(m, e.f).catch(function () {});
      }
    });
  }

  var NULL_BODY = { 101: 1, 204: 1, 205: 1, 304: 1 };
  // Replaying these would start the app's auth recovery (and can end in a
  // 15-minute "session blackout"), or its billing-verification retry.
  // (429 is only a rate limit of the recording run.)
  var NEVER_REPLAY_STATUS = { 401: 1, 403: 1, 429: 1 };

  function buildResponse(entry, body, url) {
    var headers = new Headers(entry.h || {});
    headers.delete('x-billing-verification');
    var resp = new Response(NULL_BODY[entry.s] ? null : body, {
      status: entry.s,
      statusText: entry.st || '',
      headers: headers,
    });
    try {
      Object.defineProperty(resp, 'url', { value: url });
    } catch (e) {}
    return resp;
  }

  // A plain 404: generated clients treat it as "no data" and back off.
  function missResponse(d) {
    stats.misses++;
    if (stats.missed.length < 200) stats.missed.push(d.key);
    return new Response(JSON.stringify({ error: 'not_in_snapshot', message: 'This request was not captured in the daily snapshot.' }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'x-cm-snapshot': 'miss' },
    });
  }

  // The anonymous session is synthesized rather than replayed: a recorded
  // one expires ~12 h after capture, which would make the app re-mint before
  // nearly every call. The client only checks ok, a numeric exp and the
  // 'wms_' prefix; nothing server-side exists to validate it.
  function sessionResponse(d) {
    stats.hits++;
    return new Response(
      JSON.stringify({ ok: true, exp: Date.now() + 12 * 3600 * 1000, hadSession: true, token: 'wms_snapshot' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  function abortError() {
    try {
      return new DOMException('The operation was aborted.', 'AbortError');
    } catch (e) {
      var err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      return err;
    }
  }

  function withAbort(signal, promise) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise(function (resolve, reject) {
      var onAbort = function () { reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        function (v) { signal.removeEventListener('abort', onAbort); resolve(v); },
        function (e) { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  function replay(d) {
    if (d.path === '/api/wm-session') return Promise.resolve(sessionResponse(d));
    return loadManifest().then(function (m) {
      var entry = m.entries[d.key];
      if (entry && NEVER_REPLAY_STATUS[entry.s]) entry = null;
      if (entry) stats.hits++;
      else {
        entry = fuzzyMatch(m, d);
        if (!entry || NEVER_REPLAY_STATUS[entry.s]) return missResponse(d);
        stats.fuzzy++;
      }
      return getBody(m, entry.f).then(
        function (buf) { return buildResponse(entry, buf, d.info.url.href); },
        function () { return missResponse(d); },
      );
    });
  }

  // --------------------------------------------------------------- record

  var SKIP_RESP_HEADERS = {
    'content-length': 1, 'content-encoding': 1, 'transfer-encoding': 1, connection: 1,
    'keep-alive': 1, date: 1, 'set-cookie': 1, vary: 1, 'access-control-allow-origin': 1,
    'access-control-allow-credentials': 1, 'access-control-expose-headers': 1,
    'access-control-allow-headers': 1, 'access-control-allow-methods': 1,
  };

  function abToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var chunk = 0x8000;
    var bin = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function record(d, input, init) {
    var target = input;
    if (d.info.foreign) {
      // Never let a recording reach the hosted API; send it to our backend.
      target = ORIGIN + d.path + d.info.url.search;
      if (typeof Request !== 'undefined' && input instanceof Request) target = new Request(target, input);
    }
    // The app aborts bootstrap tiers after 1.2 s / 3 s. Let the recording
    // finish anyway: the response is what the published snapshot needs.
    if (d.path === '/api/bootstrap') {
      if (typeof Request !== 'undefined' && target instanceof Request) target = new Request(target, { signal: null });
      if (init && init.signal) {
        init = Object.assign({}, init);
        delete init.signal;
      }
    }
    return nativeFetch(target, init).then(function (res) {
      var copy = res.clone();
      copy.arrayBuffer().then(
        function (buf) {
          var h = {};
          copy.headers.forEach(function (v, k) {
            if (!SKIP_RESP_HEADERS[k]) h[k] = v;
          });
          stats.recorded++;
          if (typeof window.__cmRecord === 'function') {
            window.__cmRecord({
              key: d.key, method: d.method, path: d.path, query: d.query,
              bodyHash: d.body ? cyrb53(d.body, 3).toString(36) : '',
              status: res.status, statusText: res.statusText, headers: h,
              file: fileIdFor(d.key), data: abToBase64(buf), at: Date.now(),
            });
          }
        },
        function () {},
      );
      return res;
    });
  }

  // ---------------------------------------------------------------- fetch

  window.fetch = function (input, init) {
    return describe(input, init).then(function (d) {
      if (!d.info) return nativeFetch(input, init);
      if (!d.info.api) {
        var rebased = rebaseSameOrigin(d.info);
        if (rebased) {
          if (typeof Request !== 'undefined' && input instanceof Request) return nativeFetch(new Request(rebased, input), init);
          return nativeFetch(rebased, init);
        }
        return nativeFetch(input, init);
      }
      if (MODE === 'record') return record(d, input, init);
      var signal = (init && init.signal) || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
      // Bootstrap hydration is guarded only by an abort timer (1.2 s fast
      // tier); on a slow connection let it complete instead of losing the
      // panels' first data. An already-aborted call still rejects.
      if (d.path === '/api/bootstrap') {
        if (signal && signal.aborted) return Promise.reject(abortError());
        return replay(d);
      }
      return withAbort(signal, replay(d));
    });
  };

  // Telemetry loaders: a copy must not report its visitors to upstream's
  // analytics (Umami at abacus.worldmonitor.app is fetched on every host and
  // only self-disables after download), DebugBear, or Vercel insights, which
  // does not exist on GitHub Pages. Drop the <script> and fire 'error' so the
  // app's loaders give up the way they do behind an ad blocker.
  var BLOCKED_SCRIPT = /^https:\/\/(abacus\.worldmonitor\.app|cdn\.debugbear\.com)\/|\/_vercel\//;
  function blockedScript(node) {
    if (!node || node.nodeName !== 'SCRIPT') return false;
    var src = node.src || (node.getAttribute && node.getAttribute('src')) || '';
    if (!src || !BLOCKED_SCRIPT.test(src)) return false;
    stats.blockedScripts = (stats.blockedScripts || 0) + 1;
    setTimeout(function () {
      try { node.dispatchEvent(new Event('error')); } catch (e) {}
    }, 0);
    return true;
  }
  var nodeAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function (node) {
    return blockedScript(node) ? node : nodeAppend.call(this, node);
  };
  var nodeInsert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (node, ref) {
    return blockedScript(node) ? node : nodeInsert.call(this, node, ref);
  };
  ['append', 'prepend'].forEach(function (name) {
    var orig = Element.prototype[name];
    if (!orig) return;
    Element.prototype[name] = function () {
      var kept = Array.prototype.filter.call(arguments, function (n) { return !blockedScript(n); });
      return orig.apply(this, kept);
    };
  });

  // sendBeacon to /api (analytics) has no response to replay: drop it.
  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      var info = inspectUrl(url);
      if (info && info.api) return true;
      return nativeBeacon(url, data);
    };
  }

  // XMLHttpRequest: rebase same-origin paths; /api goes through fetch above.
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var info = inspectUrl(url);
    var args = Array.prototype.slice.call(arguments);
    if (info && !info.api) {
      var rebased = rebaseSameOrigin(info);
      if (rebased) args[1] = rebased;
    } else if (info && info.api && MODE === 'replay') {
      stats.misses++;
      if (stats.missed.length < 200) stats.missed.push('XHR ' + method + ' ' + info.path);
    }
    return xhrOpen.apply(this, args);
  };

  // --------------------------------------------------------- page chrome

  if (MODE === 'replay') {
    loadManifest();

    // The app's service worker would pin visitors to an old snapshot.
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = function () {
          return Promise.reject(new Error('Service workers are disabled in the snapshot'));
        };
      }
    } catch (e) {}

    // Distinct branding for this copy (upstream's trademark policy for
    // forks); copyright, author credit and the link to the original stay.
    var REF_ORIGIN = 'https://www.worldmonitor.app';
    var setText = function (sel, text) {
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) if (els[i].textContent !== text) els[i].textContent = text;
    };
    var brand = function () {
      setText('.logo', 'CLONE MONITOR');
      setText('.logo-mobile', 'Clone Monitor');
      setText('.site-footer-name', 'CLONE MONITOR');
      var st = document.querySelectorAll('.status-indicator');
      for (var i = 0; i < st.length; i++) {
        var walker = document.createTreeWalker(st[i], NodeFilter.SHOW_TEXT);
        for (var n = walker.nextNode(); n; n = walker.nextNode()) {
          if (/^\s*LIVE\s*$/i.test(n.nodeValue)) n.nodeValue = 'SNAPSHOT';
        }
      }
      // Footer reference pages live on the original site, not under this one.
      var links = document.querySelectorAll('.site-footer a[href^="/"]');
      for (var j = 0; j < links.length; j++) {
        var href = links[j].getAttribute('href');
        if (href.indexOf(BASE) !== 0) links[j].setAttribute('href', REF_ORIGIN + href);
      }
      // The app retitles the page at runtime ("World Monitor \u2014 ...",
      // "<country> \u2014 World Monitor").
      if (/World Monitor/.test(document.title) && !/based on World Monitor/.test(document.title)) {
        document.title = document.title.replace(/World Monitor/g, 'Clone Monitor');
      }
    };
    var brandQueued = false;
    var queueBrand = function () {
      if (brandQueued) return;
      brandQueued = true;
      setTimeout(function () { brandQueued = false; brand(); }, 250);
    };
    var startBranding = function () {
      brand();
      new MutationObserver(queueBrand).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startBranding);
    else startBranding();

    // Pick up the next daily snapshot in tabs left open.
    setInterval(function () {
      nativeFetch(SNAPSHOT_DIR + 'manifest.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) {
          var cur = window.__cmManifest;
          if (m && cur && m.generatedAt && m.generatedAt !== cur.generatedAt) location.reload();
        })
        .catch(function () {});
    }, 30 * 60 * 1000);

    var showBanner = function () {
      if (document.getElementById('cm-snapshot-banner')) return;
      loadManifest().then(function (m) {
        var when = m.generatedAt ? new Date(m.generatedAt) : null;
        var bar = document.createElement('div');
        bar.id = 'cm-snapshot-banner';
        bar.setAttribute('role', 'note');
        bar.style.cssText = [
          'position:fixed', 'left:8px', 'bottom:8px', 'z-index:2147483646',
          'max-width:calc(100vw - 16px)', 'box-sizing:border-box',
          'font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
          'color:#e8eaed', 'background:rgba(20,22,26,.92)', 'border:1px solid rgba(255,255,255,.18)',
          'border-radius:6px', 'padding:6px 30px 6px 10px', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
          'pointer-events:auto',
        ].join(';');
        var age = when ? Math.max(0, Math.round((RealDate.now() - when.getTime()) / 3600000)) : null;
        // The daily refresh failed if the data is this old: say so.
        if (age !== null && age >= 36) {
          bar.style.background = 'rgba(120,20,20,.95)';
          bar.style.borderColor = 'rgba(255,120,120,.6)';
        }
        var link = 'color:#8ab4f8;text-decoration:underline';
        bar.innerHTML =
          '<strong>Clone Monitor</strong>: unofficial daily snapshot' +
          (when ? ', captured ' + when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' + (age !== null ? ' (' + age + 'h ago)' : '') : '') +
          '. Not live. Based on <a style="' + link + '" href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener">World Monitor</a>' +
          ' &copy; Elie Habib (AGPL-3.0) &middot; <a style="' + link + '" href="https://www.worldmonitor.app/" target="_blank" rel="noopener">live original</a>' +
          ' &middot; <a style="' + link + '" href="' + SOURCE_URL + '" target="_blank" rel="noopener">source of this copy</a>';
        var close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Hide snapshot notice');
        close.textContent = '×';
        close.style.cssText = 'position:absolute;right:4px;top:2px;background:none;border:0;color:#e8eaed;font-size:16px;line-height:1;cursor:pointer;padding:4px';
        close.onclick = function () { bar.remove(); };
        bar.appendChild(close);
        document.body.appendChild(bar);
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner);
    else showBanner();
  }
})();
