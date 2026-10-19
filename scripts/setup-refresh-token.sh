#!/usr/bin/env bash
# Provision a machine-readable GitHub token for the LIFE.OS refresh timer.
#
# The `gh` CLI keeps its OAuth token in the login keyring, which is only
# reliably readable from an interactive session. A systemd timer may run with
# no session at all, so we materialise the token into a 0600 file that the
# service can source.
#
# Safe to re-run: it refreshes the file in place.
set -euo pipefail

ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/lifeos"
ENV_FILE="$ENV_DIR/lifeos.env"
GIST_ID="${GIST_ID:-e65c6cfabb1fbc98983381da98801408}"

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

TOKEN="$(gh auth token)"
if [ -z "$TOKEN" ]; then
    echo "ERROR: 'gh auth token' returned nothing. Run 'gh auth login' first." >&2
    exit 1
fi

# Verify the token can actually reach the Gist before trusting it.
CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    "https://api.github.com/gists/$GIST_ID")"
if [ "$CODE" != "200" ]; then
    echo "ERROR: token cannot read the Gist (HTTP $CODE). Needs the 'gist' scope." >&2
    exit 1
fi

umask 077
{
    echo "# LIFE.OS refresh timer credentials. Mode 0600 — do not commit."
    echo "GIST_TOKEN=$TOKEN"
    echo "GIST_ID=$GIST_ID"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Wrote $ENV_FILE (mode $(stat -c '%a' "$ENV_FILE"))"
echo "Verified: token reads Gist $GIST_ID (HTTP $CODE)"
