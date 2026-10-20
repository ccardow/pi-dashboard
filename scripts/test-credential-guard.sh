#!/usr/bin/env bash
# Prove the credential guard actually catches a leak.
#
# A guard that always says "clean" is worse than no guard, because it
# buys false confidence. This injects each secret into a tracked file
# and in a sandbox copy, and asserts the guard refuses.
#
# Uses a temporary repository copy and a temporary credential file, so
# the live repo and the live credentials are never touched.
#
# Usage: bash scripts/test-credential-guard.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() {
    if [ "$1" = "0" ]; then
        pass=$((pass + 1)); echo "  PASS  $2"
    else
        fail=$((fail + 1)); echo "  FAIL  $2"
    fi
}

# ── A sandbox repo with its own credential file ──
cp -r "$REPO" "$TMP/repo" 2>/dev/null
cd "$TMP/repo" || { echo "could not copy the repo"; exit 1; }

# A credential file with values that mean nothing outside this test.
FAKE_KEY="test-yvp-key-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
FAKE_TOKEN="test-gist-token-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"

mkdir -p "$TMP/config/lifeos"
cat > "$TMP/config/lifeos/lifeos.env" <<EOF
GIST_TOKEN=$FAKE_TOKEN
GIST_ID=e65c6cfabb1fbc98983381da98801408
YVP_APP_KEY=$FAKE_KEY
YVP_BIBLE_ID=3034
EOF
chmod 600 "$TMP/config/lifeos/lifeos.env"

export XDG_CONFIG_HOME="$TMP/config"

echo "a clean tree must pass:"
bash scripts/require-no-credentials.sh >/dev/null 2>&1
check $? "the guard passes on a clean tree"

echo
echo "a leak in a tracked file must be caught:"
printf '{"leak":"%s"}\n' "$FAKE_KEY" > vibes.json
bash scripts/require-no-credentials.sh >/dev/null 2>&1
[ $? -ne 0 ]; check $? "the guard refuses when the app key is in a tracked file"

git checkout -- vibes.json 2>/dev/null
printf '{"leak":"%s"}\n' "$FAKE_TOKEN" > vibes.json
bash scripts/require-no-credentials.sh >/dev/null 2>&1
[ $? -ne 0 ]; check $? "the guard refuses when the Gist token is in a tracked file"

echo
echo "a leak in a commit message must be caught:"
git checkout -- vibes.json 2>/dev/null
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "oops $FAKE_KEY" 2>/dev/null
bash scripts/require-no-credentials.sh >/dev/null 2>&1
[ $? -ne 0 ]; check $? "the guard refuses when a commit message carries the key"
git reset -q --hard HEAD~1 2>/dev/null

echo
echo "a leak in a committed file must be caught:"
git checkout -- vibes.json 2>/dev/null
printf '{"leak":"%s"}\n' "$FAKE_KEY" > vibes.json
git add vibes.json
git -c user.name=t -c user.email=t@t commit -q -m "test commit" 2>/dev/null
bash scripts/require-no-credentials.sh >/dev/null 2>&1
[ $? -ne 0 ]; check $? "the guard refuses when the key is in a commit"

echo
echo "removing the leak restores the pass:"
git reset -q --hard HEAD~1 2>/dev/null
git checkout -- vibes.json 2>/dev/null
bash scripts/require-no-credentials.sh >/dev/null 2>&1
check $? "the guard passes again once the leak is gone"

cd "$REPO"
echo
if [ "$fail" -eq 0 ]; then
    echo "PASS — $pass checks, the guard catches every leak it was tested against."
    exit 0
fi
echo "FAIL — $pass passed, $fail failed."
exit 1
