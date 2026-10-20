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

### The daily verse comes from YouVersion

The verse card used to show a date-seeded random pick from bible-api.com.
It now prefers **YouVersion's editorial "Verse of the Day"** — the verse
their own Bible App shows. It is curated, and it changes on its own.

Three calls, because the verse-of-the-day endpoint returns only a
reference, not text:

```
GET /v1/verse-of-the-days/{day}     -> { passage_id }
GET /v1/bibles/{id}/passages/{pid}  -> { content, reference }
GET /v1/bibles/{id}                 -> { abbreviation, copyright }
```

The third call exists because **YouVersion requires attribution** when
Bible text is displayed. Their own SDK fails rather than return a display
model with no usable attribution, so the card renders the version
abbreviation and its copyright line.

```bash
# Provision the app key (hidden prompt, verified against the live API)
bash scripts/setup-youversion-key.sh
```

To try the key WITHOUT saving it first:

```bash
bash scripts/check-youversion-key.sh
```

That reads the key from a hidden prompt, writes nothing, and shows the
verse it would fetch, the translation, the attribution line, and every
English version the key can reach. Run it as many times as you like.

The key lands in `~/.config/lifeos/lifeos.env` as `YVP_APP_KEY`, next to
`GIST_TOKEN`. The setup script **merges** rather than overwrites, so the
Gist token survives.

`YVP_BIBLE_ID` selects the translation. The default and the decision is
**3034 — the Berean Standard Bible**: public domain, so it needs no
licence agreement, and the key reaches it out of the box. KJV (id `1`)
is also available to most keys if the preference changes; the
`check-youversion-key.sh` listing shows what a given key can actually
reach.

The attribution line on the card is the requirement that decides the
card's look: YouVersion requires the version abbreviation and its
copyright line whenever Bible text is displayed. For BSB that copyright
is about 160 characters, so it is rendered small, muted, and under a
dotted rule rather than as a second headline.

**The day of the year must be local, not UTC.** At 17:00 in Abbotsford it
is already the next day in UTC, so a UTC-based day number shows tomorrow's
verse every evening. `dayOfYearInZone()` uses the location's timezone.

bible-api.com remains the fallback, so a missing key or an outage
degrades rather than losing the card. The verse's health entry reports
which source actually served it.

### The remote is synced BEFORE the commit

The GitHub Actions workflow also commits the generated data files to this
branch, every two hours. When it pushes first, the local branch is behind
and `git push` is rejected as a non-fast-forward.

`refresh.sh` now syncs **before** committing, so the commit lands on top
of the current remote head and the push is always a fast-forward:

```bash
git fetch origin master
git reset --mixed origin/master   # moves HEAD+index, leaves the worktree alone
```

Two guards, both learned the hard way:

- The sync only runs when the fetch actually produced a usable
  `origin/master`. A failed fetch must not be read as "the remote moved".
- If the local-only commits touch anything other than the generated data
  files, the sync **refuses** and says to push first. A `reset --mixed`
  would move HEAD back and drop those commits from the branch — the
  working tree keeps the changes, but the commits vanish from the
  history. That happened once.

The push error message also reports the **actual** reason. It used to say
"is the SSH key authorised for this repo?" for every failure, which sent
the diagnosis in the wrong direction for a non-fast-forward rejection.

### The Actions workflow is a canary, not a publisher

It used to commit the fetched data to the repo every two hours. That did
three harmful things:

1. **It committed a worse verse.** The runner has no `YVP_APP_KEY`, so
   it fell back to the random bible-api.com pick and overwrote the
   curated YouVersion verse in the repo copy — which is the client's
   fallback when the Gist is unreachable.
2. **It raced the local timer.** When the bot pushed first, the timer's
   push was rejected as a non-fast-forward, which failed the run.
3. **It triggered redundant rebuilds** for data that was not better than
   what was already published.

It now fetches, checks the result, and uploads it as an artifact. It
never touches the branch, and its permissions are `contents: read`.

