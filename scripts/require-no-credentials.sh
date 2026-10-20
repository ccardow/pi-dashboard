#!/usr/bin/env bash
# Refuse to let a credential reach the published repository.
#
# The LIFE.OS dashboard publishes itself: the refresh timer fetches the
# data, pushes it to a public Gist, and commits it to a public GitHub
# repository that deploys to two public sites. Anything in that payload
# is public.
#
# The credential file at ~/.config/lifeos/lifeos.env holds values that
# must never be published — the Gist push token and the YouVersion app
# key. This script checks that none of them appear in:
#
#   - the tracked files of the working tree
#   - the commit that is about to be pushed
#   - the commits that differ from the remote
#   - the commit messages
#
# It is called by refresh.sh immediately before the push, so a mistake
# is caught by the machine rather than by someone's memory.
#
# Usage: bash scripts/require-no-credentials.sh
set -uo pipefail

ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/lifeos"
ENV_FILE="$ENV_DIR/lifeos.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "no credential file at $ENV_FILE — nothing to check"
    exit 0
fi

# Values that must never be published. Read from the file at run time so
# this script never contains a credential itself.
#
# The environment is checked as well as the file, so the same guard works
# on a CI runner that receives a credential as a secret rather than as a
# file. A value found in either place is treated as a secret.
SECRETS=()
SECRET_NAMES=()

add_secret() {
    local name="$1" value="$2"
    [ -z "$value" ] && return 0
    for existing in "${SECRETS[@]}"; do
        [ "$existing" = "$value" ] && return 0
    done
    SECRETS+=("$value")
    SECRET_NAMES+=("$name")
}

if [ -f "$ENV_FILE" ]; then
    while IFS='=' read -r name value; do
        case "$name" in
            YVP_APP_KEY|GIST_TOKEN)
                add_secret "$name" "$value"
                ;;
        esac
    done < "$ENV_FILE"
fi

# The same names from the environment, for CI.
add_secret "YVP_APP_KEY" "${YVP_APP_KEY:-}"
add_secret "GIST_TOKEN" "${GIST_TOKEN:-}"

if [ ${#SECRETS[@]} -eq 0 ]; then
    echo "no secret values found — nothing to check"
    exit 0
fi

FOUND=0
REPORT=""

for i in "${!SECRETS[@]}"; do
    secret="${SECRETS[$i]}"
    label="${SECRET_NAMES[$i]}"

    # The commit about to be pushed.
    if git grep -F -l -- "$secret" HEAD >/dev/null 2>&1; then
        hits="$(git grep -F -l -- "$secret" HEAD 2>/dev/null | head -5)"
        REPORT="${REPORT}  ${label} appears in HEAD:
$(echo "$hits" | sed 's/^/      /')
"
        FOUND=1
    fi

    # The commits that differ from the remote.
    if git rev-parse --verify origin/master >/dev/null 2>&1; then
        if git grep -F -l -- "$secret" "origin/master..HEAD" >/dev/null 2>&1; then
            hits="$(git grep -F -l -- "$secret" "origin/master..HEAD" 2>/dev/null | head -5)"
            REPORT="${REPORT}  ${label} appears in the commits being pushed:
$(echo "$hits" | sed 's/^/      /')
"
            FOUND=1
        fi
    fi

    # The working tree, including files not yet committed.
    if git ls-files -z 2>/dev/null | xargs -0 grep -F -l -- "$secret" >/dev/null 2>&1; then
        hits="$(git ls-files -z 2>/dev/null | xargs -0 grep -F -l -- "$secret" 2>/dev/null | head -5)"
        REPORT="${REPORT}  ${label} appears in a tracked working-tree file:
$(echo "$hits" | sed 's/^/      /')
"
        FOUND=1
    fi

    # Commit messages.
    if git log --format='%H %s%n%b' "origin/master..HEAD" 2>/dev/null | grep -F -q -- "$secret"; then
        REPORT="${REPORT}  ${label} appears in a commit message.
"
        FOUND=1
    fi

    # The generated payload specifically — this is what actually gets published.
    for f in vibes.json vibes.js; do
        if [ -f "$f" ] && grep -F -q -- "$secret" "$f" 2>/dev/null; then
            REPORT="${REPORT}  ${label} appears in $f — this file is published to the public Gist.
"
            FOUND=1
        fi
    done
done

if [ "$FOUND" -eq 1 ]; then
    echo "CREDENTIAL LEAK — refusing to push."
    echo "$REPORT"
    echo "Remove the value, rotate the credential, and try again."
    exit 1
fi

echo "credential check: clean (${#SECRETS[@]} secret value(s) checked, none present in the publish path)"
exit 0
