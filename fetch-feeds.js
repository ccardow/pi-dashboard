#!/usr/bin/env node
// ═══════════════════════════════════════════════
//  LIFE.OS — Dynamic Feed Fetcher v5
//  Zero API keys required. Pure RSS/Atom + Nitter mirrors.
//
//  Config:  feeds-config.json  ← edit THIS to manage follows
//
//  YouTube:   Public Atom feeds (youtube.com/feeds)
//  X / Twitter: Nitter RSS mirrors with retry/backoff
//  Hacker News: hnrss.org (news.ycombinator.com/rss rate-limits hard)
//  steipete:  steipete.me + steipete.com + Nutrient blog RSS
//  Pi status:  LIVE Hermes state (state.db + gateway_state.json + config.yaml)
//
//  Usage:
//    node fetch-feeds.js           # fetch + push to Gist
//    node fetch-feeds.js --dry-run # fetch only, no push
// ═══════════════════════════════════════════════

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DRY_RUN = process.argv.includes('--dry-run');
const NO_PUSH = process.argv.includes('--no-push');
const VIBES_PATH = path.join(__dirname, 'vibes.json');
const CONFIG_PATH = path.join(__dirname, 'feeds-config.json');

// ─── Load user config ───
var config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error('❌ Could not read feeds-config.json:', err.message);
    process.exit(1);
}

const YOUTUBE_CHANNELS = config.youtube || [];
const YOUTUBE_MAX = config.youtube_max || 6;
const X_HANDLES = config.x_handles || [];
const X_MAX = config.x_max || 10;
const HN_MAX = config.hn_max || 10;
const STEIPETE_MAX = config.steipete_max || 10;
const LOCATION = config.location || {
    label: 'Weather',
    latitude: 49.0503,
    longitude: -122.3476,
    timezone: 'America/Vancouver',
};

// ─── Nitter mirrors — tried in order, with retries on rate-limit ───
// Probed 2026-10-19: nitter.meowing.monster served all 10 configured handles;
// twiiit.com and nitter.cz cover most but 403 often; the rest are dead.
// Mirrors rate-limit aggressively, so each gets up to 3 tries with backoff.
const NITTER_INSTANCES = [
    'nitter.meowing.monster',
    'twiiit.com',
    'nitter.cz',
    'nitter.tiekoetter.com',
];
const MIRROR_ATTEMPTS = 3;

// ─── steipete blog feeds ───
const STEIPETE_FEEDS = [
    { name: 'steipete.me', url: 'https://steipete.me/rss.xml', tag: 'item' },
    { name: 'steipete.com', url: 'https://steipete.com/rss.xml', tag: 'item' },
    { name: 'Nutrient Blog', url: 'https://www.nutrient.io/blog/feed.xml', tag: 'item' },
];

// ─── HTTP GET with hard wall-clock timeout ───
// Key: req.destroy() is called on timeout so the socket is killed immediately.
// Without this, Node.js keeps the process alive waiting for the orphaned socket.
const TIMEOUT_MS = 8000;
function httpsGet(url, depth) {
    depth = depth || 0;
    return new Promise(function (resolve, reject) {
        if (depth > 6) return reject(new Error('Too many redirects'));
        var settled = false;
        function finish(fn, val) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(val);
        }
        var lib = url.startsWith('https') ? https : http;
        var req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; LIFE.OS/5.0 FeedBot)',
                'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*',
            }
        }, function (res) {
            if ([301, 302, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
                var loc = res.headers.location;
                var next = loc.startsWith('http') ? loc : new URL(loc, url).href;
                res.resume();
                return httpsGet(next, depth + 1)
                    .then(function (v) { finish(resolve, v); })
                    .catch(function (e) { finish(reject, e); });
            }
            if (res.statusCode !== 200) {
                res.resume();
                return finish(reject, new Error('HTTP ' + res.statusCode));
            }
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () { finish(resolve, data); });
        });
        req.on('error', function (e) { finish(reject, e); });
        // Hard deadline: destroy the socket so it releases the active handle
        var timer = setTimeout(function () {
            req.destroy();  // triggers 'error' → finish(reject, …) above
            finish(reject, new Error('Timeout after ' + TIMEOUT_MS + 'ms'));
        }, TIMEOUT_MS);
    });
}

// ─── Sleep helper (used for mirror rate-limit backoff) ───
function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ─── Extract XML tag value (handles CDATA) ───
function extractTag(xml, tag) {
    var cdataRe = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i');
    var cdataM = xml.match(cdataRe);
    if (cdataM) return cdataM[1].trim();
    var plainRe = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
    var plainM = xml.match(plainRe);
    return plainM ? plainM[1].replace(/<[^>]+>/g, '').trim() : null;
}