The local timer is the only publisher, because it is the only one that
can read `~/.hermes/state.db` and `gateway_state.json` — a CI runner
literally cannot produce a correct `pi_status`.

What it is still good for: proving the fetch pipeline works from a clean
checkout, on a schedule, on a machine that is not Cam's.

### A fallback is not a live feed

The verse card has a fallback source: YouVersion's curated Verse of the
Day, and bible-api.com's random pick. When the primary source fails and
the fallback serves the card, the health entry is `status: 'fallback'` —
a third state, distinct from `live` and from `stale`:

- The data **is** fresh, so `fetched_at` is set and the card does not
  look stale.
- But the primary source did not serve it, so the strip shows amber and
  the verdict reads `1 FALLBACK` instead of `ALL LIVE`.
- The card names the translation in the reference line
  (`1 Corinthians 13:6 · BSB`), so a stand-in is distinguishable from the
  real thing even at a glance.

"ALL LIVE" would be a lie when the primary source failed. This is the
same failure class as the frozen Psalm 116, one level up: a graceful
fallback that hides a degraded result.

### The X fetch has a wall-clock deadline

The mirror list is fragile — 1 of 4 Nitter mirrors was serving at the
time of writing. The retry structure is 10 handles × 4 mirrors × 3
attempts, each able to burn the full 8 second request timeout. A run
with the mirrors all down took **32 minutes**, long enough to block
every later cycle.

`X_FETCH_DEADLINE_MS` (default 180000) caps the whole X fetch. When it
expires the loop stops trying mirrors and returns what it has. Losing
the remaining handles beats stalling the pipeline.

### systemd's start timeout needs a daemon-reload

`TimeoutStartSec=600` on the `lifeos-refresh.service` unit **is**
enforced — a probe unit with a 15 second timeout was killed with
`status=15/TERM` as expected.

But a 32-minute run got through it. The cause: the unit file on disk
had the timeout, but **systemd was still running the older version in
memory** because the unit had not been reloaded after the edit.

```bash
systemctl --user daemon-reload    # after ANY edit to the unit file
```

The X deadline above is the belt to that braces: the pipeline should not
depend on a systemd timeout to stay bounded.

### Nothing reaches the public payload

The Gist, the repository and both static hosts are public. A credential
that reaches the payload reaches the world.

`scripts/require-no-credentials.sh` reads the secret values from
`~/.config/lifeos/lifeos.env` at run time (the script never contains a
credential itself) and refuses if any of them appear in:

- a tracked working-tree file
- the commit about to be pushed
- the commits that differ from the remote
- a commit message
- `vibes.json` or `vibes.js` — the files that actually get published

`refresh.sh` runs it immediately before the push, so the machine catches
the mistake rather than someone's memory. A leak fails the run and
nothing is published.

```bash
bash scripts/require-no-credentials.sh   # check right now
bash scripts/test-credential-guard.sh     # 6 checks: prove it catches leaks
```

The test injects each secret into a tracked file, a commit and a commit
message, in a sandbox copy with its own credential file, and asserts the
guard refuses every time. A guard that always says "clean" would be
worse than no guard.

### Tests

```bash
node scripts/test-fingerprint.js            # 26 checks: noise vs real changes
node scripts/test-health-render-logic.js    # 39 checks: renders real main.js functions
node scripts/test-context-reading.js        # 16 checks: current context vs lifetime tokens
node scripts/test-refresh-journal.js        # 27 checks: journal folding + System Activity renderer
node scripts/test-main-loads.js             #  9 checks: main.js loads without throwing
node scripts/test-verse.js                  # 16 checks: YouVersion verse path vs a mock API
node scripts/test-check-youversion-key.js   # 15 checks: the key checker, bad key + good key
bash scripts/test-skip-noop.sh              #  4 checks: a noise-only refresh -> no commit
bash scripts/test-credential-guard.sh       #  6 checks: the credential guard catches leaks
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
