#!/usr/bin/env bash
# Guard: the working tree must be clean before a test run.
#
# A test that modifies the live repo can destroy uncommitted work. That
# actually happened: scripts/test-skip-noop.sh stubbed fetch-feeds.js in the
# working tree, and its cleanup ran `git checkout -- fetch-feeds.js` AFTER
# restoring the backup — which silently reverted uncommitted changes to a
# file that had never been committed. The work was gone.
#
# This check refuses to run a test when the tree is dirty, so a test can
# never be blamed for work that was already in progress. Tests that need to
# modify files should run against a COPY (see scripts/test-skip-noop.sh).
#
#   bash scripts/require-clean-tree.sh [test-name]

set -uo pipefail

REPO="${LIFEOS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TEST_NAME="${1:-this test}"

cd "$REPO" || { echo "FAIL: cannot cd to $REPO"; exit 1; }

# Not a git repo is an error, not a clean tree. `git status` prints nothing
# to stdout when it fails, which would otherwise look like "clean".
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "FAIL: $REPO is not a git repository — cannot check the working tree."
    exit 1
fi

# The generated data files are expected to be dirty after a fetch — they are
# committed by the bot, not by hand. Only source files matter here.
DIRTY="$(git status --porcelain -- ':!vibes.json' ':!vibes.js')"

if [ -n "$DIRTY" ]; then
    echo "FAIL: refusing to run $TEST_NAME with an unclean working tree."
    echo
    echo "Uncommitted changes:"
    echo "$DIRTY" | sed 's/^/  /'
    echo
    echo "Commit or stash them first. A test that modifies the live repo can"
    echo "destroy uncommitted work, and a dirty tree makes it impossible to"
    echo "tell which changes the test caused."
    exit 1
fi

echo "OK: working tree is clean (generated data files excluded)."
exit 0