// ─── Decode common HTML entities ───
function decodeEntities(s) {
    if (!s) return s;
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
        .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
        .replace(/&amp;/g, '&');
}

// ─── Parse RSS/Atom feed items ───
function parseItems(xml, itemTag, maxItems) {
    maxItems = maxItems || 5;
    var items = [];
    var re = new RegExp('<' + itemTag + '[\\s>]([\\s\\S]*?)<\\/' + itemTag + '>', 'gi');
    var match;
    while ((match = re.exec(xml)) !== null && items.length < maxItems) {
        var chunk = match[0];
        var title = decodeEntities(extractTag(chunk, 'title') || '').trim();
        // Link: RSS uses <link>, Atom uses <link href="...">
        var link = extractTag(chunk, 'link') || '';
        if (!link || link.indexOf('<') !== -1) {
            var hrefM = chunk.match(/<link[^>]+href="([^"]+)"/i);
            if (hrefM) link = hrefM[1];
        }
        link = decodeEntities((link || '#').trim());
        var pubDate = extractTag(chunk, 'pubDate') || extractTag(chunk, 'published') || extractTag(chunk, 'updated') || '';
        if (title && title.length > 3) {
            items.push({ title: title, link: link, pubDate: pubDate, chunk: chunk });
        }
    }
    return items;
}

// ─── Fetch YouTube channels ───
async function fetchYouTube() {
    console.log('\n📺 Fetching YouTube channels... (' + YOUTUBE_CHANNELS.length + ' channels)');
    var allVideos = [];

    for (var i = 0; i < YOUTUBE_CHANNELS.length; i++) {
        var ch = YOUTUBE_CHANNELS[i];
        var url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.id;
        try {
            var xml = await httpsGet(url);
            var items = parseItems(xml, 'entry', 3);

            // Extract all videoIds per entry (fix: was reading from whole XML, not per entry)
            var entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
            var entryMatch;
            var entryIdx = 0;
            while ((entryMatch = entryRe.exec(xml)) !== null && entryIdx < items.length) {
                var entryChunk = entryMatch[0];
                var ytIdMatch = entryChunk.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
                var item = items[entryIdx];
                var vidMatch = item.link.match(/v=([a-zA-Z0-9_-]{11})/);
                var videoId = vidMatch ? vidMatch[1] : (ytIdMatch ? ytIdMatch[1] : null);
                allVideos.push({
                    title: item.title,
                    channel: ch.name,
                    url: videoId ? 'https://www.youtube.com/watch?v=' + videoId : item.link,
                    published: item.pubDate,
                });
                entryIdx++;
            }
            console.log('  ✓ ' + ch.name + ': ' + items.length + ' videos');
        } catch (err) {
            console.warn('  ✗ ' + ch.name + ': ' + err.message);
        }
    }

    allVideos.sort(function (a, b) { return new Date(b.published) - new Date(a.published); });
    var top = allVideos.slice(0, YOUTUBE_MAX);
    console.log('  → ' + top.length + ' videos selected');
    return top.length > 0 ? top : null;
}

// ─── Fetch X posts via Nitter mirrors ───
// Mirrors rate-limit aggressively (403) and a 200 can still carry zero items
// (Cloudflare interstitial). Strategy: walk the mirror list; for each mirror
// retry up to MIRROR_ATTEMPTS times with backoff, requiring a non-empty item
// list before accepting the result.
async function fetchXPosts() {
    console.log('\n𝕏 Fetching X posts... (' + X_HANDLES.length + ' handles)');
    var allPosts = [];

    for (var i = 0; i < X_HANDLES.length; i++) {
        var handle = X_HANDLES[i].replace(/^@/, '');
        var got = 0;

        for (var m = 0; m < NITTER_INSTANCES.length && got === 0; m++) {
            var instance = NITTER_INSTANCES[m];
            var url = 'https://' + instance + '/' + handle + '/rss';

            for (var attempt = 0; attempt < MIRROR_ATTEMPTS && got === 0; attempt++) {
                if (attempt > 0) await sleep(3000 * attempt);  // back off before retrying
                try {
                    var xml = await httpsGet(url);
                    var items = parseItems(xml, 'item', 3);
                    if (items.length === 0) continue;

                    for (var j = 0; j < items.length; j++) {
                        var item = items[j];
                        allPosts.push({
                            user: handle,
                            topic: inferTopic(item.title),
                            content: item.title,
                            url: item.link || ('https://x.com/' + handle),
                            published: item.pubDate || new Date().toISOString(),
                        });
                    }
                    got = items.length;
                    console.log('  ✓ @' + handle + ': ' + items.length + ' posts (' + instance + ')');
                } catch (err) {
                    if (attempt === MIRROR_ATTEMPTS - 1) {
                        console.warn('  ✗ @' + handle + ' via ' + instance + ': ' + err.message);
                    }
                }
            }
        }
        if (got === 0) console.warn('  ✗ @' + handle + ': no mirror served this handle');
    }

    // Newest first, then cap
    allPosts.sort(function (a, b) { return new Date(b.published) - new Date(a.published); });
    var top = allPosts.slice(0, X_MAX);
    console.log('  → ' + top.length + ' posts selected (from ' + allPosts.length + ' fetched)');
    return top.length > 0 ? top : null;
}

