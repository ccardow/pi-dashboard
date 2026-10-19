#!/usr/bin/env bash
# ═══════════════════════════════════════════════
#  LIFE.OS — local refresh runner
#
#  Runs the feed fetcher on this machine and publishes the
#  result. This is the ONLY place the Pi card can be filled
#  with live state, because it reads ~/.hermes/state.db and
#  gateway_state.json — local runtime state a CI runner
#  cannot see.
#
#  Publishes to:
#    1. The GitHub Gist  — the live source both the Vercel
#       and GitHub Pages sites read.
#    2. The repo        — committed over SSH, so the client
#       fallback (vibes.json) stays fresh and the static
#       host redeploys.
#
#  Usage: scripts/refresh.sh [--no-commit]
# ═══════════════════════════════════════════════
set -uo pipefail

REPO="${LIFEOS_REPO:-/home/cam/work/pi-dashboard}"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/lifeos/lifeos.env"
LOG_PREFIX="[lifeos-refresh]"

NO_COMMIT=0
for arg in "$@"; do
    [ "$arg" = "--no-commit" ] && NO_COMMIT=1
done

log() { echo "$LOG_PREFIX $*"; }
fail() {
    log "FAILED: $*"
    # Make a stalled refresh visible instead of silent.
    if command -v notify-send >/dev/null 2>&1; then
        notify-send "LIFE.OS refresh failed" "$*" --icon=dialog-error 2>/dev/null || true
    fi
    exit 1
}

cd "$REPO" || fail "cannot cd to $REPO"

# ── Credentials ──
# Sourced from a 0600 file so the job does not depend on the
# login keyring being unlocked (timers can run with no session).
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
else
    log "no credential file at $ENV_FILE — falling back to gh CLI auth"
fi

# ── Fetch ──
# --no-push: fetch-feeds.js would otherwise push the Gist itself, and
# refresh.sh pushes it again below. Publishing from one place keeps the
# log honest about what happened.
log "fetching feeds..."
if ! node fetch-feeds.js --no-push; then
    fail "fetch-feeds.js exited non-zero (see output above)"
fi

# ── Publish to the Gist ──
log "pushing to Gist..."
if ! node push-to-gist.js; then
    fail "push-to-gist.js failed — is the token valid and gist-scoped?"
fi
log "gist updated"

# ── Commit to the repo ──
# The Gist is the primary source; this keeps the committed
# fallback fresh and triggers a redeploy on the static host.
if [ "$NO_COMMIT" = "1" ]; then
    log "skipping commit (--no-commit)"
    log "done"
    exit 0
fi

if [ -z "$(git status --porcelain)" ]; then
    log "no changes to commit"
    log "done"
    exit 0
fi

log "committing refreshed data..."
git config user.name  "lifeos-bot" 2>/dev/null || true
git config user.email "lifeos-bot@localhost" 2>/dev/null || true
git add -f vibes.json vibes.js
git commit -q -m "chore: refresh feeds $(date -u +%Y-%m-%dT%H:%MZ)" || fail "git commit failed"

# Push over SSH. The gh OAuth token lacks the `workflow` scope,
# so HTTPS pushes of .github/workflows/* are refused — SSH works.
if ! git push origin master; then
    fail "git push failed (is the SSH key authorised for this repo?)"
fi
log "repo updated"

log "done"
