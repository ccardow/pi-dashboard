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

### Tests

```bash
node scripts/test-fingerprint.js   # 17 checks: noise vs real changes
bash scripts/test-skip-noop.sh     # a noise-only refresh -> no commit, no push
```

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
