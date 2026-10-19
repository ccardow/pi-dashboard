#!/usr/bin/env node
// Assert the health-strip RENDERING logic, not just the data.
//
// The health strip is the antidote to a silently-stale card, so it needs to
// be tested like code, not eyeballed.
//
// This test EXTRACTS the real render functions from main.js and runs them
// against a minimal fake DOM, then asserts on the HTML they produce. It
// cannot drift away from the code it is testing: if main.js changes the
// rules, this test fails rather than quietly passing against a stale copy.
//
//   node scripts/test-health-render-logic.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');

// ── Source extraction ────────────────────────────────────────────
// A brace matcher, not a regex: the sources contain nested braces, template
// literals and object literals, and a regex cannot tell where one ends.

const matchBalanced = (from, open, close) => {
    let depth = 0;
    let quote = null;
    for (let j = from; j < mainJs.length; j++) {
        const ch = mainJs[j];

        if (quote) {
            if (ch === '\\') { j++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '/' && mainJs[j + 1] === '/') {
            while (j < mainJs.length && mainJs[j] !== '\n') j++;
            continue;
        }
        if (ch === '/' && mainJs[j + 1] === '*') {
            const end = mainJs.indexOf('*/', j + 2);
            if (end === -1) return -1;
            j = end + 1;
            continue;
        }

        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
};

const skipSpace = (from) => {
    let j = from;
    while (j < mainJs.length && /\s/.test(mainJs[j])) j++;
    return j;
};

// Returns the full source of `const <name> = ...;` starting at `name`.
const grab = (name) => {
    const marker = 'const ' + name + ' =';
    const start = mainJs.indexOf(marker);
    if (start === -1) {
        throw new Error('Could not find `const ' + name + '` in main.js — has it been renamed?');
    }

    let i = mainJs.indexOf('=', start) + 1;
    while (i < mainJs.length && /\s/.test(mainJs[i])) i++;

    // Two shapes to handle:
    //   const x = { ... }           (object literal)
    //   const x = (args) => { ... } (arrow function)
    if (mainJs[i] === '(') {
        const close = matchBalanced(i, '(', ')');
        if (close === -1) throw new Error('Unbalanced parens while extracting `' + name + '`');
        i = skipSpace(close + 1);
        if (mainJs.slice(i, i + 2) !== '=>') {
            throw new Error('Unexpected declaration shape for `' + name + '`');
        }
        i = skipSpace(i + 2);
    }

    if (mainJs[i] !== '{') {
        throw new Error('Unexpected declaration shape for `' + name + '`');
    }
    const close = matchBalanced(i, '{', '}');
    if (close === -1) throw new Error('Unbalanced braces while extracting `' + name + '`');

    return mainJs.slice(start, close + 1);
};

// ── Fake DOM ─────────────────────────────────────────────────────

const makeElement = () => ({
    innerHTML: '',
    title: '',
    className: '',
    style: {},
    getAttribute: () => null,
    setAttribute: () => {},
    addEventListener: () => {},
    querySelectorAll: () => [],
});

// Elements the renderers touch. The card markers are collected so we can
// assert on which ones were made visible.
const fakeStrip = makeElement();
const fakeMarkers = [];

const fakeDocument = {
    getElementById: (id) => {
        if (id === 'health-strip') return fakeStrip;
        return null;
    },
    querySelectorAll: (selector) => {
        if (selector === '[data-health-feed]') return fakeMarkers;
        return [];
    },
};

// ── Load the real functions ──────────────────────────────────────

const sandbox = {
    document: fakeDocument,
    console,
    Date,
    Math,
    Object,
    JSON,
    String,
    Number,
    Array,
    setTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const sources = [
    grab('HEALTH_LABELS'),
    grab('formatAge'),
    grab('ageMinutes'),
    grab('healthClass'),
    grab('renderHealthStrip'),
    grab('renderCardHealth'),
];

// `const` at the top level of a vm script is a lexical binding, not a
// property of the sandbox object, so the names have to be exported by hand.
vm.runInContext(sources.join('\n\n') + `
;globalThis.__exports = { renderHealthStrip, renderCardHealth, formatAge, ageMinutes, healthClass, HEALTH_LABELS };
`, sandbox);

const { renderHealthStrip, renderCardHealth, formatAge, ageMinutes, healthClass } = sandbox.__exports;

// ── Assertions ───────────────────────────────────────────────────

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); }
};

const live = { status: 'live', fetched_at: 'x', age_min: 0, count: 10, error: null, source: 's' };
const stale = { status: 'stale', fetched_at: 'x', age_min: 214, count: 10, error: 'mirrors failed', source: 's' };
const failed = { status: 'stale', fetched_at: null, age_min: null, count: 0, error: 'unreachable', source: 's' };

