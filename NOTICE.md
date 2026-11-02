# Notice of modifications

This repository contains, in `worldmonitor/`, an unmodified copy of
[World Monitor](https://github.com/koala73/worldmonitor), Copyright (C)
2024-2026 Elie Habib, licensed under the GNU Affero General Public License
v3.0 only (see `worldmonitor/LICENSE` and `LICENSE`). The exact upstream
commit is recorded in `worldmonitor.upstream-sha` and refreshed daily.

The website published from this repository ("Clone Monitor") is a modified
version of World Monitor. The files in `worldmonitor/` are not edited; every
change is made at build time by the scripts in `snapshot/` (AGPL-3.0-only,
like the rest of this repository). As of 2026-11-02 the published build
differs from upstream as follows:

- Built with `vite build --base /Clone_Monitor/` for a GitHub Pages project
  site, without error reporting, analytics, sign-in or payment configuration,
  and with the country-boundary overrides served from the site itself.
- Root-absolute string literals in the bundles that name files of the site
  (`/data/...`, `/textures/...`, `/favico/...`, ...) are prefixed with the
  base path (`snapshot/assemble.mjs`).
- `snapshot/cm-snapshot.js` is injected as the first script of each page. It
  answers the dashboard's `/api` requests from responses recorded the same
  day, synthesizes the anonymous session, sets the page clock to the capture
  time, blocks upstream analytics scripts, disables the service worker,
  replaces the product name in the header and footer, and shows a notice
  with the capture time, attribution and links to the original and to this
  source.
- In the HTML: a new title and application name, `noindex`, no Open Graph,
  Twitter or JSON-LD identity tags, no preconnects to worldmonitor.app hosts,
  and CSS that hides the Pro upsell, sign-in buttons, locked Pro panels and
  the links to upstream's other editions. The web manifest name is changed.
- The service worker file is replaced by one that unregisters itself.

Copyright, author and license notices of World Monitor are kept. Clone
Monitor is not affiliated with or endorsed by World Monitor.
