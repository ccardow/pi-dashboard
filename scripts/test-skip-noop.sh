#!/usr/bin/env bash
# Verify the refresh script's skip path: when the fetched data differs from
# HEAD only in volatile fields, no commit is created and no push happens.
#
# Stubs fetch-feeds.js so it rewrites vibes.json with ONLY the volatile
# fields changed — the exact situation a quiet 30-minute cycle produces.
set -uo pipefail

REPO="/home/cam/work/pi-dashboard"
cd "$REPO" || exit 1

BEFORE_COMMIT="$(git rev-parse HEAD)"
BEFORE_REMOTE="$(git ls-remote origin master | cut -f1)"

cp fetch-feeds.js /tmp/fetch-feeds.real.js
cp push-to-gist.js /tmp/push-to-gist.real.js

cleanup() {
    cp /tmp/fetch-feeds.real.js fetch-feeds.js
    cp /tmp/push-to-gist.real.js push-to-gist.js
    git checkout -- fetch-feeds.js push-to-gist.js 2>/dev/null || true
    rm -f /tmp/fetch-feeds.real.js /tmp/push-to-gist.real.js
}
trap cleanup EXIT

# Stub: mutate only volatile fields in the current vibes.json.
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
fs.writeFileSync('vibes.json', JSON.stringify(d, null, 2));
console.log('stub: wrote vibes.json with only volatile fields changed');
STUB

# Stub: don't touch the real Gist.
cat > push-to-gist.js <<'STUB'
console.log('stub: Gist push skipped for this test');
STUB

echo "--- running refresh.sh with a noise-only fetch ---"
OUT="$(bash scripts/refresh.sh 2>&1)"
echo "$OUT" | grep -E 'lifeos-refresh\]'

AFTER_COMMIT="$(git rev-parse HEAD)"
AFTER_REMOTE="$(git ls-remote origin master | cut -f1)"

echo
echo "--- results ---"
FAIL=0
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
if [ "$BEFORE_REMOTE" = "$AFTER_REMOTE" ]; then
    echo "  PASS  nothing pushed to the remote"
else
    echo "  FAIL  remote moved ($BEFORE_REMOTE -> $AFTER_REMOTE)"; FAIL=1
fi

echo
[ "$FAIL" = "0" ] && echo "PASS — a noise-only refresh produces no commit and no deploy." || echo "FAIL"
exit $FAIL
