# LIFE.OS — Local Refresh Timer

The dashboard at **https://ccardow.github.io/pi-dashboard/** is fed by
`fetch-feeds.js` → GitHub Gist → the site. The Pi card shows **live Hermes
runtime state**, which only this machine can read, so the refresh runs here
via a systemd user timer.

## How it runs

| Piece | Where |
|---|---|
| Timer | `~/.config/systemd/user/lifeos-refresh.timer` |
| Service | `~/.config/systemd/user/lifeos-refresh.service` |
| Runner | `scripts/refresh.sh` |
| Change detection | `scripts/data-fingerprint.js` |
| Credentials | `~/.config/lifeos/lifeos.env` (0600, in a 0700 dir) |
| Token setup | `scripts/setup-refresh-token.sh` |

Every 30 minutes (at :07 and :37) the service:

1. `node fetch-feeds.js --no-push` — fetches all feeds and reads live
   Hermes state from `~/.hermes/state.db` + `gateway_state.json`.
2. `node push-to-gist.js` — publishes to the Gist (the site's live source).
3. Compares a **content fingerprint** against HEAD. If the content is
   unchanged, it stops here — no commit, no push, no rebuild.
4. Otherwise commits `vibes.json` to the repo over SSH, which keeps the
   client's fallback copy fresh and triggers the static-host redeploy.

### Why the fingerprint

The data always carries a fresh timestamp, token counters, uptime and
per-log times. A plain `git status` sees a change every run, so every
30-minute cycle produced a commit and redeployed the site to ship data
that had not moved.

`scripts/data-fingerprint.js` hashes only the meaningful content:
volatile fields are deleted, counters embedded in status strings
("374 msgs · 180 tools") are masked to placeholders, and keys are sorted
so ordering cannot affect the hash. The Gist is still updated every run —
only the *commit* is skipped, so the live data stays fresh while a quiet
cycle costs nothing.

### Feed health

`vibes.json` carries a `feed_health` block, one entry per source:

```json
"x": { "status": "live", "fetched_at": "...", "age_min": 13,
       "count": 10, "error": null, "source": "nitter mirrors" }
```

`status` is `live` (fetched successfully), `stale` (this run failed; the
previous good value is being served) or `unknown`. The dashboard renders
this as a strip across the top — one pill per source, colour-coded, with
the age — plus a marker beside any card title whose feed is not live.

This exists because a card rendering *something* is indistinguishable from
a card that works. The dashboard served eight-month-old data for months
without looking wrong.

`fetched_at` and `age_min` are excluded from the content fingerprint
(they move every run), but `status`, `count` and `error` are included — a
feed going stale IS a real change worth committing.

### The FireBuilt roster

`vibes.json` also carries `firebuilt`, read live from the Hermes profile
directories: each agent's role from its own `SOUL.md`, its model from its
`config.yaml`, and its session/message counts from its own `state.db`. The
card has no hardcoded copy, so it cannot quietly become untrue.

### Current context, not lifetime tokens

The Pi card's "Context" figure is the **current context occupancy**, read
from the session row's `model_config._usage_anchor.prompt_tokens` — the same
number the Hermes CLI shows as "Current context".

Do NOT use the session row's `input_tokens`/`output_tokens` for this. Those
are lifetime totals for the whole session; adding them produces readings
like `1413k / 1000k` once a session runs long enough. When the anchor is
missing the fetcher emits `null` and the card shows `—`, never a fabricated
zero.

### The System Activity card shows the real pipeline history

It used to show a hardcoded boot sequence — "LIFE.OS v2.0 kernel loaded",
"Initializing Cyber-Zen subsystems...", "Scripture engine: ready" —
presented as live telemetry. It was a random quote generator wearing a
terminal costume.

`scripts/read-refresh-journal.js` reads the real history from the
systemd journal (`journalctl --user -u lifeos-refresh.service -o json`),
folds the flat log lines into run records, and writes a plain-text copy
to `~/.config/lifeos/refresh-history.log` so the history survives journal
rotation and the fetcher does not depend on `journalctl` existing.

`vibes.json` carries it as `pi_status.refresh`:

```js
pi_status.refresh = {
  source: 'systemd journal',
  runs: [ { started_at, duration_s, outcome, summary, error } ],
  last_run: { ... },
}
```

Each run renders as one line — `17:07:33 > [OK] 102s published to Gist
and committed to repo` — and the status line reflects the last real run
("Last Refresh Failed", "Refresh In Progress", "All Systems Nominal")
rather than a hardcoded phrase.

Fingerprint interaction: the history is a rolling window that changes
every cycle, so the fingerprint keeps only `last_run.outcome` and
`last_run.error`. A refresh that fetched fine but then failed to publish
is a real incident and must change the hash.

### Tests

```bash
node scripts/test-fingerprint.js            # 26 checks: noise vs real changes
node scripts/test-health-render-logic.js    # 39 checks: renders real main.js functions
node scripts/test-context-reading.js        # 16 checks: current context vs lifetime tokens
node scripts/test-refresh-journal.js        # 27 checks: journal folding + System Activity renderer
node scripts/test-main-loads.js             #  9 checks: main.js loads without throwing
bash scripts/test-skip-noop.sh              # a noise-only refresh -> no commit, no push
node scripts/probe-agent-roles.js           # shows the role parsed from each SOUL.md
```

`test-health-render-logic.js` extracts the real functions from `main.js`
with a brace matcher and runs them against a fake DOM, so it cannot drift
away from the code it tests. `test-context-reading.js` does the same for
`readCurrentContext` in `fetch-feeds.js`.

`test-main-loads.js` runs the whole of `main.js` in a `vm` sandbox with a
stub DOM and asserts it loads without throwing. This exists because
`node --check` is not enough: deleting a constant but leaving one
reference to it makes the page throw a ReferenceError at load and render
**nothing**, while the file still passes a syntax check.

`test-skip-noop.sh` runs against a **temporary copy** of the repo, never
the live working tree. An earlier version stubbed the fetcher in place,
and the 30-minute timer fired while the stubs were installed — the
scheduled run used the stub and the real Gist silently stopped receiving
data. `scripts/require-clean-tree.sh` now refuses to run a test against a
dirty working tree, so a test can never be blamed for work that was
already in progress.

`scripts/refresh.sh` takes an `flock`, so a slow run and the next timer
tick cannot overlap.

## Monitoring

```bash
systemctl --user status lifeos-refresh.timer
journalctl --user -u lifeos-refresh.service -f
systemctl --user list-timers lifeos-refresh.timer
```

A failed run exits non-zero and fires a desktop notification — the point is
that a stalled refresh can never be silent again. That is exactly the failure
that left this dashboard frozen on February 2026 data for eight months.

## Manual run

```bash
bash scripts/refresh.sh              # full run (fetch + publish + commit)
bash scripts/refresh.sh --no-commit  # fetch + publish only
node fetch-feeds.js --dry-run        # fetch only, no publish
```

## Credentials

The `gh` CLI stores its OAuth token in the **login keyring**, which a timer
running without a graphical session cannot reliably read (PAM unlocks it at
login). So the token is materialised into `~/.config/lifeos/lifeos.env` with
mode 0600.

Re-provision it after any `gh auth login` / token rotation:

```bash
bash scripts/setup-refresh-token.sh
```

The script verifies the token can actually read the Gist before writing it.

The token is passed to `gh` via the `GH_TOKEN` environment variable, never
as a command-line argument — argv is readable from `/proc` by any user, and
error messages would echo it into the journal.

## Why SSH for the repo push

The `gh` OAuth token lacks the `workflow` scope, so GitHub refuses HTTPS
pushes that add or modify `.github/workflows/*`. The remote is therefore
`git@github.com:ccardow/pi-dashboard.git`.

## Two live deployments

Both read the same Gist, so the *data* is identical on each:

- **Vercel** — `https://pi-dashboard-delta.vercel.app/` (the original URL)
- **GitHub Pages** — `https://ccardow.github.io/pi-dashboard/`

Both rebuild on every push that reaches `master`. The bot only commits when
the content fingerprint changes, so a quiet cycle produces no rebuild on
either one.

## Adding feeds

Edit `feeds-config.json` — YouTube channels, X handles, location. YouTube
channel IDs come from `youtube.com/channel/<id>`; X handles need a Nitter
mirror that serves them (see `probe-mirrors.js`).
