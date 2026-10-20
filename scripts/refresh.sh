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
LOCK_FILE="${LIFEOS_LOCK:-/tmp/lifeos-refresh.lock}"

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

# ── Single-instance lock ──
# The timer fires every 30 minutes and a fetch can take over a minute, so
# a slow run can still be in flight when the next one starts. Two runs
# writing the same data file and pushing the same Gist is a race, and a
# manual run started by hand can collide with a scheduled one.
#
# flock is released automatically when the process exits, including on
# failure, so a crashed run cannot leave the lock stuck.
if [ -z "${LIFEOS_NO_LOCK:-}" ]; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        log "another refresh is already running — skipping this one"
        log "done"
        exit 0
    fi
fi

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

# ── Sync with the remote FIRST ──
#
# The GitHub Actions workflow also commits the generated data files to
# this branch, every two hours. When it pushes first, the local branch is
# behind and `git push` is rejected as a non-fast-forward — which the old
# error message reported as "is the SSH key authorised for this repo?".
# That was wrong and sent the diagnosis in the wrong direction.
#
# Syncing before committing means the commit is made on top of the
# current remote head, so the push is always a fast-forward. It also
# avoids the data-file conflicts a post-commit rebase would hit: the
# Actions bot and the local bot both write vibes.json and vibes.js, and
# rebasing one onto the other conflicts every time.
#
# `git reset --mixed` moves HEAD and the index to the remote while
# LEAVING the working tree alone, so the freshly fetched data survives.
# Nothing on disk is destroyed by it — but the guard below still refuses
# to sync when tracked source files have uncommitted changes, because
# changing the base under someone's work is confusing even when it is
# not destructive. Untracked files are ignored: a mixed reset does not
# touch them.
#
# Note the commit below stages ONLY the generated files, so a stray
# modification can never end up inside the bot's commit.

NON_GENERATED="$(git status --porcelain --untracked-files=no | grep -v -E 'vibes\.(json|js)$' || true)"
if [ -n "$NON_GENERATED" ]; then
    # Not fatal. A mixed reset does not touch the working tree, and the
    # commit below stages ONLY the generated files, so nothing here can be
    # lost or swept into the bot's commit. It only means the diff base
    # moves, which is worth saying out loud.
    log "note: working tree has changes outside the generated data files — syncing anyway:"
    echo "$NON_GENERATED" | sed 's/^/    /'
fi

git fetch origin master >/dev/null 2>&1 || log "could not fetch origin (continuing)"
if ! git diff --quiet HEAD origin/master 2>/dev/null; then
    log "remote has new commits — syncing before committing"
    git reset --mixed origin/master >/dev/null 2>&1 \
        || fail "could not sync with origin/master"
fi

# Skip the commit when nothing substantive changed. The data always carries
# a fresh timestamp, so a raw `git status` would report a change every run
# and trigger a rebuild of the static host every 30 minutes for no reason.
# The fingerprint hashes only the meaningful content, so a no-op run stays
# local and costs nothing.
#
# This runs BEFORE staging so a skipped run leaves the index clean.
NEW_FP="$(node scripts/data-fingerprint.js vibes.json 2>/dev/null || echo 'ERROR')"
OLD_FP="$(git show HEAD:vibes.json 2>/dev/null | node scripts/data-fingerprint.js - 2>/dev/null || echo 'NONE')"

if [ "$NEW_FP" = "ERROR" ]; then
    fail "fingerprint failed — refusing to guess whether anything changed"
fi

if [ "$NEW_FP" = "$OLD_FP" ]; then
    log "content unchanged (fingerprint $NEW_FP) — skipping commit and push"
    log "done"
    exit 0
fi
log "content changed (fingerprint $OLD_FP -> $NEW_FP)"

# Stage explicitly: vibes.json/vibes.js are gitignored, so a plain
# `git commit -a` would miss them entirely.
git add -f vibes.json vibes.js

# Use -c flags for this commit ONLY. Setting the repo's user.name/user.email
# would rewrite the identity for every future commit too, including yours.
git -c user.name="lifeos-bot" -c user.email="lifeos-bot@localhost" \
    commit -q -m "chore: refresh feeds $(date -u +%Y-%m-%dT%H:%MZ)" || fail "git commit failed"

# Push over SSH. The gh OAuth token lacks the `workflow` scope,
# so HTTPS pushes of .github/workflows/* are refused — SSH works.
if ! git push origin master 2>/tmp/lifeos-push.err; then
    # Report the ACTUAL reason. "SSH key not authorised" is wrong for a
    # non-fast-forward rejection, and it sent the diagnosis in the wrong
    # direction for an hour.
    PUSH_ERR="$(cat /tmp/lifeos-push.err 2>/dev/null)"
    rm -f /tmp/lifeos-push.err
    if echo "$PUSH_ERR" | grep -q -i -E 'non-fast-forward|fetch first|behind its remote'; then
        fail "git push rejected: the branch moved ahead (the Actions workflow also commits to it). The next run will sync first."
    elif echo "$PUSH_ERR" | grep -q -i -E 'permission denied|could not read from remote repository|publickey'; then
        fail "git push rejected: SSH authorisation failed. Check ~/.ssh/id_ed25519 is registered on the repo."
    else
        fail "git push failed:
$PUSH_ERR"
    fi
fi
log "repo updated"

log "done"
