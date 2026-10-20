#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  Assert main.js loads without throwing.
//
//  A stale reference to a removed identifier kills the WHOLE page, not
//  just the card that needed it. This happened for real: the boot
//  message array was deleted but `bootMessages.length` survived in the
//  init delay, so main.js threw a ReferenceError at load and the
//  dashboard rendered nothing at all — while `node --check` still passed,
//  because the file is syntactically valid.
//
//  So: run the real file in a sandbox with a stub DOM and assert it
//  loads clean.
//
//    node scripts/test-main-loads.js
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const mainJsPath = path.join(REPO, 'main.js');

// When this file is copied into a skill directory there is no main.js to
// load. Say so plainly rather than failing with a confusing ENOENT.
if (!fs.existsSync(mainJsPath)) {
    console.log('(no main.js here — nothing to load-check.)');
    process.exit(0);
}

const mainJs = fs.readFileSync(mainJsPath, 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); }
};

// ─── A stub DOM permissive enough to let main.js run ───

const makeElement = (id) => {
    const el = {
        id,
        innerHTML: '',
        innerText: '',
        textContent: '',
        value: '',
        style: new Proxy({}, { get: () => '', set: () => true }),
        dataset: {},
        classList: {
            _s: new Set(),
            add(...c) { c.forEach(x => this._s.add(x)); },
            remove(...c) { c.forEach(x => this._s.delete(x)); },
            toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
            contains(c) { return this._s.has(c); },
        },
        children: [],
        appendChild(c) { this.children.push(c); return c; },
        prepend(c) { this.children.unshift(c); return c; },
        removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        getAttribute() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 }; },
        focus() {},
        blur() {},
        click() {},
        scrollIntoView() {},
    };
    return el;
};

const elements = new Map();
const document = {
    getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    },
    querySelector: (sel) => {
        const key = 'q:' + sel;
        if (!elements.has(key)) elements.set(key, makeElement(key));
        return elements.get(key);
    },
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('created-' + tag),
    createTextNode: (t) => ({ textContent: t }),
    body: makeElement('body'),
    documentElement: makeElement('html'),
    addEventListener() {},
    removeEventListener() {},
    readyState: 'complete',
    location: { href: 'http://127.0.0.1:8899/index.html', hostname: '127.0.0.1', protocol: 'http:' },
    cookie: '',
};

const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document,
    window: {
        addEventListener() {},
        removeEventListener() {},
        location: document.location,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        getComputedStyle: () => ({}),
    },
    navigator: { userAgent: 'node', language: 'en-US', clipboard: {} },
    location: document.location,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    fetch: () => new Promise(() => {}),   // never resolves; the page just idles
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    isNaN,
    parseInt,
    parseFloat,
    Promise,
    Map,
    Set,
    Error,
    RegExp,
    URL,
    URLSearchParams,
};
sandbox.window.document = document;
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;

console.log('loading main.js in a stub DOM:');
let loadError = null;
try {
    vm.createContext(sandbox);
    vm.runInContext(mainJs, sandbox, { filename: 'main.js' });
} catch (e) {
    loadError = e;
}

check('main.js loads without throwing', !loadError,
    loadError ? loadError.constructor.name + ': ' + loadError.message : '');

if (loadError) {
    console.log('\n  The dashboard would render NOTHING in the browser.');
    console.log('  A stale reference to a removed identifier kills the whole');
    console.log('  page, and `node --check` will not catch it.');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
}

// ─── The removed boot sequence must be gone ───
//
// Comments are stripped first: this file's own comments QUOTE the old
// fiction to explain what was removed, and a naive substring check would
// flag the explanation as if the fiction were still live.
const stripComments = (src) => src
    .split('\n')
    .map((line) => {
        // Remove a trailing // comment (ignoring // inside strings).
        const inString = /(['"`])[^'"`]*\1/.test(line.split('//')[0]);
        if (inString) return line;
        const idx = line.indexOf('//');
        return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
const codeOnly = stripComments(mainJs);

console.log('\nthe fake boot sequence is gone:');
check('no bootMessages array remains', !/const bootMessages\s*=/.test(codeOnly));
check('no reference to bootMessages remains', !/\bbootMessages\b/.test(codeOnly),
    'found: ' + (codeOnly.match(/.*\bbootMessages\b.*/) || [])[0]);
check('no "kernel loaded" fiction remains', !/kernel loaded/.test(codeOnly));
check('no "Awaiting operator input" fiction remains', !/Awaiting operator input/.test(codeOnly));
check('no "Cyber-Zen subsystems" fiction remains', !/subsystems/.test(codeOnly));

// ─── Every top-level identifier the file uses must exist ───
// A crude but effective check: any identifier that looks like it belongs
// to this file's own vocabulary must be declared somewhere in the file.
console.log('\nno dangling references to the removed block:');
const declared = new Set();
for (const m of mainJs.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of mainJs.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
        const name = part.split(':').pop().trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
}
for (const m of mainJs.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(',')) {
        const name = part.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
}
const BOOT_VOCAB = ['bootMessages', 'runBootSequence', 'bootMessagesList'];
for (const name of BOOT_VOCAB) {
    check('"' + name + '" is not referenced', !new RegExp('\\b' + name + '\\b').test(mainJs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