// ─── Fetch Hacker News (hnrss.org — the official RSS rate-limits hard) ───
async function fetchHackerNews() {
    console.log('\n⌁ Fetching Hacker News...');
    var feeds = [
        'https://hnrss.org/frontpage?points=150',
        'https://hnrss.org/frontpage',
    ];
    var allPosts = [];
    for (var i = 0; i < feeds.length && allPosts.length === 0; i++) {
        try {
            var xml = await httpsGet(feeds[i]);
            var items = parseItems(xml, 'item', HN_MAX);
            for (var j = 0; j < items.length; j++) {
                var item = items[j];
                allPosts.push({
                    user: 'Hacker News',
                    topic: inferTopic(item.title),
                    content: item.title,
                    url: item.link,
                    published: item.pubDate || new Date().toISOString(),
                });
            }
            console.log('  ✓ ' + allPosts.length + ' stories');
        } catch (err) {
            console.warn('  ✗ ' + feeds[i] + ': ' + err.message);
        }
    }
    return allPosts.length > 0 ? allPosts : null;
}

// ─── Fetch steipete blog posts ───
async function fetchSteipete() {
    console.log('\n◉ Fetching @steipete blog posts... (max ' + STEIPETE_MAX + ')');
    var allPosts = [];

    for (var i = 0; i < STEIPETE_FEEDS.length; i++) {
        var feed = STEIPETE_FEEDS[i];
        try {
            var xml = await httpsGet(feed.url);
            var items = parseItems(xml, feed.tag, STEIPETE_MAX);
            for (var j = 0; j < items.length; j++) {
                var item = items[j];
                allPosts.push({
                    topic: inferTopic(item.title),
                    content: item.title.substring(0, 280),
                    url: item.link,
                    published: item.pubDate,
                });
            }
            console.log('  ✓ ' + feed.name + ': ' + items.length + ' posts');
        } catch (err) {
            console.warn('  ✗ ' + feed.name + ': ' + err.message);
        }
    }

    allPosts.sort(function (a, b) { return new Date(b.published) - new Date(a.published); });
    var top = allPosts.slice(0, STEIPETE_MAX);
    console.log('  → ' + top.length + ' posts selected');
    return top.length > 0 ? top : null;
}

