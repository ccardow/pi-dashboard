#!/usr/bin/env node
// Test scripts/check-youversion-key.sh against a mock YouVersion API.
//
// The check script is the thing Cam runs before committing his key to
// disk, so its failure modes matter: a bad key must fail cleanly and
// write nothing, and a good key must show the verse, the translation
// and the attribution.
//
//   node scripts/test-check-youversion-key.js
//
// The check script talks to $YVP_API, so the test points it at a local
// mock and feeds it keys on stdin.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-youversion-key.sh');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); }
};

const GOOD_KEY = 'good-key-abc';
const VOTD = { day: 292, passage_id: 'JHN.3.16' };
const PASSAGE = {
    id: 'JHN.3.16',
    content: 'For God so loved the world, that he gave his only begotten Son, so that whoever believes in him shall not perish, but have eternal life.',
    reference: 'John 3:16',
};
const META = {
    id: 3034,
    abbreviation: 'BSB',
    title: 'Berean Standard Bible',
    copyright: 'The Holy Bible, Berean Standard Bible, BSB is produced in cooperation with Bible Hub.',
};
const BIBLES = {
    data: [
        { id: 3034, abbreviation: 'BSB', title: 'Berean Standard Bible' },
        { id: 111, abbreviation: 'NIV', title: 'New International Version' },
    ],
};

let mode = 'good';
let requests = [];
let PORT = 0;

const server = http.createServer((req, res) => {
    requests.push({ url: req.url, key: req.headers['x-yvp-app-key'] });
    res.setHeader('Content-Type', 'application/json');

    if (req.headers['x-yvp-app-key'] !== GOOD_KEY) {
        res.statusCode = 401;
        return res.end(JSON.stringify({
            fault: { faultstring: 'Invalid ApiKey', detail: { errorcode: 'oauth.v2.InvalidApiKey' } },
        }));
    }
    if (req.url.startsWith('/v1/verse-of-the-days/')) return res.end(JSON.stringify(VOTD));
    if (req.url.indexOf('/passages/') !== -1) return res.end(JSON.stringify(PASSAGE));
    if (req.url.startsWith('/v1/bibles?')) return res.end(JSON.stringify(BIBLES));
    if (req.url === '/v1/bibles/3034') return res.end(JSON.stringify(META));
    res.statusCode = 404;
    res.end('{}');
});

function runCheck(key) {
    return new Promise((resolve) => {
        const p = spawn('bash', [SCRIPT], {
            env: Object.assign({}, process.env, { YVP_API: 'http://127.0.0.1:' + PORT }),
        });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('close', code => resolve({ out, code }));
        p.stdin.write(key + '\n');
        p.stdin.end();
    });
}

server.listen(0, '127.0.0.1', async () => {
    PORT = server.address().port;

    console.log('a bad key must fail cleanly:');
    requests = [];
    const bad = await runCheck('wrong-key');
    check('it exits non-zero', bad.code !== 0, 'exit=' + bad.code);
    check('it says the key was rejected', /FAIL  the key was rejected/.test(bad.out));
    check('it points at the developer portal', /platform\.youversion\.com/.test(bad.out));
    check('it does not write the key anywhere', !/YVP_APP_KEY=/.test(bad.out));

    console.log('\na good key must show the verse:');
    requests = [];
    const good = await runCheck(GOOD_KEY);
    check('it exits zero', good.code === 0, 'exit=' + good.code);
    check('it confirms the key authenticates', /PASS  the key authenticates/.test(good.out));
    check('it shows the reference', /reference : John 3:16/.test(good.out), good.out.slice(0, 300));
    check('it shows the verse text', /For God so loved the world/.test(good.out));
    check('it shows the translation', /BSB/.test(good.out));
    check('it shows the attribution', /Bible Hub/.test(good.out));
    check('it lists the available versions', /2 versions/.test(good.out));
    check('it sends the key in the header',
        requests.length > 0 && requests.every(r => r.key === GOOD_KEY),
        JSON.stringify(requests.map(r => r.key)));
    check('it says nothing was written', /Nothing was written/.test(good.out));

    console.log('\nthe day number must be local:');
    check('it reports the local day', /local \(America\/Vancouver\): day \d+/.test(good.out));
    check('it reports the UTC day', /UTC\s+: day \d+/.test(good.out));

    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
});
