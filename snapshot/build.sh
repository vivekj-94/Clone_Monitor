#!/usr/bin/env bash
# Builds one daily snapshot of the World Monitor dashboard as a static site.
#
#   1. npm ci + vite build of worldmonitor/ (full variant, Pages base path)
#   2. starts the self-hosted backend without Docker: redis-server, the
#      Upstash-compatible redis-rest proxy, and the Node API server in
#      LOCAL_API_MODE=docker (the same pieces as worldmonitor/docker/)
#   3. runs the seeders in parallel to fill Redis from public sources
#   4. assembles the site, opens it in headless Chromium against the live
#      backend and records every /api response (snapshot/record.mjs)
#   5. serves the result as pure static files and verifies the replay
#      (snapshot/verify.mjs); a failed check fails the build
#
# Output: $OUT_SITE (ready for GitHub Pages) and $WORK/reports.
#
# Env (all optional):
#   WM_DIR        worldmonitor checkout                (default: <repo>/worldmonitor)
#   WORK          scratch dir                          (default: <repo>/.snapshot-work)
#   OUT_SITE      final site dir                       (default: $WORK/site)
#   SITE_BASE     Pages path prefix                    (default: /Clone_Monitor/)
#   SOURCE_URL    repo URL shown in the page notice    (AGPL-3.0 source offer)
#   SITE_ORIGIN   public origin, e.g. https://<user>.github.io: record and
#                 verify in a browser that believes it is on that host
#   SKIP_INSTALL=1, SKIP_BUILD=1, SKIP_SEED=1         reuse earlier steps when iterating
#   RECORD_SECONDS, RECORD_PASSES, SEED_PARALLEL, SEED_TIMEOUT, MIN_HIT_RATE
#   Data-source API keys (FRED_API_KEY, EIA_API_KEY, ...) are passed through
#   to the seeders and the API server when set; see README.md.

# The whole script is one { ... } block so bash parses it completely before
# running: editing this file while a build runs cannot corrupt that build.
{
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$REPO_ROOT/snapshot"
WM_DIR="$(cd "${WM_DIR:-$REPO_ROOT/worldmonitor}" && pwd)"
WORK="${WORK:-$REPO_ROOT/.snapshot-work}"
OUT_SITE="${OUT_SITE:-$WORK/site}"
SITE_BASE="${SITE_BASE:-/Clone_Monitor/}"
SOURCE_URL="${SOURCE_URL:-}"
SITE_ORIGIN="${SITE_ORIGIN:-}"
REPORTS="$WORK/reports"
RT="$WORK/runtime"
LOGS="$WORK/logs"

REDIS_PORT="${REDIS_PORT:-6380}"
REDIS_REST_PORT="${REDIS_REST_PORT:-8079}"
API_PORT="${API_PORT:-46123}"
API_PROXY_PORT="${API_PROXY_PORT:-8089}"
RECORD_PORT="${RECORD_PORT:-8090}"
VERIFY_PORT="${VERIFY_PORT:-8091}"

mkdir -p "$WORK" "$REPORTS" "$RT" "$LOGS"

log() { printf '\n=== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Replace secret VALUES in files under the given dirs ("scrub") or report
# whether any are present ("scan", exit 1 when found). Artifacts uploaded
# from CI are not masked the way job logs are, and a seeder may log a
# request URL that carries its key.
secret_files() { # mode dir...
  CM_MODE="$1" node -e '
    const fs = require("fs"), path = require("path");
    const vals = (process.env.CM_SECRET_ENV_NAMES || "").split(/\s+/)
      .map((n) => process.env[n]).filter((v) => v && v.length >= 8)
      .flatMap((v) => [...new Set([v, encodeURIComponent(v)])]);
    let found = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        let s = fs.readFileSync(p, "latin1"), hit = false;
        for (const v of vals) if (s.includes(v)) { hit = true; s = s.split(v).join("[redacted]"); }
        if (!hit) continue;
        found++;
        if (process.env.CM_MODE === "scrub") fs.writeFileSync(p, s, "latin1");
        else console.error("secret value found in " + p);
      }
    };
    for (const d of process.argv.slice(1)) if (fs.existsSync(d)) walk(d);
    if (process.env.CM_MODE === "scan" && found) process.exit(1);
  ' "${@:2}"
}

