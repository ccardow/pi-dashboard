#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  Assert the refresh-journal reader and the System Activity renderer.
//
//  The "System Activity" card used to display a hardcoded boot sequence
//  — invented lines like "LIFE.OS v2.0 kernel loaded" and "Prairie
//  skies: clear" — as if they were live telemetry. It was a random quote
//  generator wearing a terminal costume.
//
//  These checks assert that the card now shows the REAL pipeline history:
//  each run's time, duration, outcome and summary, and a status line
//  derived from the last run rather than a hardcoded phrase.
//
//    node scripts/test-refresh-journal.js
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); }
};

// ─── The journal reader ───
const journal = require(path.join(REPO, 'scripts', 'read-refresh-journal.js'));

// A realistic slice of what the refresh script writes to the journal.
const JOURNAL_LINES = [
    { text: 'fetching feeds...', ts: 1000 },
    { text: 'pushing to Gist...', ts: 1010 },
    { text: 'gist updated', ts: 1020 },
    { text: 'committing refreshed data...', ts: 1021 },
    { text: 'content changed (fingerprint abc -> def)', ts: 1022 },
    { text: 'repo updated', ts: 1030 },
    { text: 'done', ts: 1031 },
    { text: 'fetching feeds...', ts: 2000 },
    { text: 'pushing to Gist...', ts: 2001 },
    { text: 'gist updated', ts: 2002 },
    { text: 'content unchanged (fingerprint abc) — skipping commit and push', ts: 2003 },
    { text: 'done', ts: 2004 },
    { text: 'fetching feeds...', ts: 3000 },
    { text: 'pushing to Gist...', ts: 3001 },
    { text: 'FAILED: push-to-gist.js failed — is the token valid and gist-scoped?', ts: 3002 },
];

console.log('folding journal lines into runs:');
const runs = journal.foldRuns(JOURNAL_LINES);
check('three runs are found', runs.length === 3, 'got ' + runs.length);

console.log('\nnewest run first:');
check('the failed run is first', runs[0].outcome === 'failed', 'got ' + runs[0].outcome);
check('the failed run keeps the error', runs[0].error === 'push-to-gist.js failed — is the token valid and gist-scoped?',
    JSON.stringify(runs[0].error));
check('the failed run is summarised', /FAILED/.test(runs[0].summary), runs[0].summary);
check('the failed run has a duration', runs[0].duration_s === 2, String(runs[0].duration_s));

console.log('\nrun durations are real, not zero:');
// foldRuns returns newest first, so index 1 is the 2000s run and index 2
// is the 1000s run.
check('the no-change run measured 4s', runs[1].duration_s === 4, String(runs[1].duration_s));
check('the no-change run says no change', /no content change/.test(runs[1].summary), runs[1].summary);
check('the committed run measured 31s', runs[2].duration_s === 31, String(runs[2].duration_s));
check('the committed run says it committed', /committed/.test(runs[2].summary), runs[2].summary);

console.log('\noutcomes:');
check('a completed run is ok', runs[1].outcome === 'ok', runs[1].outcome);
check('a no-change run is still ok', runs[2].outcome === 'ok', runs[2].outcome);
check('a failed run is failed', runs[0].outcome === 'failed', runs[0].outcome);

console.log('\nedge cases:');
check('an empty journal yields no runs', journal.foldRuns([]).length === 0);
check('unrelated lines are ignored',
    journal.foldRuns([{ text: 'To github.com:ccardow/pi-dashboard.git', ts: 1 }]).length === 0);
check('a run with no end still reports a summary',
    journal.foldRuns([{ text: 'fetching feeds...', ts: 5 }])[0].summary === 'run in progress',
    journal.foldRuns([{ text: 'fetching feeds...', ts: 5 }])[0].summary);
check('a skipped run says so',
    /already running/.test(journal.foldRuns([
        { text: 'fetching feeds...', ts: 1 },
        { text: 'another refresh is already running — skipping this one', ts: 2 },
        { text: 'done', ts: 3 },
    ])[0].summary));

// ─── The renderer ───
// Extract the REAL functions from main.js so this test cannot drift from
// the code it tests.
const mainJs = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');

