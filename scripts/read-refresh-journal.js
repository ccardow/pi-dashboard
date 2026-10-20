#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  Read the REAL refresh history from the systemd journal.
//
//  The dashboard's "System Activity" card used to show a hardcoded boot
//  sequence — invented lines like "LIFE.OS v2.0 kernel loaded" and
//  "Prairie skies: clear" — presented as if they were live telemetry.
//  They were a random quote generator wearing a terminal costume.
//
//  The truth is already on disk: the refresh timer logs every run to the
//  systemd journal. This reads those entries and turns them into
//  structured records the dashboard can render truthfully.
//
//  It ALSO writes a plain-text log file, so the history survives even if
//  the journal is rotated away, and so the fetcher does not depend on
//  journalctl being available (some hosts have no systemd).
//
//  Usage:
//    node scripts/read-refresh-journal.js          # JSON to stdout
//    node scripts/read-refresh-journal.js --quiet  # no stdout
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const UNIT = process.env.LIFEOS_UNIT || 'lifeos-refresh.service';
const LOG_FILE = process.env.LIFEOS_LOG || path.join(os.homedir(), '.config', 'lifeos', 'refresh-history.log');
const MAX_RUNS = 20;

// Lines the refresh script emits, and what each one means.
const EVENTS = [
    { re: /^fetching feeds/, kind: 'fetch-start', text: 'fetching feeds' },
    { re: /^pushing to Gist/, kind: 'publish-start', text: 'pushing to Gist' },
    { re: /^gist updated/, kind: 'published', text: 'Gist published' },
    { re: /^committing refreshed data/, kind: 'commit-start', text: 'committing data' },
    { re: /^content changed/, kind: 'changed', text: 'content changed' },
    { re: /^content unchanged/, kind: 'unchanged', text: 'content unchanged' },
    { re: /^repo updated/, kind: 'committed', text: 'repo committed' },
    { re: /^no changes to commit/, kind: 'unchanged', text: 'content unchanged' },
    { re: /^skipping commit/, kind: 'unchanged', text: 'commit skipped' },
    { re: /^another refresh is already running/, kind: 'skipped', text: 'skipped (already running)' },
    { re: /^done$/, kind: 'done', text: 'run complete' },
    { re: /^FAILED:/, kind: 'failed', text: 'FAILED' },
];

// Read the systemd journal for the refresh unit, newest first, as JSON
// lines so each entry carries a real timestamp.
function readJournal() {
    let raw;
    try {
        raw = execFileSync(
            'journalctl',
            ['--user', '-u', UNIT, '--no-pager', '-o', 'json', '-n', '400'],
            { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 }
        );
    } catch (e) {
        return null; // no journalctl, no permission, or no unit
    }
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch (e) {
            continue;
        }
        const msg = (entry.MESSAGE || '').trim();
        if (!msg.startsWith('[lifeos-refresh]')) continue;
        const text = msg.replace('[lifeos-refresh]', '').trim();
        const ts = parseInt(entry.__REALTIME_TIMESTAMP, 10);
        out.push({ text, ts: isNaN(ts) ? null : ts / 1e6 });
    }
    return out;
}

// Read the plain-text history file written by previous runs.
function readLogFile() {
    try {
        const raw = fs.readFileSync(LOG_FILE, 'utf8');
        return raw.split('\n').filter(Boolean).map((line) => {
            const m = line.match(/^(\S+)\s+(.*)$/);
            return m ? { text: m[2], ts: Date.parse(m[1]) / 1000 } : { text: line, ts: null };
        });
    } catch (e) {
        return [];
    }
}

