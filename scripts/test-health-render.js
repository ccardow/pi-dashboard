#!/usr/bin/env node
// Verify the health strip actually SURFACES a failing feed.
//
// The whole point of the health strip is that a silently-stale card looks
// stale. This injects a synthetic failure into a COPY of the data so the
// live file is never left in a broken state, and prints the assertions to
// check in the browser.
//
//   node scripts/test-health-render.js          # write the broken copy
//   node scripts/test-health-render.js --check  # remove it again
//
// The broken copy lands in scripts/.health-test.json — deliberately NOT
// vibes.json, so a forgotten run can never corrupt the real data.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SOURCE = path.join(REPO, 'vibes.json');
const BROKEN = path.join(__dirname, '.health-test.json');

if (process.argv.includes('--check')) {
    if (fs.existsSync(BROKEN)) {
        fs.unlinkSync(BROKEN);
        console.log('Removed the broken test copy.');
    } else {
        console.log('No test copy present — nothing to clean up.');
    }
    process.exit(0);
}

const data = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));

// X has been failing for a while; we are still serving old data.
data.feed_health.x = {
    status: 'stale',
    fetched_at: '2026-10-19T18:00:00.000Z',
    age_min: 214,
    count: 10,
    error: 'all nitter mirrors failed',
    source: 'nitter mirrors',
};

// Hacker News failed outright and has no value at all.
data.feed_health.hackernews = {
    status: 'stale',
    fetched_at: null,
    age_min: null,
    count: 0,
    error: 'hnrss.org unreachable and no last known-good value',
    source: 'hnrss.org',
};

fs.writeFileSync(BROKEN, JSON.stringify(data, null, 2));

console.log('Wrote broken copy:', BROKEN);
console.log('  X  -> stale, 214m old, serving 10 items');
console.log('  HN -> failed, no value');
console.log();
console.log('To exercise it in the browser, serve the broken copy in place of');
console.log('vibes.json, then assert:');
console.log('  - the X and HN pills are amber / red, not green');
console.log('  - the verdict does NOT read "ALL LIVE"');
console.log('  - the card__health marker beside the X and HN titles is visible');
console.log('  - the marker tooltip names the underlying error');
console.log();
console.log('Run with --check afterwards to remove this file.');
