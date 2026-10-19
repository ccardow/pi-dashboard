#!/usr/bin/env bash
# Verify the refresh script's skip path: when the fetched data differs from
# HEAD only in volatile fields, no commit is created and no push happens.
#
# ═══ IMPORTANT: this test runs against a COPY of the repo ═══
#
# The first version of this test stubbed fetch-feeds.js and push-to-gist.js
# in the live working tree. The 30-minute timer fired while the stubs were
# installed, so the scheduled run used the stubs instead of the real
# fetcher — the Gist silently stopped receiving real data and nobody
# noticed until the live dashboard showed "no health data".
#
# Now the whole thing runs in a temporary copy: the live repo is never
# modified, the real Gist is never touched, and the timer cannot collide
# with the test. The copy has its own lock file and a remote that points
# nowhere, so a commit in it can never reach the real repository.
set -uo pipefail

REAL_REPO="/home/cam/work/pi-dashboard"
cd "$REAL_REPO" || exit 1

# Refuse to run against a dirty working tree. A test that modifies the live
# repo can destroy uncommitted work, and a dirty tree makes it impossible to
# tell which changes the test caused. (This is not hypothetical — the first
# version of this test reverted an uncommitted fetch-feeds.js.)
bash scripts/require-clean-tree.sh "test-skip-noop.sh" || exit 1

SANDBOX="$(mktemp -d /tmp/lifeos-skiptest-XXXXXX)"

cleanup() {
    rm -rf "$SANDBOX"
}
trap cleanup EXIT

# ── Build the sandbox ──
cp -a "$REAL_REPO" "$SANDBOX/repo" 2>/dev/null
cd "$SANDBOX/repo" || { echo "could not create sandbox"; exit 1; }

# Point the runner at the sandbox, with its own lock and no credential file
# (the Gist push is stubbed, so no token is needed).
export LIFEOS_REPO="$SANDBOX/repo"
export LIFEOS_LOCK="$SANDBOX/refresh.lock"
export LIFEOS_NO_LOCK=1
export XDG_CONFIG_HOME="$SANDBOX/config"
mkdir -p "$XDG_CONFIG_HOME"

# The copy must never be able to push to the real remote.
git remote remove origin 2>/dev/null || true
git remote add origin "$SANDBOX/nowhere.git"

BEFORE_COMMIT="$(git rev-parse HEAD)"

# ── Establish the baseline ──
# The working data file must equal HEAD's committed data, or the fingerprint
# comparison would legitimately detect a real change and the test would be
# measuring the wrong thing.
git show HEAD:vibes.json > vibes.json

HEAD_FP="$(git show HEAD:vibes.json | node scripts/data-fingerprint.js -)"
echo "HEAD fingerprint:    $HEAD_FP"

# ── Stub the fetcher ──
# Mutates only volatile fields in the current vibes.json.
cat > fetch-feeds.js <<'STUB'
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('vibes.json', 'utf8'));
d.lastUpdate = '10/19/2026, 09:99 PM';
d.weather.updated = 'Oct 19, 09:99 PM';
d.pi_status.lastUpdate = 'Oct 19, 09:99 PM';
d.pi_status.model.tokens_used = 99999;
d.pi_status.gateway.uptime_seconds = 88888;
d.pi_status.totals.input_tokens = 1;
d.pi_status.totals.output_tokens = 2;
d.pi_status.totals.tool_calls = 3;
for (const l of (d.pi_status.logs || [])) l.time = '99:99';
for (const r of (d.pi_status.roadmap || [])) {
    if (r.name === 'Hermes Gateway') r.status = 'running · v0.22.2 · pid 99999';
    if (r.name === 'Session Ledger') r.status = '99 sessions · 999k tokens · 999 tool calls';
}
// Health timestamps move on every run and must not count as a change.
for (const key of Object.keys(d.feed_health || {})) {
    const e = d.feed_health[key];
    if (e && typeof e === 'object') {
        e.fetched_at = '2099-01-01T00:00:00.000Z';
        e.age_min = 999;
    }
}
fs.writeFileSync('vibes.json', JSON.stringify(d, null, 2));
console.log('stub: wrote vibes.json with only volatile fields changed');
STUB

# Stub the Gist push so the real Gist is never touched.
cat > push-to-gist.js <<'STUB'
console.log('stub: Gist push skipped for this test');
STUB

# Run the stub once to confirm the baseline is right.
node fetch-feeds.js >/dev/null 2>&1
STUB_FP="$(node scripts/data-fingerprint.js vibes.json)"
echo "stub fingerprint:   $STUB_FP"
echo

echo "--- running refresh.sh with a noise-only fetch ---"
OUT="$(bash scripts/refresh.sh 2>&1)"
echo "$OUT" | grep -E 'lifeos-refresh\]'

AFTER_COMMIT="$(git rev-parse HEAD)"

echo
echo "--- results ---"
FAIL=0
if [ "$HEAD_FP" = "$STUB_FP" ]; then
    echo "  PASS  stub output is content-identical to HEAD (baseline is correct)"
else
    echo "  FAIL  baseline wrong: stub output differs from HEAD"; FAIL=1
fi
if echo "$OUT" | grep -q 'skipping commit and push'; then
    echo "  PASS  script reported the skip"
else
    echo "  FAIL  script did not report a skip"; FAIL=1
fi
if [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ]; then
    echo "  PASS  no new commit created"
else
    echo "  FAIL  commit was created ($BEFORE_COMMIT -> $AFTER_COMMIT)"; FAIL=1
fi
if git log --oneline origin/master 2>/dev/null | grep -q "$AFTER_COMMIT"; then
    echo "  FAIL  the commit reached a remote"
else
    echo "  PASS  no remote received the commit"
fi

echo
[ "$FAIL" = "0" ] && echo "PASS — a noise-only refresh produces no commit and no deploy." || echo "FAIL"
exit $FAIL