console.log('classification:');
check('live -> live', healthClass(live) === 'live');
check('stale with a value -> stale', healthClass(stale) === 'stale');
check('stale with no value -> failed', healthClass(failed) === 'failed');
check('missing -> unknown', healthClass(undefined) === 'unknown');
check('unknown is never green', healthClass(undefined) !== 'live');

console.log('\nage display:');
check('null age -> em dash', formatAge(null) === '—');
check('0 min -> now', formatAge(0) === 'now');
check('45 min -> 45m', formatAge(45) === '45m');
check('214 min -> 4h', formatAge(214) === '4h');
check('3 days -> 3d', formatAge(4320) === '3d');

console.log('\nage source — absolute timestamp preferred:');
const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
check('uses fetched_at when present', ageMinutes({ fetched_at: twoHoursAgo, age_min: 0 }) === 120,
    'got ' + ageMinutes({ fetched_at: twoHoursAgo, age_min: 0 }));
check('falls back to age_min without a timestamp', ageMinutes({ age_min: 42 }) === 42);
check('null entry -> null', ageMinutes(null) === null);
check('entry with neither -> null', ageMinutes({}) === null);
check('a future timestamp does not go negative', ageMinutes({ fetched_at: new Date(Date.now() + 60000).toISOString() }) === 0);
check('a garbage timestamp falls back', ageMinutes({ fetched_at: 'not-a-date', age_min: 7 }) === 7);

console.log('\nrendered strip — all feeds healthy:');
fakeStrip.innerHTML = '';
renderHealthStrip({ x: live, hackernews: live, weather: live });
let html = fakeStrip.innerHTML;
check('verdict reads ALL LIVE', html.includes('ALL LIVE'), html.slice(0, 200));
check('verdict is styled ok', html.includes('health-verdict--ok'));
check('X pill is green', /health-pill--live[^>]*>\s*<span class="health-pill__dot"><\/span>\s*<span class="health-pill__name">X<\/span>/.test(html));
check('no stale or failed pills', !html.includes('health-pill--stale') && !html.includes('health-pill--failed'));

console.log('\nrendered strip — one feed stale:');
fakeStrip.innerHTML = '';
renderHealthStrip({ x: stale, hackernews: live, weather: live });
html = fakeStrip.innerHTML;
check('verdict reads 1 STALE', html.includes('1 STALE'), html.slice(0, 200));
check('verdict is styled warn', html.includes('health-verdict--warn'));
check('X pill is amber', html.includes('health-pill--stale'));
check('the error is in the tooltip', html.includes('mirrors failed'));
check('the age is shown', html.includes('4h'));

console.log('\nrendered strip — one feed failed outright:');
fakeStrip.innerHTML = '';
renderHealthStrip({ x: live, hackernews: failed, weather: live });
html = fakeStrip.innerHTML;
check('verdict reads 1 FAILED', html.includes('1 FAILED'), html.slice(0, 200));
check('verdict is styled bad', html.includes('health-verdict--bad'));
check('HN pill is red', html.includes('health-pill--failed'));
check('a failed feed outranks a stale one', !html.includes('ALL LIVE'));

console.log('\nrendered strip — no health data at all:');
fakeStrip.innerHTML = '';
renderHealthStrip(null);
html = fakeStrip.innerHTML;
check('does not claim ALL LIVE', !html.includes('ALL LIVE'));
check('says UNKNOWN', html.includes('UNKNOWN'));
check('says no health data', html.includes('no health data'));

console.log('\ncard markers:');
const makeMarker = (feed) => ({
    _feed: feed,
    title: '',
    className: '',
    style: {},
    getAttribute: (name) => (name === 'data-health-feed' ? feed : null),
    setAttribute: () => {},
});

fakeMarkers.length = 0;
fakeMarkers.push(makeMarker('x'), makeMarker('hackernews'), makeMarker('weather'));
renderCardHealth({ x: live, hackernews: stale, weather: live });

check('live feed marker is hidden', fakeMarkers[0].style.display === 'none');
check('stale feed marker is visible', fakeMarkers[1].style.display === 'inline-flex');
check('stale feed marker is classed stale', fakeMarkers[1].className.includes('card__health--stale'));
check('stale feed marker tooltip names the error', fakeMarkers[1].title.includes('mirrors failed'));
check('live feed marker is hidden (2nd)', fakeMarkers[2].style.display === 'none');

console.log('\ncard markers — a feed with no health entry:');
fakeMarkers.length = 0;
fakeMarkers.push(makeMarker('x'));
renderCardHealth({});
check('missing entry is NOT hidden', fakeMarkers[0].style.display !== 'none',
    'display=' + fakeMarkers[0].style.display);
check('missing entry is not classed live', !fakeMarkers[0].className.includes('--live'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