const grab = (name) => {
    const marker = 'const ' + name + ' = ';
    const start = mainJs.indexOf(marker);
    if (start === -1) throw new Error('Could not find `' + name + '` in main.js');

    // Look at what FOLLOWS the marker. If it is '{', this is a plain
    // object literal, not an arrow function.
    const afterMarker = mainJs.slice(start + marker.length).match(/^\s*/)[0];
    const next = mainJs[start + marker.length + afterMarker.length];
    const isArrow = next === '(' || next === 'async';

    if (!isArrow) {
        // A plain value: take the balanced-brace object, or the statement
        // up to the semicolon.
        const open = mainJs.indexOf('{', start);
        if (open === -1) {
            const end = mainJs.indexOf(';', start);
            return mainJs.slice(start, end + 1);
        }
        let depth = 0, i = open, quote = null;
        for (; i < mainJs.length; i++) {
            const ch = mainJs[i];
            if (quote) {
                if (ch === '\\') { i++; continue; }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) break; }
        }
        return mainJs.slice(start, i + 1);
    }

    // An arrow function: find the '=>' that belongs to THIS definition,
    // not one somewhere later in the file.
    let depth = 0, quote = null, arrow = -1;
    for (let i = start + marker.length; i < mainJs.length; i++) {
        const ch = mainJs[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === '=' && mainJs[i + 1] === '>' && depth === 0) { arrow = i; break; }
        else if (ch === ';' && depth === 0) break;
    }
    if (arrow === -1) throw new Error('Could not find the arrow for `' + name + '` in main.js');

    const open = mainJs.indexOf('{', arrow);
    let d = 0, i = open, q = null;
    for (; i < mainJs.length; i++) {
        const ch = mainJs[i];
        if (q) {
            if (ch === '\\') { i++; continue; }
            if (ch === q) q = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
        if (ch === '{') d++;
        else if (ch === '}') { d--; if (d === 0) break; }
    }
    return mainJs.slice(start, i + 1);
};

const fakeDoc = () => {
    const els = {};
    const mk = (id) => ({ id, innerHTML: '', textContent: '', classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(...c) { c.forEach(x => this._s.delete(x)); }, contains(c) { return this._s.has(c); } } });
    els['activity-log'] = mk('activity-log');
    els['status-display'] = mk('status-display');
    const dot = mk('pulse-dot');
    return {
        elements: els,
        getElementById: (id) => els[id] || null,
        querySelector: (sel) => (sel === '.pulse-dot' ? dot : null),
    };
};

const sandbox = {
    console,
    document: fakeDoc(),
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    isNaN,
    parseInt,
};
vm.createContext(sandbox);
vm.runInContext(
    // dashboardTimezone is declared with `let` in main.js, which grab()
    // does not capture (it looks for `const NAME = `). Declare it here.
    'let dashboardTimezone = "America/Vancouver";\n' +
    grab('setDashboardTimezone') + '\n' +
    grab('REFRESH_OUTCOME_LABEL') + '\n' +
    grab('refreshRunTime') + '\n' +
    grab('renderRefreshHistory') + '\n' +
    grab('renderSystemStatus') + '\n' +
    'globalThis.__exports = { refreshRunTime, renderRefreshHistory, renderSystemStatus };',
    sandbox
);
const { renderRefreshHistory, renderSystemStatus } = sandbox.__exports;

console.log('\nrendering the real history:');
renderRefreshHistory({ runs, last_run: runs[0] });
const html = sandbox.document.getElementById('activity-log').innerHTML;
check('every run is rendered', (html.match(/log-item/g) || []).length === 3,
    String((html.match(/log-item/g) || []).length));
check('the failed run is marked in red', /log-msg--error/.test(html));
check('the failure summary is shown', /FAILED/.test(html));
check('a duration is shown', /31s/.test(html));
check('the outcome label is shown', /\[OK\]/.test(html));

console.log('\nrendering with no history:');
renderRefreshHistory(null);
const emptyHtml = sandbox.document.getElementById('activity-log').innerHTML;
check('it says unavailable rather than showing nothing', /unavailable/.test(emptyHtml));
check('it does not claim success', !/\[OK\]/.test(emptyHtml));

console.log('\nthe status line reflects the last real run:');
const display = sandbox.document.getElementById('status-display');
renderSystemStatus({ last_run: { outcome: 'ok' } });
check('a good run reads nominal', display.textContent === 'All Systems Nominal', display.textContent);
renderSystemStatus({ last_run: { outcome: 'failed' } });
check('a failed run says so', display.textContent === 'Last Refresh Failed', display.textContent);
renderSystemStatus({ last_run: { outcome: 'running' } });
check('a run in progress says so', display.textContent === 'Refresh In Progress', display.textContent);
renderSystemStatus(null);
check('no history means unknown, not nominal', display.textContent === 'Status Unknown', display.textContent);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
