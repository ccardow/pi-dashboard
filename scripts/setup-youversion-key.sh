#!/usr/bin/env bash
# Provision a YouVersion Platform App Key for the LIFE.OS refresh timer.
#
# The key is read from a hidden prompt so it never passes through the
# shell history, an argument list, or a chat transcript. It is written
# into the same 0600 credential file the refresh timer already sources,
# and verified against the live API before being trusted.
#
# Note: YouVersion's own documentation states that app keys are not
# secrets. This is still the right place for it — the timer needs it on
# disk, and the credential file is already excluded from the repo.
#
# Safe to re-run: it MERGES with the existing file rather than
# overwriting it, so the Gist token survives.
#
# Usage: bash scripts/setup-youversion-key.sh
set -euo pipefail

ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/lifeos"
ENV_FILE="$ENV_DIR/lifeos.env"
API="https://api.youversion.com"

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

echo "Paste your YouVersion App Key (input is hidden):"
printf '  App Key: '
read -r -s APP_KEY
echo
printf '  Bible version id [3034 = Berean Standard Bible, public domain]: '
read -r BIBLE_ID
BIBLE_ID="${BIBLE_ID:-3034}"

if [ -z "$APP_KEY" ]; then
    echo "ERROR: no key entered." >&2
    exit 1
fi

# ── Verify the key actually works ──
# Check the Verse of the Day endpoint AND the passage endpoint, because a
# key can authenticate while lacking access to a specific Bible version.
echo "Verifying the key against $API ..."

VOTD_CODE="$(curl -s -o /tmp/yvp-votd.json -w '%{http_code}' \
    -H "X-YVP-App-Key: $APP_KEY" \
    -H 'Accept: application/json' \
    "$API/v1/verse-of-the-days/1")"

if [ "$VOTD_CODE" != "200" ]; then
    echo "ERROR: the verse-of-the-days endpoint returned HTTP $VOTD_CODE." >&2
    sed -n '1,5p' /tmp/yvp-votd.json 2>/dev/null | sed 's/^/  /' >&2
    echo "  Check the key at https://platform.youversion.com" >&2
    rm -f /tmp/yvp-votd.json
    exit 1
fi

PASSAGE_ID="$(python3 -c "
import json
try:
    print(json.load(open('/tmp/yvp-votd.json')).get('passage_id') or '')
except Exception:
    print('')
")"
rm -f /tmp/yvp-votd.json

if [ -z "$PASSAGE_ID" ]; then
    echo "ERROR: the verse-of-the-days response had no passage_id." >&2
    exit 1
fi

echo "  verse-of-the-days: OK (day 1 -> $PASSAGE_ID)"

PASSAGE_CODE="$(curl -s -o /tmp/yvp-passage.json -w '%{http_code}' \
    -H "X-YVP-App-Key: $APP_KEY" \
    -H 'Accept: application/json' \
    "$API/v1/bibles/$BIBLE_ID/passages/$PASSAGE_ID?format=text")"

if [ "$PASSAGE_CODE" != "200" ]; then
    echo "WARNING: Bible version $BIBLE_ID returned HTTP $PASSAGE_CODE for a passage." >&2
    echo "  The key works, but this version may not be available to your app." >&2
    echo "  List what you have access to:" >&2
    echo "    curl -s -H \"X-YVP-App-Key: \$YVP_APP_KEY\" \\" >&2
    echo "      '$API/v1/bibles?language_ranges[]=en&fields[]=id&fields[]=abbreviation&page_size=*'" >&2
    rm -f /tmp/yvp-passage.json
else
    ATTRIB="$(python3 -c "
import json
try:
    d = json.load(open('/tmp/yvp-passage.json'))
    print((d.get('reference') or '') + ' | ' + (d.get('content') or '')[:60])
except Exception:
    print('')
")"
    echo "  passage text: OK ($ATTRIB)"
    rm -f /tmp/yvp-passage.json
fi

# Also confirm the attribution metadata we must display is present.
META_CODE="$(curl -s -o /tmp/yvp-meta.json -w '%{http_code}' \
    -H "X-YVP-App-Key: $APP_KEY" \
    -H 'Accept: application/json' \
    "$API/v1/bibles/$BIBLE_ID")"
if [ "$META_CODE" = "200" ]; then
    ABBR="$(python3 -c "
import json
try:
    d = json.load(open('/tmp/yvp-meta.json'))
    print(d.get('abbreviation', '?') + ' — ' + d.get('title', '?'))
except Exception:
    print('?')
")"
    echo "  version metadata: OK ($ABBR)"
else
    echo "  version metadata: HTTP $META_CODE (attribution may be unavailable)"
fi
rm -f /tmp/yvp-meta.json

# ── Merge into the credential file ──
# Rewrite the file, preserving every other key. The old script used `>`,
# so running it again would have wiped GIST_TOKEN.
touch "$ENV_FILE"

# Remember what was there before, so we can say whether anything actually
# changed. YouVersion has no key-rotation flow — a new key comes from
# creating a new app — so it is easy to re-run this with the same key
# and believe you rotated when you did not. Say so plainly.
PREVIOUS_KEY="$(grep -m1 '^YVP_APP_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"

TMP_FILE="$(mktemp)"
chmod 600 "$TMP_FILE"

# Copy every existing line except the ones we are about to set.
grep -v -E '^(YVP_APP_KEY|YVP_BIBLE_ID)=' "$ENV_FILE" > "$TMP_FILE" || true

{
    echo "YVP_APP_KEY=$APP_KEY"
    echo "YVP_BIBLE_ID=$BIBLE_ID"
} >> "$TMP_FILE"

mv "$TMP_FILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo
echo "Wrote $ENV_FILE (mode $(stat -c '%a' "$ENV_FILE"))"
echo "  YVP_APP_KEY set, YVP_BIBLE_ID=$BIBLE_ID"
if [ -n "$PREVIOUS_KEY" ] && [ "$PREVIOUS_KEY" = "$APP_KEY" ]; then
    echo "  NOTE: the key is UNCHANGED from the previous value."
    echo "        YouVersion does not rotate keys in place — a new key comes from"
    echo "        creating a NEW app in the Developer Dashboard. If you intended to"
    echo "        rotate, create a new app, then run this again with its key."
elif [ -n "$PREVIOUS_KEY" ]; then
    echo "  The key has CHANGED from the previous value."
fi
echo "  Existing credentials preserved:"
grep -o -E '^[A-Z_]+=' "$ENV_FILE" | tr -d '=' | sed 's/^/    /'
