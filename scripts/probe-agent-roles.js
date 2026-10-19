#!/usr/bin/env node
// Develop the SOUL.md role parser against the real profile files.
// Prints what the parser extracts for each agent so the rules can be checked
// against reality rather than assumed.

const fs = require('fs');
const path = require('path');

const PROFILES = '/home/cam/.hermes/profiles';

function parseRole(soul) {
    if (!soul) return null;

    // The identity paragraph looks like:
    //   "You are Marcus. You are the lead strategist and orchestrator for FireBuilt Media."
    //   "You are Maya. You build the things. You are the hands of FireBuilt Media."
    //   "You are Atlas. You are the quality gate. Nothing ships broken on your watch."
    //
    // Take the FIRST clause after the name — that is the agent's own tagline.
    const m = soul.match(/^\s*You are ([A-Z][a-zA-Z]+)\.\s*([^\n]*)/m);
    if (!m) return null;

    const rest = m[2].trim();
    if (!rest) return null;

    // "You are the <role> for FireBuilt Media."  /  "You are the <role>."
    const areThe = rest.match(/^You are the (.+?)(?: for FireBuilt Media)?\./);
    if (areThe) {
        return capitalize(stripLeadingArticle(areThe[1].trim()));
    }

    // "You <verb phrase>."
    const youDo = rest.match(/^You ([a-z].+?)\./);
    if (youDo) {
        return capitalize(youDo[1].trim());
    }

    return null;
}

function stripLeadingArticle(s) {
    return s.replace(/^(the|a|an)\s+/i, '');
}

function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

for (const p of ['marcus', 'sienna', 'maya', 'atlas', 'harper', 'montage', 'grace']) {
    const file = path.join(PROFILES, p, 'SOUL.md');
    let soul = null;
    try { soul = fs.readFileSync(file, 'utf8'); } catch (e) {}
    const role = parseRole(soul);
    console.log(`${p.padEnd(9)} -> ${role === null ? '(NO MATCH)' : role}`);
}
