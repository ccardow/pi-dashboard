#!/usr/bin/env node
// Verify the fingerprint separates noise from real content changes.
//
//   node scripts/test-fingerprint.js
//
// Two runs of the fetcher produce different timestamps and token counters
// but the SAME hash. Changing a post title produces a different hash.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'data-fingerprint.js');

const fingerprint = (obj) => {
    const tmp = path.join('/tmp', 'fp-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(tmp, JSON.stringify(obj));
    try {
        return execFileSync('node', [SCRIPT, tmp], { encoding: 'utf8' }).trim();
    } finally {
        fs.unlinkSync(tmp);
    }
};

const base = {
    youtube: [
        { title: 'Post A', channel: 'Matt Wolfe', url: 'https://youtu.be/a' },
        { title: 'Post B', channel: 'Duncan Rogoff', url: 'https://youtu.be/b' },
    ],
    x_posts: [{ user: 'AlexFinn', content: 'hello', url: 'https://x.com/1' }],
    hn_posts: [{ content: 'Story A', url: 'https://news.ycombinator.com/1' }],
    news: [{ title: 'Headline A', source: 'BBC' }],
    peter_x: [{ content: 'blog post' }],
    verse: { text: 'In those days...', reference: 'Daniel 10:2', translation: 'kjv', date: '2026-10-19' },
    lastUpdate: '10/19/2026, 03:00 PM',
    weather: { label: 'Abbotsford Weather', temp: '15', condition: 'Clear', updated: 'Oct 19, 03:00 PM' },
    feed_health: {
        x: { status: 'live', fetched_at: '2026-10-19T22:00:00.000Z', age_min: 0, count: 10, error: null, source: 'nitter mirrors' },
        hn: { status: 'live', fetched_at: '2026-10-19T22:00:00.000Z', age_min: 0, count: 10, error: null, source: 'hnrss.org' },
    },
    firebuilt: {
        agent_count: 7,
        total_sessions: 2,
        total_messages: 8,
        last_activity: 1780000000,
        agents: [
            { name: 'Marcus', id: 'marcus', role: 'Lead strategist and orchestrator', model: 'deepseek-v4-flash', provider: 'ollama-cloud', sessions: 0, messages: 0, last_activity: null, skills: 27, cron: 4 },
            { name: 'Grace', id: 'grace', role: 'Help churches use technology faithfully', model: 'nemotron-3-ultra-free', provider: 'opencode-free', sessions: 1, messages: 4, last_activity: 1780000000, skills: 27, cron: 4 },
        ],
    },
    pi_status: {
        status: 'ONLINE',
        activity: 'Hermes Gateway · minimax/minimax-m3.1-flash:free via openrouter',
        model: { name: 'openrouter/minimax/minimax-m3.1-flash:free', tokens_used: 100, tokens_total: 1000 },
        gateway: { pid: 15631, version: '0.22.2', state: 'running', uptime_seconds: 1000, active_agents: 1 },
        totals: { sessions: 60, input_tokens: 37996445, output_tokens: 635104, tool_calls: 1180 },
        logs: [{ time: '16:06', msg: 'default/LOCAL: minimax/minimax-m3.1-flash:free · 374 msgs · 180 tools' }],
        refresh: {
            source: 'systemd journal',
            unit: 'lifeos-refresh.service',
            total_runs: 3,
            last_run: {
                started_at: 1780000000,
                ended_at: 1780000102,
                duration_s: 102,
                outcome: 'ok',
                summary: 'published to Gist and committed to repo',
            },
            runs: [
                { started_at: 1780000000, duration_s: 102, outcome: 'ok', summary: 'published to Gist and committed to repo' },
                { started_at: 1779999600, duration_s: 0, outcome: 'ok', summary: 'published to Gist (no content change)' },
                { started_at: 1779999200, duration_s: 51, outcome: 'ok', summary: 'published to Gist (no content change)' },
            ],
        },
        roadmap: [
            { name: 'Hermes Gateway', status: 'running · v0.22.2 · pid 15631' },
            { name: 'Session Ledger', status: '60 sessions · 38632k tokens · 1180 tool calls' },
        ],
        lastUpdate: 'Oct 19, 03:00 PM',
    },
};

let pass = 0, fail = 0;
const check = (name, cond) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name); }
};

console.log('noise should NOT change the fingerprint:');
const h0 = fingerprint(base);
check('identical input -> identical hash', fingerprint(base) === h0);

