# TODO

## Before going public

- [x] On-device check on a real phone.
- [x] Screenshots for the README (`npm run screenshots`, demo data at
      956 × 440; rerun after a visual change).
- [x] GitHub account settings → Emails → "Keep my email address
      private" and "Block command line pushes that expose my email".
- [x] History rewritten: every commit uses the noreply address.
- [x] Repo name stays `cgm-dashboard`.
- [ ] Flip the repo to public and enable Pages on it; delete the
      temporary `cgm-dashboard-poc` repo.
- [ ] Enable **Template repository** so "Use this template" works
      alongside Fork.

## Product

- [ ] Settings UI for thresholds, units and the night window
      (currently `CONFIG` in `app.js`).

## Tests

- [ ] After merging to `main` and pushing, run
      `gh workflow run ci.yml -f update_snapshots=true --ref main` once
      so the committed PNGs come from the runner instead of a developer
      machine. The first push's CI run will fail on the snapshot step
      until then.

## Later

- [ ] Opt-in audio/vibrate alerts for urgent low/high.
- [ ] Other CGM providers (Libre, Medtronic) behind a client interface.
