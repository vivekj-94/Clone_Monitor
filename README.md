# Clone Monitor

A daily snapshot of [World Monitor](https://github.com/koala73/worldmonitor),
the open-source global situation dashboard, published as a static website on
GitHub Pages:

**https://vivekj-94.github.io/Clone_Monitor/** (live after the one-time setup below)

Every day a GitHub Actions run copies the latest World Monitor code into this
repository, runs the dashboard's own backend inside the runner, fills it with
data from ~260 public sources, records everything the dashboard loads, and
publishes the frozen result. The page shows a small notice with the capture
time.

## One-time setup

1. **Make the repository public.** Settings → General → Danger Zone → Change
   visibility → Public. On the free GitHub plan, Pages needs a public
   repository, and a public repository gets unlimited Actions minutes (a daily
   run uses roughly 30–45 minutes; a private repository gets 2,000 a month).
   The published site is public either way.
2. **Turn on Pages.** Settings → Pages → Build and deployment → Source:
   **GitHub Actions**.
3. **Run it once.** Actions → *Daily snapshot* → Run workflow. After that it
   runs by itself every day at 05:23 UTC.

## What works and what does not

The snapshot is the dashboard exactly as it loaded during the daily capture:
the map and its layers, the panels on screen, markets, the news digest, and
the rest, as of the time in the notice. Video and webcam embeds play live from
YouTube and the camera providers.

Anything that needs a live server *after* the page loads is not available:
search, AI chat and AI insights, drilling into a country or stock the capture
did not open, sign-in and Pro features, live ship tracking. These show the
app's normal "unavailable" state. For the live product use
[worldmonitor.app](https://www.worldmonitor.app/).

## More data with free API keys (optional)

Without keys, about two thirds of the data sources work. Each key below is
free and unlocks more panels. Add them under Settings → Secrets and variables
→ Actions → New repository secret, using these exact names:

| Secret | Unlocks | Sign up |
| --- | --- | --- |
| `FRED_API_KEY` | US rates, CPI, yield curve, macro tiles | <https://fred.stlouisfed.org/docs/api/api_key.html> |
| `EIA_API_KEY` | Oil and gas inventories, fuel and electricity prices | <https://www.eia.gov/opendata/> |
| `FINNHUB_API_KEY` | Stock quotes, earnings calendar | <https://finnhub.io/> |
| `NASA_FIRMS_API_KEY` | Satellite fire detections | <https://firms.modaps.eosdis.nasa.gov/api/> |
| `ALPHA_VANTAGE_API_KEY` | Equity data fallback | <https://www.alphavantage.co/support/#api-key> |
| `AVIATIONSTACK_API` | International flight delays | <https://aviationstack.com/> |
| `WAQI_API_KEY` | Air quality | <https://aqicn.org/data-platform/token/> |
| `OPENROUTER_API_KEY` | AI-written summaries (uses your free daily quota) | <https://openrouter.ai/> |

The snapshot publishes the raw API responses it recorded (under
`/snapshot/r/`), so only add keys for sources whose terms allow their data to
be shown publicly. ACLED, for example, is deliberately not wired in.

## How it works

```
worldmonitor/            unmodified copy of koala73/worldmonitor (synced daily)
snapshot/build.sh        the whole pipeline, also runnable locally
snapshot/run-seeders.sh  runs upstream's ~260 seeders in parallel, then retries
snapshot/record.mjs      headless Chromium loads the dashboard, records /api responses
snapshot/cm-snapshot.js  injected into the page: replays those responses
snapshot/assemble.mjs    turns the Vite build into the Pages site
snapshot/serve.mjs       local stand-in for GitHub Pages (+ /api proxy when recording)
snapshot/verify.mjs      loads the finished site with no backend and checks the replay
.github/workflows/daily-snapshot.yml
```

Why a snapshot and not a live copy: World Monitor needs a server (an API,
Redis, and data jobs), and its hosted API only accepts requests from
worldmonitor.app pages. GitHub Pages serves static files only, so the
pipeline runs the backend during the build and freezes what it returns.

The daily run, in order:

1. **sync** copies upstream's tracked files into `worldmonitor/` and commits
   if anything changed. Upstream's own `.github/workflows` end up inside
   `worldmonitor/`, where GitHub never runs them.
2. **snapshot** builds the dashboard (`vite build --base /Clone_Monitor/`),
   starts `redis-server`, upstream's Redis REST proxy and its Node API server
   (the same pieces as upstream's Docker image, without Docker), runs the
   seeders, records the dashboard at desktop and mobile sizes, then serves the
   result as plain files and fails the run if the replay does not work.
3. **deploy** publishes the site to GitHub Pages.

If upstream breaks something, the run fails and Pages keeps serving the last
good snapshot. GitHub emails you about failed runs; the run page has a summary
and a `snapshot-reports` artifact with logs.

The copy does not report to World Monitor's analytics or error tracking, and
its pages are marked `noindex` so they do not compete with the original in
search results.

## Run it locally

Needs Node 24 (see `worldmonitor/.nvmrc`) and `redis-server` (or Docker).

```bash
(cd worldmonitor && npm ci && npx playwright install chromium)
SKIP_INSTALL=1 ./snapshot/build.sh
node snapshot/serve.mjs --root .snapshot-work/site
```

Then open <http://127.0.0.1:8080/Clone_Monitor/>.

## Things to know

- **Security.** The snapshot job runs upstream's code (npm install scripts,
  seeders, build) with a read-only token and with the data keys you add.
  Only the sync job can write to the repository, and it never executes
  upstream code.
- **Scheduled runs pause after 60 days** without repository activity (a
  GitHub rule for public repositories). The daily sync commit normally
  counts as activity. If runs stop, re-enable the workflow from the Actions
  tab.
- **License.** World Monitor is AGPL-3.0-only, and so is this repository.
  The page notice links here as the source of the running copy. Not
  affiliated with or endorsed by World Monitor; the data belongs to its
  respective sources.
