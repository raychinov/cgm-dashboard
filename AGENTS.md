# AGENTS.md

Orientation for AI coding agents working on this repo. Human-facing
docs are in `README.md`.

## What this is

A static page, served from the repo root by GitHub Pages, that calls
the Dexcom Share API straight from the browser. Dexcom's Share hosts
send `Access-Control-Allow-Origin: *`, which is what makes a serverless
design possible. There is no build step and no server component.

## Invariants

1. **No server, no secrets outside the phone.** Credentials live in
   `localStorage` and go only to Dexcom. Don't add a proxy, a backend,
   analytics, or any third-party script.
2. **Plain static files at the repo root.** `index.html`, `app.js`,
   `display.js`, `dexcom-client.js`, `style.css`. No bundler, no
   framework, ES modules only. A fork must work with "Deploy from a
   branch, main, root" and nothing else.
3. **The CSP in `index.html` is a security control.** `script-src
   'self'`, `connect-src` limited to the three Dexcom hosts. No inline
   scripts, no inline `style=""` attributes. Adding a host to
   `dexcom-client.js` means adding it to `connect-src`.
4. **Send the password as rarely as possible.** Dexcom locks the
   account after repeated bad logins. Sessions have no expiry of our
   own; re-login only on `SessionIdNotFound` / `SessionNotValid`. A
   password or lockout error stops the refresh loop and shows LOGGED
   OUT with the credentials kept; a tap retries once, and only
   `SSO_InternalError` retries by itself (hourly). Any other login
   failure pauses logins for 5, then 15, then 60 minutes
   (`cgm.loginPause`), as does a fresh session being rejected at once.
   Classification lives on `DexcomError`.
5. **Single user per deployment.**

## Where things live

| File | Owns |
|------|------|
| `index.html` | Markup, meta tags, CSP, icon and manifest links. |
| `icons/`, `manifest.webmanifest` | App icon (`icon.svg` is the source; the PNGs are renders of it at 32, 180, 192 and 512 px, full square because iOS and Android mask the corners) and the web app manifest for "Add to Home screen". |
| `style.css` | Layouts, the portrait/landscape orientation query, night mode, setup form. |
| `app.js` | DOM wiring: setup, refresh scheduling, wake lock, banners, graph, gestures. `CONFIG` at the top. |
| `display.js` | Pure functions, no DOM: units, bands, trend arrows, reading normalisation, age/delta/stale summary, graph range, fetch timing. Put new logic here so it can be tested. |
| `dexcom-client.js` | Dexcom auth flow, session cache (`cgm.session`, kept until Dexcom rejects it), account-id cache (`cgm.account`, keyed by username and region, so a re-login is one call instead of two), login pause (`cgm.loginPause`), error classification, retry-once on session errors. |
| `tests/*.test.ts` | vitest suites for `display.js` and `dexcom-client.js`; `setup.ts` stubs `localStorage`. |
| `tests/e2e/` | Playwright: `dexcom.ts` intercepts the Dexcom hosts with fixtures; `dashboard.spec.ts` covers setup, errors, layouts, banners, reset, scheduling; `layout.spec.ts` checks every landscape phone/tablet viewport for overflow and against the snapshots in `__snapshots__/`; `screenshots.spec.ts` (only via `npm run screenshots`) renders the README images. Playwright answers CORS preflights itself, so the suite cannot detect Dexcom dropping CORS; that stays a manual curl. |

## Run

```bash
npm install
npm test                 # unit tests
npm run test:e2e         # the CI run: Playwright Docker image, bundled Chromium, snapshots compared
npm run test:e2e:chrome  # quick run against the installed Google Chrome, snapshots skipped
npm run snapshots:update # re-render tests/e2e/__snapshots__ in that image
npm run typecheck
npm run dev              # static server on :8787; hits real Dexcom from the browser
```

No mock mode in production code. The Playwright suite intercepts the
Dexcom hosts with `page.route` and serves fixtures from
`tests/e2e/dexcom.ts`; to work on the UI without an account, run
`npm run test:e2e:chrome -- --ui` or `--headed` and pick a test.

**Snapshots are rendered in one container, everywhere.** The PNGs in
`tests/e2e/__snapshots__` only match when browser build and fonts are
identical, so both CI jobs run inside
`mcr.microsoft.com/playwright:v<playwright version>-noble` and
`npm run test:e2e` runs the same image on a dev machine (Docker
required). `npm run test:e2e:chrome` uses the installed Google Chrome
and skips the snapshot comparison, because fonts and browser build
differ from the image; use it for quick iteration, `--headed` and
`--ui`. After a deliberate visual change run `npm run
snapshots:update`, review the PNGs and commit them. The image tag in
`ci.yml` must match the installed `@playwright/test` version;
`npm run check:playwright-image` fails the CI run when they drift, so
bump both together.

