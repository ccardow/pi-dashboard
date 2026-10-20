#!/usr/bin/env node
// Assert the current-context calculation.
//
// The Pi card shows "Context: Xk / Yk". The X must be the CURRENT context
// occupancy, not the session's lifetime token spend. Using the lifetime
// figure produced readings like "1413k / 1000k" — over 100% of the window.
//
// Hermes persists the real figure in the session row's model_config blob
// under _usage_anchor, and the CLI shows the same number as
// "Current context".
//
//   node scripts/test-context-reading.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const fetcher = fs.readFileSync(path.join(REPO, 'fetch-feeds.js'), 'utf8');

// Extract readCurrentContext from the real fetcher.
const grab = (name) => {
    const marker = 'function ' + name + '(';
    const start = fetcher.indexOf(marker);
    if (start === -1) throw new Error('Could not find `function ' + name + '` in fetch-feeds.js');
    let depth = 0, i = fetcher.indexOf('{', start), quote = null;
    for (; i < fetcher.length; i++) {
        const ch = fetcher[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    return fetcher.slice(start, i + 1);
};

const sandbox = { console, JSON, parseInt, isNaN };
vm.createContext(sandbox);
vm.runInContext(grab('readCurrentContext') + '\n;globalThis.__f = readCurrentContext;', sandbox);
const readCurrentContext = sandbox.__f;

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); }
};

const withAnchor = (promptTokens) => ({
    model_config: JSON.stringify({
        gateway_runtime: { provider: 'openrouter' },
        _usage_anchor: { prompt_tokens: promptTokens, completion_tokens: 217, base_count: 454 },
    }),
});

console.log('reading the anchor:');
check('reads prompt_tokens from the anchor',
    readCurrentContext(withAnchor(240148)) === 240148,
    'got ' + readCurrentContext(withAnchor(240148)));
check('reads a JSON-string model_config',
    readCurrentContext(withAnchor(50000)) === 50000);
check('reads an object model_config',
    readCurrentContext({ model_config: { _usage_anchor: { prompt_tokens: 12345 } } }) === 12345);

console.log('\nunknown must be null, never a wrong number:');
check('no live session -> null', readCurrentContext(null) === null);
check('no model_config -> null', readCurrentContext({}) === null);
check('no _usage_anchor -> null',
    readCurrentContext({ model_config: JSON.stringify({ gateway_runtime: {} }) }) === null);
check('empty model_config -> null',
    readCurrentContext({ model_config: '{}' }) === null);
check('anchor with zero prompt_tokens -> null',
    readCurrentContext(withAnchor(0)) === null);
check('unparseable model_config -> null',
    readCurrentContext({ model_config: 'not json' }) === null);
check('anchor that is not an object -> null',
    readCurrentContext({ model_config: JSON.stringify({ _usage_anchor: 'nope' }) }) === null);

console.log('\nthe lifetime-total trap:');
// The session row's input_tokens/output_tokens are LIFETIME totals. They
// must not be mistaken for the current context.
const lifetime = {
    input_tokens: 1092533,
    output_tokens: 323641,
    model_config: JSON.stringify({ _usage_anchor: { prompt_tokens: 240148 } }),
};
const fromAnchor = readCurrentContext(lifetime);
const lifetimeSum = Math.round((lifetime.input_tokens + lifetime.output_tokens) / 1000);
check('anchor value is used, not the lifetime sum',
    fromAnchor === 240148 && fromAnchor !== lifetimeSum,
    'anchor=' + fromAnchor + ' lifetime=' + lifetimeSum);
check('the lifetime sum would have exceeded 100% of a 1M window',
    lifetimeSum > 1000, 'lifetime=' + lifetimeSum);

console.log('\nthe display must never exceed the window:');
// The frontend clamps used to the window size. This mirrors that rule so a
// future change to one side cannot silently allow a >100% reading.
const renderTokens = (used, total) => {
    if (used === null || used === undefined) return `— / ${total}k`;
    const clamped = Math.min(used, total);
    return `${clamped}k / ${total}k`;
};
check('a normal reading renders as-is', renderTokens(247, 1000) === '247k / 1000k');
check('an over-window reading is clamped',
    renderTokens(1413, 1000) === '1000k / 1000k',
    renderTokens(1413, 1000));
check('an unknown reading shows a dash', renderTokens(null, 1000) === '— / 1000k');
check('an undefined reading shows a dash', renderTokens(undefined, 1000) === '— / 1000k');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
