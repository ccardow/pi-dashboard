#!/usr/bin/env node
// Verify the fetcher's stale-fallback: when a feed fails, the card keeps its
// last known-good value instead of blanking.
//
// This runs the real fetch-feeds.js in a sandbox with the network layer
// broken, then checks the output. It never touches the live vibes.json.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = '/home/cam/work/pi-dashboard';
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-fallback-'));

// Copy the repo files the fetcher needs.
for (const f of ['fetch-feeds.js', 'feeds-config.json', 'push-to-gist.js', 'vibes.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(SANDBOX, f));
}

// Break only the network layer inside the sandbox copy.
const ffPath = path.join(SANDBOX, 'fetch-feeds.js');
let src = fs.readFileSync(ffPath, 'utf8');
const before = src;
src = src.replace(
    "            if (res.statusCode !== 200) {",
    "            if (true) {"
);
src = src.replace(
    "finish(reject, new Error('HTTP ' + res.statusCode));",
    "finish(reject, new Error('SIMULATED FAILURE'));"
);
if (src === before) {
    console.error('FAIL: could not patch the sandbox copy — fetcher source changed shape');
    process.exit(2);
}
fs.writeFileSync(ffPath, src);

console.log('Sandbox:', SANDBOX);
console.log('--- running fetcher with network broken ---');
let out = '';
try {
    out = execFileSync('node', ['fetch-feeds.js', '--dry-run'], { cwd: SANDBOX, timeout: 240000, encoding: 'utf8' });
} catch (e) {
    out = (e.stdout || '') + '\n' + (e.stderr || '');
}

// Show the fallback decisions.
const lines = out.split('\n').filter(l => l.startsWith('✅') || l.startsWith('⚠'));
console.log(lines.join('\n') || '(no ✅/⚠ lines — output was:\n' + out.slice(-800) + ')');

// Check the sandbox output file kept every card populated.
const after = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'vibes.json'), 'utf8'));
const CARDS = ['youtube', 'x_posts', 'hn_posts', 'peter_x', 'news', 'weather', 'verse'];
let ok = true;
console.log('\n--- card state after total network failure ---');
for (const k of CARDS) {
    const v = after[k];
    const populated = Array.isArray(v) ? v.length > 0 : !!(v && Object.keys(v).length);
    if (!populated) ok = false;
    console.log(`  ${k}: ${populated ? 'PRESERVED' : 'BLANKED ❌'}` + (Array.isArray(v) ? ` (${v.length} items)` : ''));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('\n' + (ok ? 'PASS — all cards degraded to stale, none blanked.' : 'FAIL — a card blanked.'));
process.exit(ok ? 0 : 1);