The `update_snapshots` workflow dispatch (`gh workflow run ci.yml -f
update_snapshots=true --ref <branch>`) still exists for a machine
without Docker: it re-renders the PNGs in the same image in a job with
write access and pushes a commit to that branch. Its push uses the
Actions token, which does not start a new run, so those snapshots are
first checked by the next ordinary push.

## Traps

- **We depend on Dexcom's CORS headers.** Unofficial API. If every
  fetch starts failing with a `TypeError` and the page says "Could not
  reach Dexcom", check first:
  `curl -sD - -o /dev/null -X OPTIONS https://shareous1.dexcom.com/ShareWebServices/Services/General/AuthenticatePublisherAccount -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST'`
  Run it against all three hosts (`share2.dexcom.com`,
  `share.dexcom.jp` too). There is deliberately no scheduled CI check
  for this; it is a manual step when "Could not reach Dexcom" shows up
  on every device at once. If the header is gone, the fallback is a
  thin proxy: a serverless function that accepts `{server, path,
  query, body}`, forwards the POST to the matching Dexcom host, and
  returns the response with CORS headers. Earlier versions of this
  project shipped one as a Cloudflare Worker; the important parts were
  an allowlist of the three hosts and rejecting any `path` that is not
  a plain absolute path (SSRF guard).
- **Fetch timing follows Dexcom's 5-minute cadence.** `nextFetchDelay`
  waits until the next reading is due plus the learned lag, retries
  every `retryMs` while it is only slightly overdue, and drops to
  `refreshMs` / `nightRefreshMs` when it is long overdue or after a
  failed fetch. The lag (`cgm.lag`, `nextLagEstimate`) is how long
  after its own timestamp a new reading first appeared, measured on the
  phone's clock, so clock skew in either direction is absorbed. Don't
  replace any of it with a fixed interval.
- **No blocking overlay, no log-out gesture.** With stored credentials
  the dashboard starts fetching at once; the first touch only requests
  fullscreen and the wake lock (the "tap for fullscreen" chip). There
  is deliberately no way to log out from the page; a dedicated screen
  with confirmation is the only acceptable way to add one.
- **Keep-awake has two layers.** The Screen Wake Lock sentinel is
  re-requested on `release`; the fallback is a real 1 s black MP4
  (`SILENT_MP4`, generated with ffmpeg). An MP4 without a media track
  is rejected by Chrome, so don't shrink it.
- **Per-region `applicationId`.** US and OUS share one GUID, Japan has
  its own. The wrong one returns `ApplicationNotAuthenticated`.
  Cross-check pydexcom's `const.py` if Dexcom rotates them.
- **Nil GUID means bad credentials.** Dexcom sometimes answers auth
  with `00000000-…` instead of an error; `requireGuid` rejects it.
- **`SSO_InternalError` is ambiguous.** It is an auth error only when
  the message contains "Cannot Authenticate by AccountName/AccountId".
  Everything else is a server problem and must not log the kiosk out.
- **Follower requirement is a Dexcom setting, not a code issue.**
  "Auth works, no readings" means no follower is configured.
- **Banner priority.** `error` beats `stale`, but an error banner
  carries "last reading N min ago" once the reading is stale, and the
  number and trend go grey (`body.stale`) whatever the banner says.
  Only a successful fetch clears `error`.
- **Readings are never replaced by nothing.** An empty answer from
  Dexcom keeps the last known readings so STALE keeps counting; the
  last value stays on screen, greyed, however old it gets. The age is
  the larger of "clock minus timestamp" and "time since first seen"
  (`cgm.seen`), so a phone clock running behind cannot hide staleness.
- **Graph y-range is dynamic.** `graphRange` keeps 20 mg/dL above the
  higher of `urgentHigh` and the highest visible reading.
- **Text is sized by measurement, not breakpoints.** `fitText` in
  `app.js` sets the font-size of `#reading-area` and `#clock` so their
  content fits the box flex gave them, in both axes; children are sized
  in `em` of that. The only media query decides whether clock and
  reading stack (portrait) or sit side by side (landscape). Don't add
  per-device font rules; if a screen looks wrong, change the flex
  ratios or the `em` proportions and re-run the viewport matrix.
- **Landscape is the target.** The kiosk stands sideways; the layout
  tests and snapshots cover landscape phones and tablets only. Portrait
  is a best-effort fallback (the stacked orientation rule) and is not
  tested. Desktop is not a target either.

## Follow-ups

- In-browser settings for thresholds, units and the night window.
