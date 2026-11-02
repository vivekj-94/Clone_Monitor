#!/usr/bin/env bash
# Parallel version of worldmonitor/scripts/run-seeders.sh for CI.
#
# Upstream's runner executes ~260 seed scripts one after another with a
# 30-minute cap each, which does not fit a GitHub Actions job. This runs them
# N at a time with a short per-seeder cap and writes one log per seeder plus a
# summary TSV, so a snapshot run can report which data sources made it.
#
# Env:
#   WM_DIR                    worldmonitor checkout (default: ./worldmonitor)
#   UPSTASH_REDIS_REST_URL    redis-rest proxy URL (required)
#   UPSTASH_REDIS_REST_TOKEN  redis-rest bearer token (required)
#   SEED_PARALLEL             concurrent seeders (default 8)
#   SEED_TIMEOUT              seconds per seeder (default 300)
#   SEED_LOG_DIR              where logs go (default ./seed-logs)
#   SEED_INCLUDE_BUNDLES      1 to also run seed-bundle-*.mjs (default 1)
#   SEED_EXCLUDE              extended regex of seeder file names to skip
set -uo pipefail

WM_DIR="$(cd "${WM_DIR:-worldmonitor}" && pwd)"
SEED_PARALLEL="${SEED_PARALLEL:-8}"
SEED_TIMEOUT="${SEED_TIMEOUT:-300}"
SEED_LOG_DIR="${SEED_LOG_DIR:-$PWD/seed-logs}"
SEED_INCLUDE_BUNDLES="${SEED_INCLUDE_BUNDLES:-1}"
SEED_EXCLUDE="${SEED_EXCLUDE:-}"

: "${UPSTASH_REDIS_REST_URL:?UPSTASH_REDIS_REST_URL is required}"
: "${UPSTASH_REDIS_REST_TOKEN:?UPSTASH_REDIS_REST_TOKEN is required}"
export UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
# The local redis-rest proxy is plain HTTP; seeders that insist on https://
# honour this opt-in (same switch docker-compose.yml sets for the relay).
export UPSTASH_ALLOW_INSECURE_HTTP="${UPSTASH_ALLOW_INSECURE_HTTP:-true}"

mkdir -p "$SEED_LOG_DIR"
SUMMARY="$SEED_LOG_DIR/summary.tsv"
: > "$SUMMARY"

mapfile -t SEEDERS < <(
  cd "$WM_DIR/scripts" && ls seed-*.mjs | sort | while read -r f; do
    if [ "$SEED_INCLUDE_BUNDLES" != "1" ] && [[ "$f" == seed-bundle-* ]]; then continue; fi
    if [ -n "$SEED_EXCLUDE" ] && [[ "$f" =~ $SEED_EXCLUDE ]]; then continue; fi
    echo "$f"
  done
)

run_one() {
  local f="$1" start end rc last status
  start=$(date +%s)
  (cd "$WM_DIR" && timeout -k 15 "$SEED_TIMEOUT" node "scripts/$f") > "$SEED_LOG_DIR/$f.log" 2>&1
  rc=$?
  end=$(date +%s)
  last=$(grep -v '^\s*$' "$SEED_LOG_DIR/$f.log" | tail -1 | tr '\t\r\n' '   ' | cut -c1-200)
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    status=TIMEOUT
  elif [ "$rc" -eq 0 ]; then
    if echo "$last" | grep -qiE 'skip|not set|missing.*key'; then status=SKIP; else status=OK; fi
  else
    if echo "$last" | grep -qiE 'skip|not set|missing.*key'; then status=SKIP; else status=FAIL; fi
  fi
  printf '%s\t%s\t%s\t%ss\t%s\n' "$f" "$status" "$rc" "$((end - start))" "$last" >> "$SUMMARY"
  printf '%-8s %4ss  %s\n' "$status" "$((end - start))" "$f"
}
export -f run_one
export WM_DIR SEED_TIMEOUT SEED_LOG_DIR SUMMARY

echo "run-seeders: ${#SEEDERS[@]} seeders, $SEED_PARALLEL at a time, ${SEED_TIMEOUT}s cap each"
t0=$(date +%s)
printf '%s\n' "${SEEDERS[@]}" | xargs -P "$SEED_PARALLEL" -I{} bash -c 'run_one "$@"' _ {}

# Second pass: derived seeders (correlations, forecasts, scores...) read
# keys other seeders write, and the parallel first pass gives no ordering.
# Re-run what failed or timed out, except failures caused by a missing key.
if [ "${SEED_RETRY:-1}" = "1" ]; then
  mapfile -t RETRY < <(
    awk -F'\t' '$2=="FAIL" || $2=="TIMEOUT" {print $1}' "$SUMMARY" | while read -r f; do
      if grep -qiE '(_API_KEY|_APPID|_TOKEN|_KEYS?)[^a-z]*(not set|missing|required)|missing [A-Z_]*(KEY|APPID|TOKEN)|no [A-Z_]+ (api )?key' "$SEED_LOG_DIR/$f.log"; then
        continue
      fi
      echo "$f"
    done
  )
  if [ "${#RETRY[@]}" -gt 0 ]; then
    echo "run-seeders: retrying ${#RETRY[@]} seeders whose inputs may not have existed yet"
    FIRST="$SUMMARY"
    SUMMARY="$SEED_LOG_DIR/summary-retry.tsv"
    : > "$SUMMARY"
    export SUMMARY
    printf '%s\n' "${RETRY[@]}" | xargs -P "$SEED_PARALLEL" -I{} bash -c 'run_one "$@"' _ {}
    # The retry result replaces the first-pass line for those seeders.
    awk -F'\t' 'NR==FNR {retry[$1]=$0; next} ($1 in retry) {print retry[$1]; next} {print}' "$SUMMARY" "$FIRST" > "$FIRST.tmp"
    mv "$FIRST.tmp" "$FIRST"
    SUMMARY="$FIRST"
  fi
fi
t1=$(date +%s)

sort -o "$SUMMARY" "$SUMMARY"
for s in OK SKIP FAIL TIMEOUT; do
  printf '%s=%s ' "$s" "$(awk -F'\t' -v s="$s" '$2==s' "$SUMMARY" | wc -l)"
done
echo "in $((t1 - t0))s"
# Never fail the job because some upstream data source is down or keyless:
# a partial snapshot is still worth publishing.
exit 0
