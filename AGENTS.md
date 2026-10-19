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
4. **Never retry authentication on an auth failure.** Dexcom locks the
   account after repeated bad logins. Re-authenticate only on
   `SessionIdNotFound` / `SessionNotValid`; a password or lockout error
   stops the refresh loop and reopens setup. Classification lives on
   `DexcomError`.
5. **Single user per deployment.**

## Where things live

| File | Owns |
|------|------|
| `index.html` | Markup, meta tags, CSP, icon and manifest links. |
| `icons/`, `manifest.webmanifest` | App icon (`icon.svg` is the source; the PNGs are renders of it at 32, 180, 192 and 512 px, full square because iOS and Android mask the corners) and the web app manifest for "Add to Home screen". |
| `style.css` | Layouts, the portrait/landscape orientation query, night mode, setup form. |
| `app.js` | DOM wiring: setup, refresh scheduling, wake lock, banners, graph, gestures. `CONFIG` at the top. |
| `display.js` | Pure functions, no DOM: units, bands, trend arrows, reading normalisation, age/delta/stale summary, graph range, fetch timing. Put new logic here so it can be tested. |
| `dexcom-client.js` | Dexcom auth flow, 1 h session cache, account-id cache (`cgm.account`, keyed by username and region, so a session refresh is one call instead of two), error classification, retry-once on session errors. |
| `tests/*.test.ts` | vitest suites for `display.js` and `dexcom-client.js`; `setup.ts` stubs `localStorage`. |
| `tests/e2e/` | Playwright: `dexcom.ts` intercepts the Dexcom hosts with fixtures; `dashboard.spec.ts` covers setup, errors, layouts, banners, reset, scheduling; `layout.spec.ts` checks every landscape phone/tablet viewport for overflow and against the snapshots in `__snapshots__/`; `screenshots.spec.ts` (only via `npm run screenshots`) renders the README images. Playwright answers CORS preflights itself, so the suite cannot detect Dexcom dropping CORS; that stays a manual curl. |

## Run

```bash
npm install
npm test             # unit tests
npm run test:e2e     # Playwright against the installed Google Chrome
npm run typecheck
npm run dev          # static server on :8787; hits real Dexcom from the browser
```

No mock mode in production code. The Playwright suite intercepts the
Dexcom hosts with `page.route` and serves fixtures from
`tests/e2e/dexcom.ts`; to work on the UI without an account, run
`npx playwright test --ui` or `--headed` and pick a test.

**Snapshots are owned by CI.** The PNGs in `tests/e2e/__snapshots__`
are rendered on the `ubuntu-latest` runner and compared there on every
push; the comparison is skipped locally because fonts differ between
machines (`npm run test:e2e:snapshots` forces it). After a deliberate
visual change, don't regenerate them locally: run the CI workflow with
the `update_snapshots` input (`gh workflow run ci.yml -f
update_snapshots=true --ref <branch>`), which re-renders them on the
runner in a separate job with write access and pushes a commit to that
branch. Review that commit's PNGs. GitHub only offers the dispatch once
the workflow file exists on `main`, so the very first run on a fresh
repo will fail the snapshot step until that dispatch has happened.

To run the workflow locally: `gh act push` (act as a `gh` extension,
Docker required). act's image is not GitHub's, so under act the
snapshot comparison is skipped (`ACT` is set); the snapshots job never
runs there because it only runs on a manual dispatch. Everything else
runs as on GitHub. The bot's push uses the Actions token, which does
not start a new run, so the re-rendered snapshots are first checked by
the next ordinary push.

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
  waits until the next reading is due (plus `readingLagMs`), retries
  every `retryMs` while it is only slightly overdue, and drops to
  `refreshMs` / `nightRefreshMs` when it is long overdue. Don't replace
  it with a fixed interval; it is both fresher and cheaper.
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
- **Banner priority.** `error` beats `stale`; only a successful fetch
  clears `error`.
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