// Fold a flat list of log lines into run records.
//
// A run starts at "fetching feeds" and ends at "done" or "FAILED:". Each
// run becomes one entry the dashboard can show as a single line, so the
// card reads as a list of refreshes rather than a wall of raw output.
function foldRuns(entries) {
    const runs = [];
    let current = null;

    for (const e of entries) {
        const match = EVENTS.find((ev) => ev.re.test(e.text));
        if (!match) continue;

        // A new "fetching feeds" starts a new run.
        if (match.kind === 'fetch-start') {
            if (current) runs.push(current);
            current = { started_at: e.ts, ended_at: null, outcome: 'running', events: [] };
            current.events.push({ kind: match.kind, text: match.text, at: e.ts });
            continue;
        }

        // Lines before any run (e.g. a failure that happened before the
        // fetch started) are kept as a standalone run so nothing is lost.
        if (!current) {
            current = { started_at: e.ts, ended_at: null, outcome: 'running', events: [] };
        }

        current.events.push({ kind: match.kind, text: match.text, at: e.ts });

        if (match.kind === 'failed') {
            current.outcome = 'failed';
            current.error = e.text.replace(/^FAILED:\s*/, '');
            current.ended_at = e.ts;
            runs.push(current);
            current = null;
        } else if (match.kind === 'done') {
            current.outcome = current.outcome === 'running' ? 'ok' : current.outcome;
            current.ended_at = e.ts;
            runs.push(current);
            current = null;
        } else if (match.kind === 'unchanged' || match.kind === 'skipped') {
            // A no-op run still counts as a successful run.
            if (current.outcome === 'running') current.outcome = 'ok';
        } else if (match.kind === 'changed' || match.kind === 'committed' || match.kind === 'published') {
            if (current.outcome === 'running') current.outcome = 'ok';
        }
    }
    if (current) runs.push(current);

    // Newest first, and give every run a human summary.
    runs.reverse();
    for (const r of runs) {
        r.duration_s = (r.ended_at && r.started_at)
            ? Math.max(0, Math.round(r.ended_at - r.started_at))
            : null;
        r.summary = summarize(r);
    }
    return runs.slice(0, MAX_RUNS);
}

// One line describing what a run actually did.
function summarize(run) {
    if (run.outcome === 'failed') {
        return 'FAILED: ' + (run.error || 'unknown error');
    }
    const published = run.events.some((e) => e.kind === 'published');
    const committed = run.events.some((e) => e.kind === 'committed');
    const unchanged = run.events.some((e) => e.kind === 'unchanged');
    const skipped = run.events.some((e) => e.kind === 'skipped');

    if (skipped) return 'skipped — another refresh was already running';
    if (committed) return 'published to Gist and committed to repo';
    if (published && unchanged) return 'published to Gist (no content change)';
    if (published) return 'published to Gist';
    if (unchanged) return 'no content change';
    if (run.outcome === 'running') return 'run in progress';
    return 'completed';
}

// Append the journal entries we have not seen to the plain-text log, so
// the history survives journal rotation.
function appendToLogFile(entries) {
    const known = new Set(readLogFile().map((e) => e.text + '|' + e.ts));
    const fresh = entries.filter((e) => !known.has(e.text + '|' + e.ts));
    if (fresh.length === 0) return;
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(
            LOG_FILE,
            fresh.map((e) => (e.ts ? new Date(e.ts * 1000).toISOString() : new Date().toISOString()) + ' ' + e.text).join('\n') + '\n',
            { mode: 0o600 }
        );
    } catch (e) {
        // A read-only home is not a reason to fail the fetch.
    }
}

function main(opts) {
    const quiet = opts && opts.quiet !== undefined
        ? opts.quiet
        : process.argv.includes('--quiet');
    const journal = readJournal();
    const fromJournal = journal ? foldRuns(journal) : [];
    const fromFile = foldRuns(readLogFile());

    // Prefer the journal (authoritative); fall back to the log file.
    let runs = fromJournal.length > 0 ? fromJournal : fromFile;

    if (journal) appendToLogFile(journal);

    const result = {
        source: fromJournal.length > 0 ? 'systemd journal' : (fromFile.length > 0 ? 'log file' : 'none'),
        unit: UNIT,
        runs,
        last_run: runs[0] || null,
        total_runs: runs.length,
    };

    if (!quiet) {
        console.log(JSON.stringify(result, null, 2));
    }
    return result;
}

if (require.main === module) main();

module.exports = { main, foldRuns, summarize, EVENTS };
