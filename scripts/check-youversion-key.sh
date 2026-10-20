#!/usr/bin/env bash
# Check a YouVersion App Key WITHOUT saving it.
#
# The setup script writes the key to disk. This one does not — it reads a
# key from a hidden prompt, uses it, and shows you what the dashboard
# would actually display. Nothing is written, so you can run it as many
# times as you like and nothing is committed to the machine.
#
# It shows:
#   - whether the key authenticates
#   - the verse of the day it would fetch, in the dashboard's timezone
#   - the translation and the attribution line that must be displayed
#   - which English Bible versions the key can actually reach
#
# Usage: bash scripts/check-youversion-key.sh
set -uo pipefail

API="${YVP_API:-https://api.youversion.com}"
TZ_NAME="${YVP_TZ:-America/Vancouver}"

printf 'Paste your YouVersion App Key (input is hidden): '
read -r -s APP_KEY
echo
if [ -z "$APP_KEY" ]; then
    echo "ERROR: no key entered." >&2
    exit 1
fi

yvp() {
    curl -s -H "X-YVP-App-Key: $APP_KEY" -H 'Accept: application/json' "$API$1"
}

# ── 1. Does the key authenticate? ──
echo
echo "── 1. authentication ──"
VOTD_RAW="$(yvp '/v1/verse-of-the-days/1')"
if echo "$VOTD_RAW" | grep -q 'InvalidApiKey\|FailedToResolveAPIKey\|Unauthorized'; then
    echo "  FAIL  the key was rejected:"
    echo "$VOTD_RAW" | head -3 | sed 's/^/        /'
    echo "  Check it at https://platform.youversion.com"
    exit 1
fi
PASSAGE_ID="$(printf '%s' "$VOTD_RAW" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('passage_id') or '')
except Exception: print('')
")"
if [ -z "$PASSAGE_ID" ]; then
    echo "  FAIL  the key authenticated but the verse-of-the-day response had no passage_id:"
    echo "$VOTD_RAW" | head -3 | sed 's/^/        /'
    exit 1
fi
echo "  PASS  the key authenticates"

# ── 2. The day of the year, local vs UTC ──
echo
echo "── 2. the day of the year ──"
DAY_LOCAL="$(python3 -c "
import datetime, zoneinfo
d = datetime.datetime.now(zoneinfo.ZoneInfo('$TZ_NAME'))
print(d.timetuple().tm_yday)
")"
DAY_UTC="$(python3 -c "
import datetime
print(datetime.datetime.now(datetime.timezone.utc).timetuple().tm_yday)
")"
echo "  local ($TZ_NAME): day $DAY_LOCAL"
echo "  UTC              : day $DAY_UTC"
if [ "$DAY_LOCAL" != "$DAY_UTC" ]; then
    echo "  note: they differ RIGHT NOW — a UTC-based day number would show the wrong verse."
else
    echo "  (they agree at this hour; they differ after 17:00 local)"
fi

# ── 3. The verse itself ──
echo
echo "── 3. the verse the card would show ──"
for BIBLE in "${YVP_BIBLE_ID:-3034}"; do
    META="$(yvp "/v1/bibles/$BIBLE")"
    ABBR="$(printf '%s' "$META" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print(d.get('abbreviation','?'))
except Exception: print('?')")"
    TITLE="$(printf '%s' "$META" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print(d.get('title','?'))
except Exception: print('?')")"
    COPYRIGHT="$(printf '%s' "$META" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print((d.get('copyright') or d.get('promotional_content') or '').strip())
except Exception: print('')")"

    echo "  Bible id $BIBLE — $ABBR ($TITLE)"
    if [ "$ABBR" = "?" ]; then
        echo "  FAIL  no metadata for this version. The key may not have access to it."
        continue
    fi
    if [ -z "$COPYRIGHT" ]; then
        echo "  FAIL  no attribution available — YouVersion requires it, so the card would show nothing."
        continue
    fi

    PASS="$(yvp "/v1/bibles/$BIBLE/passages/$PASSAGE_ID?format=text")"
    printf '%s' "$PASS" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print('  reference : ' + (d.get('reference') or '?'))
    print('  text      : ' + (d.get('content') or '')[:400])
except Exception as e:
    print('  FAIL  could not read the passage: ' + str(e))
"
    echo "  attribution (must be displayed):"
    echo "      $COPYRIGHT"
    echo
    echo "  On the card that reads:"
    echo "      \"$(printf '%s' "$PASS" | python3 -c "
import json,sys
try: print((json.load(sys.stdin).get('content') or '')[:120])
except Exception: print('')")\""
    echo "      $(printf '%s' "$PASS" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('reference') or '')
except Exception: print('')")"
    echo "      $ABBR — $COPYRIGHT"
done

# ── 4. What else can this key reach? ──
echo
echo "── 4. English versions available to this key ──"
yvp '/v1/bibles?language_ranges[]=en&fields[]=id&fields[]=abbreviation&fields[]=title&page_size=*' \
| python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    rows = d.get('data', [])
    print('  %d versions:' % len(rows))
    for r in rows[:25]:
        print('    %-6s %-28s %s' % (r.get('id'), r.get('abbreviation') or '?', (r.get('title') or '')[:40]))
    if len(rows) > 25:
        print('    ... and %d more' % (len(rows) - 25))
except Exception as e:
    print('  (could not list versions: ' + str(e) + ')')
"

echo
echo "Nothing was written. When you are happy with the output, run:"
echo "    bash scripts/setup-youversion-key.sh"