// ─── Fetch US/Canada geopolitics news ───
async function fetchGeopolitics() {
    console.log('\n◆ Fetching US/Canada geopolitics...');
    var feeds = [
        { name: 'Globe Politics', url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/politics/', tag: 'item' },
        { name: 'CBC World', url: 'https://www.cbc.ca/cmlink/rss-world', tag: 'item' },
        { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', tag: 'item' },
        { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', tag: 'item' },
        { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', tag: 'item' },
        { name: 'CBC Canada', url: 'https://www.cbc.ca/webfeed/rss/rss-canada', tag: 'item' },
    ];
    var GEO_KEYWORDS = ['canada', 'tariff', 'trump', 'trudeau', 'carney', 'mark', 'us-canada',
        '51st state', 'annexation', 'trade war', 'nafta', 'usmca', 'ottawa',
        'american', 'biden', 'border', 'customs'];
    var GEO_MAX = 5;
    var allItems = [];

    for (var i = 0; i < feeds.length; i++) {
        var feed = feeds[i];
        try {
            var xml = await httpsGet(feed.url);
            var items = parseItems(xml, feed.tag, 20);
            for (var j = 0; j < items.length; j++) {
                var item = items[j];
                var tl = item.title.toLowerCase();
                var relevant = GEO_KEYWORDS.some(function (kw) { return tl.indexOf(kw) !== -1; });
                if (relevant) {
                    allItems.push({
                        title: item.title,
                        url: item.link,
                        summary: item.title,          // dashboard uses summary field
                        source: feed.name,
                        published: item.pubDate,
                    });
                }
            }
            console.log('  ✓ ' + feed.name + ': ' + items.length + ' scanned');
        } catch (err) {
            console.warn('  ✗ ' + feed.name + ': ' + err.message);
        }
    }

    allItems.sort(function (a, b) { return new Date(b.published) - new Date(a.published); });
    var top = allItems.slice(0, GEO_MAX);
    console.log('  → ' + top.length + ' geopolitics articles');
    if (top.length === 0) return null;

    // Build a one-liner vibe string from the top headline
    var vibeStr = '⚠ ' + top[0].title.replace(/["]/g, "'");
    return { news: top, vibes: vibeStr };
}

// ─── Infer topic from text ───
function inferTopic(text) {
    var t = (text || '').toLowerCase();
    if (t.indexOf('ai') !== -1 || t.indexOf('llm') !== -1 || t.indexOf('openai') !== -1 || t.indexOf('gemini') !== -1 || t.indexOf('claude') !== -1 || t.indexOf('gpt') !== -1 || t.indexOf('model') !== -1 || t.indexOf('deepseek') !== -1 || t.indexOf('anthropic') !== -1) return 'AI / ML';
    if (t.indexOf('security') !== -1 || t.indexOf('hack') !== -1 || t.indexOf('breach') !== -1 || t.indexOf('vuln') !== -1 || t.indexOf('malware') !== -1) return 'Security';
    if (t.indexOf('apple') !== -1 || t.indexOf('ios') !== -1 || t.indexOf('iphone') !== -1 || t.indexOf('swift') !== -1 || t.indexOf('xcode') !== -1 || t.indexOf('pspdf') !== -1 || t.indexOf('nutrient') !== -1) return 'Apple / iOS';
    if (t.indexOf('canada') !== -1 || t.indexOf('trump') !== -1 || t.indexOf('tariff') !== -1 || t.indexOf('politic') !== -1 || t.indexOf('election') !== -1 || t.indexOf('maga') !== -1) return 'Geopolitics';
    if (t.indexOf('startup') !== -1 || t.indexOf('fund') !== -1 || t.indexOf('vc') !== -1 || t.indexOf('invest') !== -1 || t.indexOf('raise') !== -1 || t.indexOf('saas') !== -1) return 'Venture';
    if (t.indexOf('agent') !== -1 || t.indexOf('automation') !== -1 || t.indexOf('workflow') !== -1) return 'Agents';
    if (t.indexOf('seo') !== -1 || t.indexOf('search') !== -1 || t.indexOf('content') !== -1 || t.indexOf('marketing') !== -1) return 'Marketing';
    if (t.indexOf('open source') !== -1 || t.indexOf('github') !== -1 || t.indexOf('release') !== -1) return 'Open Source';
    return 'Tech Intel';
}

// ─── Fetch Weather (Open-Meteo, free, no API key) ───
async function fetchWeather() {
    console.log('\n🌤 Fetching ' + LOCATION.label + '...');
    var url = 'https://api.open-meteo.com/v1/forecast'
        + '?latitude=' + LOCATION.latitude + '&longitude=' + LOCATION.longitude
        + '&current=temperature_2m,apparent_temperature,weather_code'
        + '&daily=temperature_2m_max,temperature_2m_min'
        + '&timezone=' + LOCATION.timezone
        + '&forecast_days=1';
    var raw = await httpsGet(url);
    var data = JSON.parse(raw);
    var cur = data.current || {};
    var daily = data.daily || {};

    // Map WMO weather codes to readable conditions
    var code = cur.weather_code || 0;
    var condition = 'Clear';
    if (code <= 0) condition = 'Clear';
    else if (code <= 3) condition = ['Clear', 'Mostly Clear', 'Partly Cloudy', 'Overcast'][code];
    else if (code <= 49) condition = 'Fog';
    else if (code <= 59) condition = 'Drizzle';
    else if (code <= 69) condition = 'Rain';
    else if (code <= 79) condition = 'Snow';
    else if (code <= 82) condition = 'Rain Showers';
    else if (code <= 86) condition = 'Snow Showers';
    else if (code === 95) condition = 'Thunderstorm';
    else if (code >= 96) condition = 'Thunderstorm + Hail';

    var weather = {
        label: LOCATION.label,
        latitude: LOCATION.latitude,
        longitude: LOCATION.longitude,
        timezone: LOCATION.timezone,
        temp: String(Math.round(cur.temperature_2m || 0)),
        condition: condition,
        feels_like: String(Math.round(cur.apparent_temperature || 0)),
        hi: String(Math.round((daily.temperature_2m_max || [0])[0])),
        lo: String(Math.round((daily.temperature_2m_min || [0])[0])),
        updated: new Date().toLocaleString('en-US', {
            timeZone: LOCATION.timezone,
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }),
    };
    console.log('  ✓ ' + weather.temp + '°C, ' + weather.condition + ' (feels ' + weather.feels_like + '°C)');
    return weather;
}

// ─── Fetch Daily Verse ───
// bible-api.com's /random endpoint was removed (404s), so the old client-side
// fetch silently failed and the card froze on its hardcoded HTML default.
// The API still serves the full Bible hierarchically:
//   /data/{translation}            -> list of books
//   /data/{translation}/{BOOK}     -> chapters
//   /data/{translation}/{BOOK}/{CH}-> verses
// Selection is seeded by the date so the verse is stable for the whole day
// and rolls over at midnight, rather than changing on every page load.
const BIBLE_TRANSLATION = 'kjv';
const BIBLE_BOOKS = [
    'GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH',
    'EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS',
    'JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL','MAT','MRK','LUK',
    'JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT',
    'PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV',
];

// Deterministic 32-bit hash of a string — same input, same output, forever.
function hashString(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
}

// Mulberry32 PRNG — small, fast, good enough for picking a verse.
function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function fetchDailyVerse() {
    console.log('\n✝ Fetching daily verse...');
    var tz = LOCATION.timezone;
    // Use the location's calendar day so the verse rolls over at local midnight.
    var dayKey = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    var rng = makeRng(hashString(dayKey + '|' + BIBLE_TRANSLATION));

    // Pick book, then load only that book's chapter list.
    var bookId = BIBLE_BOOKS[Math.floor(rng() * BIBLE_BOOKS.length)];
    var bookData;
    try {
        bookData = JSON.parse(await httpsGet('https://bible-api.com/data/' + BIBLE_TRANSLATION + '/' + bookId));
    } catch (err) {
        console.warn('  ✗ book ' + bookId + ': ' + err.message);
        return null;
    }
    var chapters = bookData.chapters || [];
    if (chapters.length === 0) {
        console.warn('  ✗ book ' + bookId + ': no chapters');
        return null;
    }

    // Pick chapter, then load only that chapter's verses.
    var chapterNum = chapters[Math.floor(rng() * chapters.length)].chapter;
    var chapterData;
    try {
        chapterData = JSON.parse(await httpsGet('https://bible-api.com/data/' + BIBLE_TRANSLATION + '/' + bookId + '/' + chapterNum));
    } catch (err) {
        console.warn('  ✗ chapter ' + bookId + ' ' + chapterNum + ': ' + err.message);
        return null;
    }
    var verses = chapterData.verses || [];
    if (verses.length === 0) {
        console.warn('  ✗ chapter ' + bookId + ' ' + chapterNum + ': no verses');
        return null;
    }

    var verse = verses[Math.floor(rng() * verses.length)];
    var text = (verse.text || '').replace(/\s+/g, ' ').trim();
    var bookName = verse.book || bookId;
    var reference = bookName + ' ' + verse.chapter + ':' + verse.verse;

    console.log('  ✓ ' + reference + ' (' + dayKey + ')');
    return {
        text: text,
        reference: reference,
        translation: BIBLE_TRANSLATION,
        date: dayKey,
    };
}

// ═══════════════════════════════════════════════
//  Pi Status — LIVE Hermes state
//  Reads: state.db (sessions/tokens), gateway_state.json, config.yaml
// ═══════════════════════════════════════════════
const HERMES_HOME = process.env.HERMES_HOME || '/home/cam/.hermes';

function readJsonSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return null; }
}

// Query Hermes' state.db for the most recent sessions.
function readHermesSessions(limit) {
    var dbPath = path.join(HERMES_HOME, 'state.db');
    if (!fs.existsSync(dbPath)) return [];
    try {
        // node:sqlite is built into Node 22+ — no native deps needed.
        var { DatabaseSync } = require('node:sqlite');
        var db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            var stmt = db.prepare(
                'SELECT id, source, model, profile_name, message_count, tool_call_count, ' +
                'input_tokens, output_tokens, started_at, last_activity_at, title ' +
                'FROM sessions ' +
                'ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?'
            );
            return stmt.all(limit);
        } finally {
            db.close();
        }
    } catch (e) {
        console.warn('  ⚠ state.db read failed: ' + e.message);
        return [];
    }
}

// Total token/tool spend across all sessions.
function readHermesTokenTotals() {
    var dbPath = path.join(HERMES_HOME, 'state.db');
    if (!fs.existsSync(dbPath)) return null;
    try {
        var { DatabaseSync } = require('node:sqlite');
        var db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            var stmt = db.prepare(
                'SELECT COUNT(*) AS sessions, ' +
                'COALESCE(SUM(input_tokens),0) AS input_tokens, ' +
                'COALESCE(SUM(output_tokens),0) AS output_tokens, ' +
                'COALESCE(SUM(tool_call_count),0) AS tool_calls ' +
                'FROM sessions'
            );
            return stmt.get();
        } finally {
            db.close();
        }
    } catch (e) {
        return null;
    }
}

// Read the live model/provider out of config.yaml without a YAML dep.
// config.yaml nests them like:
//   model:
//   - default: minimax/minimax-m3.1-flash:free
//     provider: openrouter
// The list items are NOT indented, so a plain "top-level key ends the block"
// rule would stop immediately. Track the block by scanning forward until a
// non-list, non-indented key appears.
function readConfigModel() {
    var cfgPath = path.join(HERMES_HOME, 'config.yaml');
    if (!fs.existsSync(cfgPath)) return null;
    try {
        var lines = fs.readFileSync(cfgPath, 'utf8').split('\n');
        var out = {};
        var inModel = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!inModel) {
                if (/^model:\s*$/.test(line)) inModel = true;
                continue;
            }
            // Blank line or comment — skip, don't end the block.
            if (line.trim() === '' || /^\s*#/.test(line)) continue;
            // A new top-level mapping key ends the model block.
            if (/^[A-Za-z_][\w-]*:/.test(line)) break;
            // Accept "- default: x" and nested "  provider: y"
            var m = line.match(/^\s*(?:-\s*)?([\w.-]+):\s*(.+?)\s*$/);
            if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
        return out.default ? { model: out.default, provider: out.provider || 'unknown' } : null;
    } catch (e) {
        return null;
    }
}

// Context window (in k) for a model, from the cached context_length_cache.yaml.
function readContextWindow(modelId) {
    if (!modelId) return 256;
    var cachePath = path.join(HERMES_HOME, 'context_length_cache.yaml');
    // cache keys look like "minimax-m3@https://ollama.com/v1" — match on model stem
    var stem = modelId.split('/').pop().split(':')[0];
    try {
        if (fs.existsSync(cachePath)) {
            var txt = fs.readFileSync(cachePath, 'utf8');
            var m = txt.match(new RegExp('^\\s*' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '@[^:]+:\\s*(\\d+)', 'm'));
            if (m) return Math.round(parseInt(m[1], 10) / 1000);
        }
    } catch (e) { /* fall through to default */ }
    return 256;
}

function fetchPiStatus() {
    console.log('\n🥧 Reading live Hermes state...');
    var gw = readJsonSafe(path.join(HERMES_HOME, 'gateway_state.json'));
    var cfg = readConfigModel();
    var sess = readHermesSessions(6);
    var totals = readHermesTokenTotals();

    if (!gw && !cfg) {
        console.warn('  ✗ no Hermes state found at ' + HERMES_HOME);
        return null;
    }

    // Live session = most recent row
    var live = sess[0] || null;
    var modelId = (live && live.model) || (cfg && cfg.model) || 'unknown';
    var provider = (cfg && cfg.provider) || 'hermes';

    // Token usage of the live session
    var usedK = live
        ? Math.round(((live.input_tokens || 0) + (live.output_tokens || 0)) / 1000)
        : 0;
    var contextWindow = readContextWindow(modelId);

    // Activity log: recent sessions as terminal-style lines
    var logs = sess.map(function (s) {
        var ts = new Date((s.last_activity_at || s.started_at) * 1000);
        var timeStr = ts.toLocaleTimeString('en-US', {
            timeZone: LOCATION.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
        });
        var who = s.profile_name || 'default';
        var kind = (s.source || 'sess').toUpperCase();
        return {
            time: timeStr,
            msg: who + '/' + kind + ': ' + (s.model || '?') + ' · ' +
                 (s.message_count || 0) + ' msgs · ' + (s.tool_call_count || 0) + ' tools',
        };
    });

    // Roadmap derived from live state
    var roadmap = [];
    if (gw) {
        roadmap.push({
            name: 'Hermes Gateway',
            status: (gw.gateway_state || 'unknown') + ' · v' + (gw.code_version || '?') + ' · pid ' + (gw.pid || '?'),
        });
        if (gw.served_profiles && gw.served_profiles.length) {
            roadmap.push({
                name: 'Agent Profiles',
                status: gw.served_profiles.length + ' served (' + gw.served_profiles.join(', ') + ')',
            });
        }
        if (gw.active_agents) {
            roadmap.push({ name: 'Active Agents', status: String(gw.active_agents) });
        }
    }
    if (totals) {
        roadmap.push({
            name: 'Session Ledger',
            status: totals.sessions + ' sessions · ' +
                     Math.round((totals.input_tokens + totals.output_tokens) / 1000) + 'k tokens · ' +
                     totals.tool_calls + ' tool calls',
        });
    }

    var status = {
        status: gw && gw.gateway_state === 'running' ? 'ONLINE' : 'DEGRADED',
        activity: 'Hermes Gateway · ' + modelId + ' via ' + provider,
        model: {
            name: provider + '/' + modelId,
            tokens_used: usedK,
            tokens_total: contextWindow,
        },
        logs: logs,
        gateway: gw ? {
            pid: gw.pid,
            version: gw.code_version,
            state: gw.gateway_state,
            uptime_seconds: gw.start_time,
            profiles: gw.served_profiles || [],
            active_agents: gw.active_agents || 0,
        } : null,
        totals: totals,
        roadmap: roadmap,
        lastUpdate: new Date().toLocaleString('en-US', {
            timeZone: LOCATION.timezone,
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }),
    };
    console.log('  ✓ Model: ' + status.model.name);
    console.log('  ✓ Gateway: ' + (gw ? gw.gateway_state : 'n/a') + ' · ' + logs.length + ' recent sessions');
    return status;
}

// ─── Main ───
async function main() {
    console.log('═══════════════════════════════════════');
    console.log(' LIFE.OS Feed Fetcher v5');
    console.log('  ' + new Date().toLocaleString('en-US', { timeZone: LOCATION.timezone }));
    console.log('  Mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE (push to Gist)'));
    console.log('  Config: ' + X_HANDLES.length + ' X handles, ' + YOUTUBE_CHANNELS.length + ' YT channels');
    console.log('═══════════════════════════════════════');

    // Seed from the live Gist so we preserve fields we don't own (weather, pi_status, etc.)
    // Falls back to local vibes.json, then to {} if both fail.
    var GIST_RAW = 'https://gist.githubusercontent.com/ccardow/e65c6cfabb1fbc98983381da98801408/raw/vibes.json';
    var vibes = {};
    try {
        console.log('  Seeding from live Gist...');
        var gistRaw = await httpsGet(GIST_RAW);
        if (gistRaw && gistRaw.trim()) vibes = JSON.parse(gistRaw);
        console.log('  ✓ Gist seed OK (weather/pi_status preserved)');
    } catch (e) {
        console.warn('  ⚠ Gist seed failed (' + e.message + '), trying local vibes.json...');
        try {
            var localRaw = fs.readFileSync(VIBES_PATH, 'utf8').trim();
            if (localRaw) vibes = JSON.parse(localRaw);
        } catch (e2) {
            console.warn('  ⚠ Local vibes.json unreadable, starting fresh.');
        }
    }

    // Second-chance seed: any feed that fails this run falls back to the last
    // known-good value instead of blanking its card. Without this, one
    // transient upstream failure empties a card until the next successful run.
    var previous = {};
    try {
        var prevRaw = fs.readFileSync(VIBES_PATH, 'utf8').trim();
        if (prevRaw) previous = JSON.parse(prevRaw);
    } catch (e3) { /* no local history — fine */ }

    var results = await Promise.all([
        fetchYouTube().catch(function (err) { console.error('YouTube fatal:', err.message); return null; }),
        fetchXPosts().catch(function (err) { console.error('X fatal:', err.message); return null; }),
        fetchHackerNews().catch(function (err) { console.error('HN fatal:', err.message); return null; }),
        fetchSteipete().catch(function (err) { console.error('steipete fatal:', err.message); return null; }),
        fetchGeopolitics().catch(function (err) { console.error('Geo fatal:', err.message); return null; }),
        fetchWeather().catch(function (err) { console.error('Weather fatal:', err.message); return null; }),
        fetchDailyVerse().catch(function (err) { console.error('Verse fatal:', err.message); return null; }),
    ]);

    // Pi status is sync (local filesystem), run separately
    var piStatus = null;
    try { piStatus = fetchPiStatus(); }
    catch (err) { console.error('Pi status fatal:', err.message); }

    var youtube = results[0];
    var xPosts = results[1];
    var hnPosts = results[2];
    var peterX = results[3];
    var geoData = results[4];
    var weather = results[5];
    var verse = results[6];
    var updated = false;

    if (youtube && youtube.length > 0) {
        vibes.youtube = youtube;
        updated = true;
        console.log('\n✅ YouTube: ' + youtube.length + ' videos');
    } else if (previous.youtube && previous.youtube.length) {
        vibes.youtube = previous.youtube;
        console.log('⚠ YouTube: fetch failed, keeping last known-good (' + previous.youtube.length + ' videos)');
    }
    if (xPosts && xPosts.length > 0) {
        vibes.x_posts = xPosts;
        updated = true;
        console.log('✅ X Personalities: ' + xPosts.length + ' posts');
    } else if (previous.x_posts && previous.x_posts.length) {
        vibes.x_posts = previous.x_posts;
        console.log('⚠ X: fetch failed, keeping last known-good (' + previous.x_posts.length + ' posts)');
    }
    if (hnPosts && hnPosts.length > 0) {
        vibes.hn_posts = hnPosts;
        updated = true;
        console.log('✅ Hacker News: ' + hnPosts.length + ' stories');
    } else if (previous.hn_posts && previous.hn_posts.length) {
        vibes.hn_posts = previous.hn_posts;
        console.log('⚠ Hacker News: fetch failed, keeping last known-good (' + previous.hn_posts.length + ' stories)');
    }
    if (peterX && peterX.length > 0) {
        vibes.peter_x = peterX;
        updated = true;
        console.log('✅ steipete: ' + peterX.length + ' posts');
    } else if (previous.peter_x && previous.peter_x.length) {
        vibes.peter_x = previous.peter_x;
        console.log('⚠ steipete: fetch failed, keeping last known-good');
    }
    if (geoData && geoData.news && geoData.news.length > 0) {
        vibes.news = geoData.news;
        vibes.vibes = geoData.vibes;
        updated = true;
        console.log('✅ US/Canada Geo: ' + geoData.news.length + ' articles');
    } else if (previous.news && previous.news.length) {
        vibes.news = previous.news;
        if (previous.vibes) vibes.vibes = previous.vibes;
        console.log('⚠ Geo: fetch failed, keeping last known-good');
    }
    if (weather) {
        vibes.weather = weather;
        updated = true;
        console.log('✅ Weather: ' + weather.temp + '°C ' + weather.condition);
    } else if (previous.weather) {
        vibes.weather = previous.weather;
        console.log('⚠ Weather: fetch failed, keeping last known-good');
    }
    if (verse && verse.text) {
        vibes.verse = verse;
        updated = true;
        console.log('✅ Daily Verse: ' + verse.reference);
    } else if (previous.verse && previous.verse.text) {
        vibes.verse = previous.verse;
        console.log('⚠ Daily Verse: fetch failed, keeping last known-good (' + previous.verse.reference + ')');
    }
    if (piStatus) {
        vibes.pi_status = piStatus;
        updated = true;
        console.log('✅ Pi Intelligence: ' + piStatus.model.name);
    }

    vibes.lastUpdate = new Date().toLocaleString('en-US', {
        timeZone: LOCATION.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });

    if (!updated) {
        console.warn('\n⚠ No feeds updated. vibes.json unchanged.');
        process.exit(1);
    }

    fs.writeFileSync(VIBES_PATH, JSON.stringify(vibes, null, 2));
    console.log('\n💾 vibes.json written');

    // Also write vibes.js for local file:// access (JSONP)
    var vibesJsContent = 'window.__DASHBOARD_DATA_CALLBACK__(' + JSON.stringify(vibes, null, 2) + ');';
    fs.writeFileSync(path.join(__dirname, 'vibes.js'), vibesJsContent);
    console.log('💾 vibes.js written (for local file:// access)');

    if (DRY_RUN) {
        console.log('\n🔍 DRY RUN — Gist push skipped. Sample:');
        if (vibes.youtube && vibes.youtube[0]) console.log('  YouTube[0]:', JSON.stringify(vibes.youtube[0]));
        if (vibes.x_posts && vibes.x_posts[0]) console.log('  X[0]:', JSON.stringify(vibes.x_posts[0]));
        if (vibes.hn_posts && vibes.hn_posts[0]) console.log('  HN[0]:', JSON.stringify(vibes.hn_posts[0]));
        if (vibes.peter_x && vibes.peter_x[0]) console.log('  steipete[0]:', JSON.stringify(vibes.peter_x[0]));
        if (vibes.news && vibes.news[0]) console.log('  News[0]:', JSON.stringify(vibes.news[0]));
        console.log('  vibes:', vibes.vibes || '(none)');
        console.log('  pi_status:', vibes.pi_status ? vibes.pi_status.activity : '(none)');
        return;
    }

    if (NO_PUSH) {
        console.log('\n📦 --no-push — data written locally, skipping Gist push.');
        return;
    }

    console.log('\n🚀 Pushing to GitHub Gist...');
    try {
        execSync('node push-to-gist.js', { cwd: __dirname, stdio: 'inherit' });
        console.log('✅ Gist updated — dashboard refreshes within 5 min');
    } catch (err) {
        console.error('❌ Gist push failed:', err.message);
        process.exit(1);
    }

    console.log('\n═══════════════════════════════════════');
    console.log(' Sync complete!');
    console.log('═══════════════════════════════════════');
}

main().then(function () {
    process.exit(0);
}).catch(function (err) {
    console.error('Fatal:', err);
    process.exit(1);
});