PIDS=()
cleanup() {
  secret_files scrub "$LOGS" "$REPORTS" || true
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  if [ -n "${REDIS_PASSWORD:-}" ] && command -v redis-cli >/dev/null 2>&1; then
    redis-cli -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning shutdown nosave >/dev/null 2>&1 || true
  fi
  if [ -n "${REDIS_CONTAINER:-}" ]; then docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

wait_http() { # url, seconds, [curl args...]
  local url="$1" secs="$2"; shift 2
  for _ in $(seq 1 "$secs"); do
    if curl -sf -o /dev/null -m 5 "$@" "$url"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $url" >&2
  return 1
}

# Fresh secrets per run. Nothing recorded can be replayed against a backend
# anyway: the backend only exists for the length of this job.
rand() { openssl rand -hex 32; }
export REDIS_PASSWORD="$(rand)" REDIS_TOKEN="$(rand)" WM_SESSION_SECRET="$(rand)"
export RELAY_SHARED_SECRET="$(rand)" LOCAL_API_TOKEN="$(rand)"
# Operator key for this run's own API, so seeders that call "the World
# Monitor API" can be pointed at the local one instead of the hosted service.
export WM_OPERATOR_KEY="wm_$(openssl rand -hex 20)"

# Values of these env vars are scrubbed from anything recorded.
KEY_VARS=(FRED_API_KEY EIA_API_KEY FINNHUB_API_KEY NASA_FIRMS_API_KEY ALPHA_VANTAGE_API_KEY
  AVIATIONSTACK_API ACLED_EMAIL ACLED_PASSWORD ACLED_ACCESS_TOKEN AISSTREAM_API_KEY
  CLOUDFLARE_API_TOKEN OPENROUTER_API_KEY LLM_API_KEY WAQI_API_KEY OPENAQ_API_KEY
  EXA_API_KEY ESTAT_APPID IMF_API_KEY COMTRADE_API_KEYS USDA_FAS_PSD_API_KEY
  GOOGLE_FACT_CHECK_API_KEY TRAVELPAYOUTS_API_TOKEN UCDP_ACCESS_TOKEN)
export CM_SECRET_ENV_NAMES="REDIS_PASSWORD REDIS_TOKEN WM_SESSION_SECRET RELAY_SHARED_SECRET LOCAL_API_TOKEN WM_OPERATOR_KEY ${KEY_VARS[*]}"
configured=()
for v in "${KEY_VARS[@]}"; do [ -n "${!v:-}" ] && configured+=("$v"); done
echo "data-source keys configured: ${configured[*]:-none}"

# ------------------------------------------------------------------ build
cd "$WM_DIR"
UPSTREAM_SHA="$(cat "$REPO_ROOT/worldmonitor.upstream-sha" 2>/dev/null || echo unknown)"
# Commit of this repository being built; published in status.json so a later
# run whose upstream code fails can rebuild this last-good version instead.
REPO_SHA="${REPO_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
export UPSTREAM_SHA REPO_SHA

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  log "npm ci (worldmonitor @ ${UPSTREAM_SHA:0:7})"
  npm ci --no-audit --no-fund
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "vite build (variant=full, base=$SITE_BASE)"
  # No Sentry DSN / Clerk / Convex: the copy must not report into upstream's
  # accounts and has no sign-in backend.
  # No PMTiles / API base / RSS relay overrides either: the defaults use
  # same-origin /api and OpenFreeMap tiles. The country-boundary overrides
  # default to maps.worldmonitor.app, which is CORS-locked to upstream's
  # sites, so point them at the copy this site ships in data/.
  env -u VITE_SENTRY_DSN -u SENTRY_AUTH_TOKEN -u VITE_CLERK_PUBLISHABLE_KEY -u VITE_CONVEX_URL \
    -u VITE_PMTILES_URL -u VITE_PMTILES_URL_PUBLIC -u VITE_WS_API_URL -u VITE_WS_RELAY_URL \
    -u VITE_RSS_DIRECT_TO_RELAY -u VITE_DESKTOP_RUNTIME -u VERCEL_GIT_COMMIT_SHA -u VERCEL_ENV \
    VITE_VARIANT=full VITE_COUNTRY_OVERRIDES_URL="${SITE_BASE}data/country-boundary-overrides.geojson" \
    NODE_OPTIONS="--max-old-space-size=8192" \
    npx vite build --base "$SITE_BASE"
  log "compile API handlers for the Node API server"
  node docker/build-handlers.mjs
fi
test -s "$WM_DIR/dist/dashboard.html" || { echo "dist/dashboard.html missing" >&2; exit 1; }

# ---------------------------------------------------------------- backend
log "start redis on :$REDIS_PORT"
if command -v redis-server >/dev/null 2>&1; then
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --requirepass "$REDIS_PASSWORD" \
    --maxmemory 1gb --maxmemory-policy allkeys-lru --save '' --appendonly no \
    --daemonize yes --logfile "$LOGS/redis.log" --dir "$RT"
else
  REDIS_CONTAINER="cm-redis-$$"
  docker run -d --rm --name "$REDIS_CONTAINER" -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine \
    redis-server --requirepass "$REDIS_PASSWORD" --maxmemory 1gb --maxmemory-policy allkeys-lru >/dev/null
fi

log "start redis-rest proxy on :$REDIS_REST_PORT"
if [ ! -d "$RT/node_modules/redis" ]; then
  (cd "$RT" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install --no-audit --no-fund redis@4 >/dev/null)
fi
cp "$WM_DIR/docker/redis-rest-proxy.mjs" "$RT/"
(cd "$RT" && SRH_TOKEN="$REDIS_TOKEN" SRH_CONNECTION_STRING="redis://:$REDIS_PASSWORD@127.0.0.1:$REDIS_PORT" \
  PORT="$REDIS_REST_PORT" exec node redis-rest-proxy.mjs) > "$LOGS/redis-rest.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$REDIS_REST_PORT/ping" 60 -H "Authorization: Bearer $REDIS_TOKEN"

export UPSTASH_REDIS_REST_URL="http://127.0.0.1:$REDIS_REST_PORT"
export UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"

log "start API server on :$API_PORT"
node docker/validate-session-secret.mjs
# NODE_ENV stays unset, as in the upstream image: the API only trusts the
# proxy's "Origin: http://localhost" outside production mode.
# VERCEL_ENV unset too, or Redis keys get a preview prefix. No WS_RELAY_URL:
# the AIS relay is not run (its loops warm-ping upstream's production API).
(exec env -u NODE_ENV -u VERCEL_ENV -u WS_RELAY_URL LOCAL_API_MODE=docker LOCAL_API_PORT="$API_PORT" \
  LOCAL_API_RESOURCE_DIR="$WM_DIR" LOCAL_API_TOKEN="$LOCAL_API_TOKEN" LOCAL_API_CLOUD_FALLBACK=false \
  WM_SESSION_SECRET="$WM_SESSION_SECRET" RELAY_SHARED_SECRET="$RELAY_SHARED_SECRET" \
  WORLDMONITOR_VALID_KEYS="$WM_OPERATOR_KEY" \
  node src-tauri/sidecar/local-api-server.mjs) > "$LOGS/api.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$API_PORT/api/sidecar-health" 120

# Same-origin /api proxy (what nginx does in upstream's image). Used by the
# seeders below and, with the site behind it, by the recorder.
node "$HERE/serve.mjs" --root "$RT" --base "$SITE_BASE" --port "$API_PROXY_PORT" --quiet \
  --api "http://127.0.0.1:$API_PORT" \
  --api-header "Origin: http://localhost" \
  --api-header "X-WorldMonitor-Local-Token: $LOCAL_API_TOKEN" > "$LOGS/serve-api.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$API_PROXY_PORT/api/sidecar-health" 30

# ------------------------------------------------------------------- seed
if [ "${SKIP_SEED:-0}" != "1" ]; then
  log "seed Redis from public data sources"
  # Never touch World Monitor's hosted service: seeders that read an API
  # base from the environment get this run's own API; the three that
  # hard-code api.worldmonitor.app (and send a worldmonitor.app Origin) and
  # the digest notifier are excluded. Bundles only re-run individual
  # seeders, so they are excluded as duplicates.
  WM_DIR="$WM_DIR" SEED_LOG_DIR="$LOGS/seed" \
    SEED_INCLUDE_BUNDLES="${SEED_INCLUDE_BUNDLES:-0}" \
    SEED_EXCLUDE="${SEED_EXCLUDE:-^seed-(infra|military-maritime-news|service-statuses|digest-notifications)\.mjs\$}" \
    API_BASE_URL="http://127.0.0.1:$API_PROXY_PORT" WM_API_BASE_URL="http://127.0.0.1:$API_PROXY_PORT" \
    WORLDMONITOR_API_KEY="$WM_OPERATOR_KEY" RELAY_URL="http://127.0.0.1:9" \
    "$HERE/run-seeders.sh"
  cp "$LOGS/seed/summary.tsv" "$REPORTS/seed-summary.tsv"
fi

# ----------------------------------------------------------------- record
log "assemble site"
node "$HERE/assemble.mjs" --dist "$WM_DIR/dist" --out "$OUT_SITE" --base "$SITE_BASE" --source "$SOURCE_URL"

log "record API responses"
node "$HERE/serve.mjs" --root "$OUT_SITE" --base "$SITE_BASE" --port "$RECORD_PORT" --quiet \
  --api "http://127.0.0.1:$API_PORT" \
  --api-header "Origin: http://localhost" \
  --api-header "X-WorldMonitor-Local-Token: $LOCAL_API_TOKEN" > "$LOGS/serve-record.log" 2>&1 &
RECORD_PID=$!
PIDS+=("$RECORD_PID")
wait_http "http://127.0.0.1:$RECORD_PORT$SITE_BASE" 30
WM_DIR="$WM_DIR" node "$HERE/record.mjs" \
  --url "http://127.0.0.1:$RECORD_PORT$SITE_BASE" \
  --out "$OUT_SITE/snapshot" --report-dir "$REPORTS" --site-origin "$SITE_ORIGIN" \
  --seconds "${RECORD_SECONDS:-90}" --passes "${RECORD_PASSES:-desktop,mobile}" \
  --fast-forward "${RECORD_FAST_FORWARD:-31:00,31:00}"
kill "$RECORD_PID" 2>/dev/null || true

# Small public status file: when, which upstream commit, how complete.
node -e '
  const fs = require("fs");
  const [site, reports] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(site + "/snapshot/manifest.json", "utf8"));
  const rep = JSON.parse(fs.readFileSync(reports + "/record-report.json", "utf8"));
  let seed = {};
  try {
    for (const line of fs.readFileSync(reports + "/seed-summary.tsv", "utf8").trim().split("\n")) {
      const s = line.split("\t")[1];
      seed[s] = (seed[s] || 0) + 1;
    }
  } catch {}
  fs.writeFileSync(site + "/snapshot/status.json", JSON.stringify({
    generatedAt: m.generatedAt, upstreamSha: m.upstreamSha, repoSha: process.env.REPO_SHA,
    responses: rep.summary.entries, statuses: rep.summary.statusHist, seeders: seed,
  }, null, 2));
  // Quality gate: never replace a good snapshot with a mostly empty one.
  const ok = Object.entries(rep.summary.statusHist)
    .filter(([s]) => Number(s) >= 200 && Number(s) < 300)
    .reduce((n, [, c]) => n + c, 0);
  const min = Number(process.env.MIN_OK_RESPONSES || 60);
  console.log(`snapshot: ${ok} successful API responses recorded (minimum ${min})`);
  if (ok < min) { console.error("snapshot: too few successful responses"); process.exit(1); }
' "$OUT_SITE" "$REPORTS"

log "stamp capture time into the pages"
node "$HERE/assemble.mjs" --stamp --out "$OUT_SITE"

log "check the site for leaked secret values"
secret_files scan "$OUT_SITE"

# ----------------------------------------------------------------- verify
log "verify static replay (no backend in the path)"
node "$HERE/serve.mjs" --root "$OUT_SITE" --base "$SITE_BASE" --port "$VERIFY_PORT" --quiet > "$LOGS/serve-verify.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$VERIFY_PORT$SITE_BASE" 30
WM_DIR="$WM_DIR" node "$HERE/verify.mjs" --url "http://127.0.0.1:$VERIFY_PORT$SITE_BASE" \
  --site-origin "$SITE_ORIGIN" --report-dir "$REPORTS" --min-hit-rate "${MIN_HIT_RATE:-0.6}"

du -sh "$OUT_SITE" "$OUT_SITE/snapshot" | sed 's/^/size: /'
log "done: $OUT_SITE"
exit 0
}
