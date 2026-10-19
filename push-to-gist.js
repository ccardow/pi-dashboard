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
const { execSync } = require('child_process');

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

try {
    const args = ['api', '-X', 'PATCH', '/gists/' + GIST_ID, '--input', payloadPath];
    // In CI, GH_TOKEN is the Actions token (needs `gists: write` permission).
    // Locally, we fall through to the `gh` CLI's own login.
    const token = process.env.GIST_TOKEN || process.env.GH_TOKEN;
    if (token) {
        args.splice(1, 0, '--header', 'Authorization: Bearer ' + token);
    }
    execSync('gh ' + args.join(' '), { stdio: 'inherit' });
    console.log('Gist updated successfully!');
} catch (err) {
    console.error('Error updating gist:', err.message);
    console.error('Hint: authenticate with `gh auth login`, or set GIST_TOKEN/GH_TOKEN to a token with `gist` scope.');
    process.exit(1);
} finally {
    try { fs.unlinkSync(payloadPath); } catch (e) { /* best effort */ }
}