const noise = JSON.parse(JSON.stringify(base));
noise.lastUpdate = '10/19/2026, 04:30 PM';
noise.weather.updated = 'Oct 19, 04:30 PM';
noise.pi_status.lastUpdate = 'Oct 19, 04:30 PM';
noise.pi_status.model.tokens_used = 889;
noise.pi_status.gateway.uptime_seconds = 29978;
noise.pi_status.totals.input_tokens = 38001234;
noise.pi_status.totals.output_tokens = 640999;
noise.pi_status.totals.tool_calls = 1205;
noise.pi_status.logs[0].time = '16:33';
noise.pi_status.logs[0].msg = 'default/LOCAL: minimax/minimax-m3.1-flash:free · 401 msgs · 183 tools';
noise.pi_status.roadmap[0].status = 'running · v0.22.2 · pid 15999';
noise.pi_status.roadmap[1].status = '61 sessions · 39100k tokens · 1205 tool calls';
noise.feed_health.x.fetched_at = '2026-10-19T23:59:00.000Z';
noise.feed_health.x.age_min = 119;
noise.feed_health.hn.fetched_at = '2026-10-19T23:59:00.000Z';
noise.feed_health.hn.age_min = 119;
// The refresh history is a rolling window: a new run arrives, the run
// list grows, and every entry is re-timed. All of that is noise.
noise.pi_status.refresh.total_runs = 9;
noise.pi_status.refresh.runs.unshift({ started_at: 1780000500, duration_s: 77, outcome: 'ok', summary: 'published to Gist' });
noise.pi_status.refresh.runs[0].started_at = 1780000600;
noise.pi_status.refresh.runs[0].duration_s = 88;
noise.pi_status.refresh.runs[1].duration_s = 12;
noise.pi_status.refresh.last_run.started_at = 1780000600;
noise.pi_status.refresh.last_run.ended_at = 1780000688;
noise.pi_status.refresh.last_run.duration_s = 88;
check('timestamps / counters / log suffixes -> same hash', fingerprint(noise) === h0);

console.log('\nreal content changes MUST change the fingerprint:');
const cases = [
    ['new youtube video', d => { d.youtube[0].title = 'Post B'; }],
    ['new x post', d => { d.x_posts[0].content = 'goodbye'; }],
    ['new hn story', d => { d.hn_posts[0].content = 'Story B'; }],
    ['new headline', d => { d.news[0].title = 'Headline B'; }],
    ['new blog post', d => { d.peter_x[0].content = 'other blog'; }],
    ['verse rolls over', d => { d.verse.reference = 'HAG 1:1'; }],
    ['weather changes', d => { d.weather.temp = '9'; }],
    ['weather condition changes', d => { d.weather.condition = 'Rain'; }],
    ['gateway goes down', d => { d.pi_status.gateway.state = 'stopped'; }],
    ['gateway version changes', d => { d.pi_status.gateway.version = '0.23.0'; }],
    ['model switches', d => { d.pi_status.model.name = 'openrouter/other/model'; }],
    ['session count changes', d => { d.pi_status.totals.sessions = 61; }],
    ['new x post added', d => { d.x_posts.push({ user: 'sama', content: 'new' }); }],
    ['post order changes', d => { d.youtube.reverse(); }],
    ['a feed goes stale', d => { d.feed_health.x.status = 'stale'; }],
    ['a feed fails outright', d => { d.feed_health.x.status = 'stale'; d.feed_health.x.error = 'all mirrors failed'; d.feed_health.x.count = 0; }],
    ['feed health count changes', d => { d.feed_health.hn.count = 9; }],
    ['an agent role changes', d => { d.firebuilt.agents[0].role = 'Something else entirely'; }],
    ['an agent model changes', d => { d.firebuilt.agents[0].model = 'some-new-model'; }],
    ['an agent gains a session', d => { d.firebuilt.agents[0].sessions = 1; d.firebuilt.total_sessions = 3; }],
    ['an agent works', d => { d.firebuilt.agents[0].last_activity = 1780000500; d.firebuilt.last_activity = 1780000500; }],
    ['the roster shrinks', d => { d.firebuilt.agents.pop(); d.firebuilt.agent_count = 6; }],
    // A refresh that fetched fine but FAILED to publish is a real incident.
    // The published payload must not claim everything is healthy.
    ['the last refresh failed', d => { d.pi_status.refresh.last_run.outcome = 'failed'; d.pi_status.refresh.last_run.error = 'push-to-gist.js failed'; }],
];
for (const [name, mutate] of cases) {
    const d = JSON.parse(JSON.stringify(base));
    mutate(d);
    check(name + ' -> different hash', fingerprint(d) !== h0);
}

console.log('\nkey order must not matter:');
const reordered = {};
for (const k of Object.keys(base).reverse()) reordered[k] = base[k];
check('reordered keys -> same hash', fingerprint(reordered) === h0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
