#!/usr/bin/env node
// ═══════════════════════════════════════════════
//  Push vibes.json to the GitHub Gist that the live
//  dashboard reads from.
//
//  Auth: uses the `gh` CLI's own login by default
//  (works locally). In CI, set GIST_TOKEN to a PAT with
//  `gist` scope and it will be used instead.
// ═══════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIST_ID = process.env.GIST_ID || 'e65c6cfabb1fbc98983381da98801408';

const vibes = fs.readFileSync(path.join(__dirname, 'vibes.json'), 'utf8');
const payload = JSON.stringify({
    files: {
        'vibes.json': {
            content: vibes
        }
    }
});

// Write the payload to a temp file rather than passing it on the command
// line, so it never shows up in process listings.
const payloadPath = path.join(os.tmpdir(), 'gist-payload-' + process.pid + '.json');
fs.writeFileSync(payloadPath, payload);

// Auth: if a token is available in the environment, hand it to `gh` via the
// GH_TOKEN env var. Passing it as a --header argument would put it in the
// process argv, where any user can read it out of /proc. The env var also
// keeps it out of error messages and out of the journal.
// Without a token, `gh` falls back to its own login (the keyring).
const token = process.env.GIST_TOKEN || process.env.GH_TOKEN;
if (token) {
    process.env.GH_TOKEN = token;
}

const args = ['api', '-X', 'PATCH', '/gists/' + GIST_ID, '--input', payloadPath, '--silent'];

try {
    // Silence stdout: `gh api` echoes the entire gist object, which is ~50KB
    // of noise in a journal that should only record the outcome.
    execFileSync('gh', args, { stdio: ['inherit', 'ignore', 'inherit'] });
    console.log('Gist updated successfully!');
} catch (err) {
    // Deliberately do not echo err.message — it can contain the command line.
    console.error('Error updating gist (exit ' + (err.status !== undefined ? err.status : 'unknown') + ').');
    console.error('Hint: authenticate with `gh auth login`, or set GIST_TOKEN/GH_TOKEN to a token with `gist` scope.');
    console.error('For the scheduled refresh, run scripts/setup-refresh-token.sh to provision ~/.config/lifeos/lifeos.env.');
    process.exit(1);
} finally {
    try { fs.unlinkSync(payloadPath); } catch (e) { /* best effort */ }
}
