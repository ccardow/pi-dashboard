#!/usr/bin/env node
// ═══════════════════════════════════════════════
//  Content fingerprint for vibes.json.
//
//  The dashboard data carries fields that change on EVERY fetch —
//  timestamps, token counters, uptime, "374 msgs · 180 tools" style
//  suffixes. Those are noise: committing them forces a rebuild of the
//  static host every 30 minutes even when nothing meaningful changed.
//
//  This computes a hash over the SUBSTANTIVE content only, so the
//  refresh timer can tell "the feeds moved" from "the clock ticked".
//
//  Usage:
//    node scripts/data-fingerprint.js vibes.json
//    git show HEAD:vibes.json | node scripts/data-fingerprint.js -
// ═══════════════════════════════════════════════

const fs = require('fs');
const crypto = require('crypto');

// Fields that change on every run and carry no content meaning.
// Deleted outright before hashing.
const VOLATILE_PATHS = [
    ['lastUpdate'],
    ['pi_status', 'lastUpdate'],
    ['pi_status', 'model', 'tokens_used'],
    ['pi_status', 'gateway', 'uptime_seconds'],
    ['pi_status', 'totals', 'input_tokens'],
    ['pi_status', 'totals', 'output_tokens'],
    ['pi_status', 'totals', 'tool_calls'],
    ['weather', 'updated'],
];

// Keys removed from every element of an array at the given path. Needed for
// arrays, where deletePath (which walks object keys) cannot reach: each log
// entry carries its own "time", which is a fresh wall-clock stamp on every
// run and would otherwise defeat the whole fingerprint.
const VOLATILE_ARRAY_ITEM_KEYS = [
    { path: ['pi_status', 'logs'], key: 'time' },
];

// Numeric patterns inside human-readable status strings. These counters
// tick constantly (session counts, tool counts, token totals) while the
// surrounding text stays the same. Mask just the number so the sentence
// still hashes identically.
const VOLATILE_NUMBER_PATTERNS = [
    [/·\s*\d+\s+msgs\b/g, '· # msgs'],
    [/·\s*\d+\s+tools\b/g, '· # tools'],
    [/\bpid\s+\d+\b/g, 'pid #'],
    [/\b\d+\s+sessions\b/g, '# sessions'],
    [/\b\d+k\s+tokens\b/g, '#k tokens'],
    [/\b\d+\s+tool\s+calls\b/g, '# tool calls'],
];

function deletePath(obj, path) {
    let node = obj;
    for (let i = 0; i < path.length - 1; i++) {
        if (!node || typeof node !== 'object') return;
        node = node[path[i]];
    }
    if (node && typeof node === 'object' && path[path.length - 1] in node) {
        delete node[path[path.length - 1]];
    }
}

// Remove a key from every element of the array at the given path.
// The path points AT the array (e.g. ['pi_status','logs']), so every level
// is walked to reach it — unlike deletePath, where the last element names
// the key to delete rather than a container.
function deleteArrayItemKey(obj, path, key) {
    let node = obj;
    for (const segment of path) {
        if (!node || typeof node !== 'object') return;
        node = node[segment];
    }
    if (Array.isArray(node)) {
        for (const item of node) {
            if (item && typeof item === 'object' && key in item) delete item[key];
        }
    }
}

function maskStrings(obj) {
    if (Array.isArray(obj)) {
        obj.forEach(maskStrings);
        return;
    }
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (typeof value === 'string') {
            let masked = value;
            for (const [pattern, replacement] of VOLATILE_NUMBER_PATTERNS) {
                masked = masked.replace(pattern, replacement);
            }
            obj[key] = masked;
        } else {
            maskStrings(value);
        }
    }
}

function normalize(data) {
    const copy = JSON.parse(JSON.stringify(data));
    for (const path of VOLATILE_PATHS) deletePath(copy, path);
    for (const { path, key } of VOLATILE_ARRAY_ITEM_KEYS) deleteArrayItemKey(copy, path, key);
    maskStrings(copy);
    return copy;
}

// Stable stringify: sort object keys so key order can never change the hash.
function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(
            k => JSON.stringify(k) + ':' + stableStringify(value[k])
        ).join(',') + '}';
    }
    return JSON.stringify(value);
}

const target = process.argv[2];
if (!target) {
    console.error('Usage: node scripts/data-fingerprint.js <file|->');
    process.exit(2);
}

let raw;
if (target === '-') {
    raw = fs.readFileSync(0, 'utf8');
} else {
    raw = fs.readFileSync(target, 'utf8');
}

let data;
try {
    data = JSON.parse(raw);
} catch (e) {
    // Unparseable data is always a change worth committing.
    console.log('UNPARSEABLE');
    process.exit(0);
}

const normalized = normalize(data);
const hash = crypto.createHash('sha256').update(stableStringify(normalized)).digest('hex');
console.log(hash);
