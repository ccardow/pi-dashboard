#!/usr/bin/env node
// Probe Nitter mirrors for which ones serve which handles.
// Usage: node probe-mirrors.js
const https = require('https');

const MIRRORS = [
    'twiiit.com',
    'nitter.meowing.monster',
    'nitter.cz',
    'nitter.tiekoetter.com',
    'nitter.poast.org',
    'nitter.privacydev.net',
];
const HANDLES = ['elonmusk','sama','openclaw','MatthewBerman','AlexFinn','danmartell','JuliaEMcCoy','JulianGoldieSEO','DuncanRogoff','realDonaldTrump'];

function get(url, ms) {
    return new Promise((resolve) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Probe)' } }, (res) => {
            if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
                return resolve(get(next, ms));
            }
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', e => resolve({ status: 0, err: e.message }));
        req.setTimeout(ms, () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    for (const h of HANDLES) {
        const hits = [];
        for (const m of MIRRORS) {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt) await sleep(3000);
                const r = await get(`https://${m}/${h}/rss`, 12000);
                const items = ((r.body || '').match(/<item>/g) || []).length;
                if (r.status === 200 && items > 0) { hits.push(`${m}(${items})`); break; }
                if (attempt === 2) hits.push(`${m}(${r.status || r.err})`);
            }
        }
        console.log(h.padEnd(18), hits.join('  '));
    }
})();
