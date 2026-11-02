# Clone Monitor

An unofficial daily snapshot of [World Monitor](https://github.com/koala73/worldmonitor),
the open-source global situation dashboard, published as a static website on
GitHub Pages:

**https://vivekj-94.github.io/Clone_Monitor/** (live after the one-time setup below)

Every day a GitHub Actions run copies the latest World Monitor code into this
repository, runs the dashboard's own backend inside the runner, fills it with
data from about 240 public sources, records everything the dashboard loads,
and publishes the frozen result. A notice on the page shows the capture time.

## One-time setup

1. **Make the repository public.** Settings → General → Danger Zone → Change
   visibility → Public. On the free GitHub plan, Pages needs a public
   repository, and a public repository gets unlimited Actions minutes (a daily
   run takes about 20–25 minutes; a private repository gets 2,000 a month).
   The published site is public either way, and the AGPL requires the source
   of the published copy to be available, which this repository provides.
2. **Turn on Pages.** Settings → Pages → Build and deployment → Source:
   **GitHub Actions**.
3. **Run it once.** Actions → *Daily snapshot* → Run workflow. After that it
   runs by itself every day at 05:23 UTC.

## What you see

The dashboard as it loaded during the daily capture: the map and its layers,
the panels, markets, the news digest, and the rest. The page shows that
moment: the dashboard's own clock and "updated N minutes ago" labels read as
of the capture, and the notice at the bottom left gives the real age. Live
video and webcam embeds play live from their providers.

Anything that needs a live server *after* the page loads is not available:
search, AI chat, drilling into something the capture did not open, sign-in and
Pro features (hidden here), live ship tracking. For the live product use
[worldmonitor.app](https://www.worldmonitor.app/).

## More data with free API keys (optional)

Without keys about three quarters of the data jobs succeed. Each key below is
free and unlocks more panels. Add them under Settings → Secrets and variables
→ Actions → New repository secret, using these exact names:

| Secret | Unlocks | Sign up |
| --- | --- | --- |
| `FRED_API_KEY` | US rates, CPI, yield curve, macro tiles | <https://fred.stlouisfed.org/docs/api/api_key.html> |
| `EIA_API_KEY` | Oil and gas inventories, fuel and electricity prices | <https://www.eia.gov/opendata/> |
| `FINNHUB_API_KEY` | Stock quotes, earnings calendar | <https://finnhub.io/> |
| `NASA_FIRMS_API_KEY` | Satellite fire detections, thermal escalation | <https://firms.modaps.eosdis.nasa.gov/api/> |
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
snapshot/run-seeders.sh  runs upstream's data jobs in parallel, then retries
snapshot/record.mjs      headless Chromium loads the dashboard, records /api responses
snapshot/cm-snapshot.js  injected into the page: replays those responses
snapshot/assemble.mjs    turns the Vite build into the Pages site (and rebrands it)
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
   data jobs, records the dashboard at desktop and mobile sizes (with the
   WebGL map that real visitors get, and after jumping the clock ahead so
   refresh requests are captured too), then serves the result as plain files
   and fails if the replay does not work or the data is too thin.
3. **deploy** publishes the site to GitHub Pages.

If the newest upstream code breaks the build, the run rebuilds the code of
the snapshot that is currently online with fresh data, so the page still
refreshes. If even that fails, Pages keeps the previous snapshot, GitHub
emails you, and the notice on the page turns red once the data is 36 hours
old. Each run page has a summary and a `snapshot-reports` artifact with logs.

## Relationship to World Monitor

- Built only from the open-source code and public data sources. The run
  never uses World Monitor's hosted service: every worldmonitor.app hostname
  the code references is blocked inside the job, the few upstream data jobs
  that call the hosted API are skipped, and the others are pointed at the
  job's own API.
- No reporting to World Monitor's analytics or error tracking. Pages are
  `noindex`, so the copy does not compete with the original in search.
- Branded "Clone Monitor" with "Based on World Monitor" attribution, as
  upstream's [trademark policy](worldmonitor/docs/trademark-policy.mdx) asks of
  forks. Not affiliated with or endorsed by World Monitor.
- AGPL-3.0-only, like World Monitor. [NOTICE.md](NOTICE.md) lists what the
  published build changes; the page links here as its source.

## Run it locally

Needs Node 24 (see `worldmonitor/.nvmrc`) and `redis-server` (or Docker).

```bash
(cd worldmonitor && npm ci && npx playwright install chromium)
SKIP_INSTALL=1 ./snapshot/build.sh
node snapshot/serve.mjs --root .snapshot-work/site
```

Then open <http://127.0.0.1:8080/Clone_Monitor/>. The build modifies files
under `worldmonitor/api/` in place (upstream's handler compile step); run
`git checkout -- worldmonitor && git clean -fd worldmonitor` afterwards.

## Things to know

- **Security.** The snapshot job runs upstream's code (npm install scripts,
  data jobs, build) with a read-only token and with the data keys you add.
  Only the sync job can write to the repository, and it never executes
  upstream code. Key values are scrubbed from logs, and the run refuses to
  publish if one appears anywhere in the site.
- **Scheduled runs pause after 60 days** without repository activity (a
  GitHub rule for public repositories). The daily sync commit normally
  counts as activity. If runs stop, re-enable the workflow from the Actions
  tab.
- **Default branch.** The default branch is the one the workflow lives on.
  If you rename it, Pages keeps working; if you switch the default to
  another branch, move the workflow there too.
