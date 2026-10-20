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
function httpsGet(url, depth, extraHeaders, timeoutMs) {
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
        var headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; LIFE.OS/5.0 FeedBot)',
            'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*',
        };
        // Some APIs (YouVersion) need a request header of their own.
        if (extraHeaders) {
            for (var h in extraHeaders) {
                if (Object.prototype.hasOwnProperty.call(extraHeaders, h)) headers[h] = extraHeaders[h];
            }
        }
        var req = lib.get(url, {
            headers: headers,
        }, function (res) {
            if ([301, 302, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
                var loc = res.headers.location;
                var next = loc.startsWith('http') ? loc : new URL(loc, url).href;
                res.resume();
                // Carry the custom headers across the redirect.
                return httpsGet(next, depth + 1, extraHeaders, timeoutMs)
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
            finish(reject, new Error('Timeout after ' + (timeoutMs || TIMEOUT_MS) + 'ms'));
        }, timeoutMs || TIMEOUT_MS);
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
//
// Mirrors rate-limit aggressively (403) and a 200 can still carry zero items
// (Cloudflare interstitial). Strategy: walk the mirror list; for each mirror
// retry up to MIRROR_ATTEMPTS times with backoff, requiring a non-empty item
// list before accepting the result.
//
// The mirror list is the fragile part: these are public Nitter mirrors
// that can vanish, and 1 of 4 was serving at the time of writing.
//
// The retry structure is 10 handles x 4 mirrors x 3 attempts, and each
// attempt can burn the full 8 second request timeout. That is up to
// 120 requests, and a run where the mirrors are all down took 32
// minutes — long enough to blow past the systemd start timeout and
// block every later cycle.
//
// So the whole X fetch has a wall-clock deadline. When it expires the
// loop stops trying mirrors and returns whatever it has. Losing the
// remaining handles is far better than stalling the pipeline.
//
// A side benefit: a fast mirror is tried first for every handle, so the
// deadline almost never bites in normal operation. The fetch normally
// completes in well under a minute.
const X_FETCH_DEADLINE_MS = Number(process.env.X_FETCH_DEADLINE_MS) || 180000; // 3 minutes

async function fetchXPosts() {
    console.log('\n𝕏 Fetching X posts... (' + X_HANDLES.length + ' handles)');
    var allPosts = [];
    var deadline = Date.now() + X_FETCH_DEADLINE_MS;
    var timedOut = false;

    for (var i = 0; i < X_HANDLES.length; i++) {
        var handle = X_HANDLES[i].replace(/^@/, '');
        var got = 0;

        for (var m = 0; m < NITTER_INSTANCES.length && got === 0; m++) {
            var instance = NITTER_INSTANCES[m];
            var url = 'https://' + instance + '/' + handle + '/rss';

            for (var attempt = 0; attempt < MIRROR_ATTEMPTS && got === 0; attempt++) {
                if (Date.now() > deadline) {
                    timedOut = true;
                    break;
                }
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
            if (timedOut) break;
        }
        if (timedOut) {
            console.warn('  ⚠ X fetch hit its ' + (X_FETCH_DEADLINE_MS / 1000) +
                         's deadline — stopping mirror retries');
            break;
        }
        if (got === 0) console.warn('  ✗ @' + handle + ': no mirror served this handle');
    }

    // Newest first, then cap
    allPosts.sort(function (a, b) { return new Date(b.published) - new Date(a.published); });
    var top = allPosts.slice(0, X_MAX);
    console.log('  → ' + top.length + ' posts selected (from ' + allPosts.length + ' fetched)');
    fetchXPosts.timedOut = timedOut;
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

// ─── Fetch Daily Verse — YouVersion ───
//
// The YouVersion Platform publishes a real editorial "Verse of the Day"
// calendar — the verse its own Bible App shows. That is a meaningfully
// better daily card than a date-seeded random pick: it is curated, and
// it changes on its own.
//
// Three requests:
//   GET /v1/verse-of-the-days/{day}       -> { passage_id }   (day of year)
//   GET /v1/bibles/{id}/passages/{pid}    -> { content, reference }
//   GET /v1/bibles/{id}                  -> { abbreviation, title, copyright }
//
// The third one exists because YouVersion REQUIRES attribution when
// Bible text is displayed: the version abbreviation plus its copyright
// line. Their own SDK fails rather than return a display model with no
// usable attribution.
//
// The app key comes from the environment (YVP_APP_KEY), which the refresh
// timer sources from ~/.config/lifeos/lifeos.env. Without it, the caller
// falls back to bible-api.com.

const YVP_API = process.env.YVP_API || 'https://api.youversion.com';
const YVP_BIBLE_ID = process.env.YVP_BIBLE_ID || '3034'; // 3034 = BSB, public domain

// Day of the year (1-366) in the dashboard's timezone.
//
// This MUST use the local calendar day, not UTC. At 17:00 in Abbotsford
// it is already the next day in UTC, so a UTC-based day number would
// show tomorrow's verse every evening.
function dayOfYearInZone(tz) {
    var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    var y = 0, m = 1, d = 1;
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'year') y = parseInt(parts[i].value, 10);
        else if (parts[i].type === 'month') m = parseInt(parts[i].value, 10);
        else if (parts[i].type === 'day') d = parseInt(parts[i].value, 10);
    }
    // Days from the local Jan 1 to the local date, in UTC terms so DST
    // cannot shift the count.
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}

// GET with the YouVersion app key header.
//
// The endpoint is fast on its own — around 50ms — but the fetcher runs
// a dozen feeds concurrently, and under that load a request can sit in
// the socket queue long enough to blow the default 8 second budget. It
// did exactly that once, and the verse silently fell back to the random
// bible-api.com pick. So: a longer budget for this API, and one retry.
const YVP_TIMEOUT_MS = 20000;

async function yvpGet(path) {
    var lastError = null;
    for (var attempt = 0; attempt < 2; attempt++) {
        try {
            var raw = await httpsGet(YVP_API + path, 0, {
                'X-YVP-App-Key': process.env.YVP_APP_KEY,
                'Accept': 'application/json',
            }, YVP_TIMEOUT_MS);
            return JSON.parse(raw);
        } catch (err) {
            lastError = err;
            if (attempt === 0) {
                console.warn('  ⚠ YouVersion request failed (' + err.message + ') — retrying');
            }
        }
    }
    throw lastError;
}

async function fetchVerseYouVersion() {
    var appKey = process.env.YVP_APP_KEY;
    if (!appKey) return null; // caller falls back

    var tz = LOCATION.timezone;
    var day = dayOfYearInZone(tz);
    var dayKey = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    var votd = await yvpGet('/v1/verse-of-the-days/' + day);
    if (!votd || !votd.passage_id) throw new Error('verse-of-the-days returned no passage_id');

    var passage = await yvpGet(
        '/v1/bibles/' + YVP_BIBLE_ID + '/passages/' + encodeURIComponent(votd.passage_id) + '?format=text'
    );
    if (!passage || !passage.content) throw new Error('passage returned no content');

    // Attribution is required. If the version metadata cannot be read,
    // fall back to the passage's own reference rather than displaying
    // unattributed scripture.
    var attribution = null;
    var abbr = null;
    var version = null;
    try {
        var meta = await yvpGet('/v1/bibles/' + YVP_BIBLE_ID);
        abbr = meta.abbreviation || meta.localized_abbreviation || null;
        version = meta.title || meta.localized_title || null;
        attribution = (meta.copyright || meta.promotional_content || '').trim() || null;
    } catch (e) {
        console.warn('  ⚠ verse attribution unavailable: ' + e.message);
    }

    var text = String(passage.content).replace(/\s+/g, ' ').trim();
    var reference = passage.reference || votd.passage_id;

    console.log('  ✓ ' + reference + ' [' + abbr + '] (day ' + day + ', ' + dayKey + ')');
    return {
        text: text,
        reference: reference,
        translation: abbr || ('youversion:' + YVP_BIBLE_ID),
        // The full version name. YouVersion's own display pattern shows
        // the version name and the attribution as two separate things, so
        // the card renders "Berean Standard Bible (BSB) — Public Domain"
        // rather than the bare abbreviation.
        version: version,
        date: dayKey,
        // The attribution line the card must display.
        attribution: attribution,
        source: 'youversion',
    };
}

async function fetchDailyVerse() {
    console.log('\n✝ Fetching daily verse...');

    // Preferred: YouVersion's real editorial Verse of the Day.
    if (process.env.YVP_APP_KEY) {
        try {
            var yv = await fetchVerseYouVersion();
            if (yv && yv.text) return yv;
        } catch (err) {
            console.warn('  ⚠ YouVersion verse failed: ' + err.message);
            // Fall through to the bible-api.com path rather than losing the
            // card — but remember the failure so the health entry can say so.
            fetchDailyVerse.lastError = err.message;
        }
    }

    return fetchVerseBibleApi();
}

// Fallback path: bible-api.com, with a date-seeded deterministic pick.
// bible-api.com's /random endpoint was removed (404s), so the old client-side
// fetch silently failed and the card froze on its hardcoded HTML default.
// The API still serves the full Bible hierarchically:
//   /data/{translation}            -> list of books
//   /data/{translation}/{BOOK}     -> chapters
//   /data/{translation}/{BOOK}/{CH}-> verses
async function fetchVerseBibleApi() {
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
        // The full version name, so the card can name the translation
        // even on the fallback path. Without it you would not know
        // whether you were reading the curated YouVersion verse or this
        // random pick.
        version: 'King James Version',
        date: dayKey,
        attribution: null,
        source: 'bible-api.com',
    };
}

// ═══════════════════════════════════════════════
//  Pi Status — LIVE Hermes state
//  Reads: state.db (sessions/tokens), gateway_state.json, config.yaml
// ═══════════════════════════════════════════════
const HERMES_HOME = process.env.HERMES_HOME || '/home/cam/.hermes';

// ─── Feed health tracking ───
//
// Records, per feed, whether this run actually reached the source and how
// fresh the data is. A card that renders *something* is indistinguishable
// from a card that works — this makes staleness visible instead of silent.
//
// Each entry:
//   status      'live'     fetched successfully this run
//               'stale'    this run failed; serving the last known-good value
//   fetched_at  ISO timestamp of the last SUCCESSFUL fetch
//   age_min     minutes since that fetch, measured at publish time
//   count       number of items in the served value
//   error       the failure message from the most recent failed attempt
//   source      where the data came from (for display)

var health = {};

function recordHealth(feed, ok, opts) {
    opts = opts || {};
    var now = new Date();
    // 'fallback' is a third state: the feed produced a value, but the
    // PRIMARY source failed and a secondary one served it. That is
    // materially different from 'live' and from 'stale', and a card
    // that renders it must not look like the primary source worked.
    var status = opts.status || (ok ? 'live' : 'stale');
    var entry = {
        status: status,
        // A fallback DID fetch successfully — from the secondary source.
        // The data is fresh, so fetched_at is set and the card does not
        // look stale. Only the source was different.
        fetched_at: (ok || status === 'fallback') ? now.toISOString() : null,
        count: opts.count || 0,
        error: (ok && status === 'live') ? null : (opts.error || null),
        source: opts.source || null,
    };
    health[feed] = entry;
    return entry;
}

function applyHealth(vibesObj) {
    // Carry forward the last successful fetch time for feeds that failed, so
    // the age keeps climbing instead of resetting on every failure.
    var prior = (vibesObj.feed_health && typeof vibesObj.feed_health === 'object') ? vibesObj.feed_health : {};
    var out = {};
    Object.keys(health).forEach(function (key) {
        var entry = health[key];
        if (entry.status === 'stale' && prior[key] && prior[key].fetched_at && !entry.fetched_at) {
            entry.fetched_at = prior[key].fetched_at;
        }
        if (entry.fetched_at) {
            entry.age_min = Math.max(0, Math.round(
                (Date.now() - new Date(entry.fetched_at).getTime()) / 60000
            ));
        } else {
            entry.age_min = null;
        }
        out[key] = entry;
    });
    return out;
}

// ─── FireBuilt agent roster ───
//
// Reads the real Hermes profile directories so the FireBuilt card shows the
// team as it actually is, rather than a hardcoded paragraph that goes stale
// the moment reality changes. Each agent's role comes from its own SOUL.md,
// and its model from its own config.yaml.

var FIREBUILT_ROLES = {
    marcus:  'Lead strategist and orchestrator',
    sienna:  'Brand director and visual identity lead',
    maya:    'Build the things',
    atlas:   'Quality gate',
    harper:  'Write the words that connect churches to their communities',
    montage: 'Make churches look and sound amazing on every screen',
    grace:   'Help churches use technology faithfully',
};

function stripLeadingArticle(s) {
    return s.replace(/^(the|a|an)\s+/i, '');
}

function capitalizeFirst(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function readAgentRole(profileDir) {
    try {
        var soul = fs.readFileSync(path.join(profileDir, 'SOUL.md'), 'utf8');
        // The identity paragraph reads:
        //   "You are Marcus. You are the lead strategist and orchestrator for FireBuilt Media."
        //   "You are Maya. You build the things. You are the hands of FireBuilt Media."
        //   "You are Atlas. You are the quality gate. Nothing ships broken on your watch."
        // The FIRST clause after the name is the agent's own tagline.
        var m = soul.match(/^\s*You are ([A-Z][a-zA-Z]+)\.\s*([^\n]*)/m);
        if (!m) return null;
        var rest = (m[2] || '').trim();
        if (!rest) return null;

        var areThe = rest.match(/^You are the (.+?)(?: for FireBuilt Media)?\./);
        if (areThe) return capitalizeFirst(stripLeadingArticle(areThe[1].trim()));

        var youDo = rest.match(/^You ([a-z].+?)\./);
        if (youDo) return capitalizeFirst(youDo[1].trim());

        return null;
    } catch (e) {
        return null;
    }
}

function readAgentModel(profileDir) {
    try {
        var cfg = fs.readFileSync(path.join(profileDir, 'config.yaml'), 'utf8');
        var model = cfg.match(/^\s*default:\s*(\S+)/m);
        var provider = cfg.match(/^\s*provider:\s*(\S+)/m);
        return {
            model: model ? model[1] : null,
            provider: provider ? provider[1] : null,
        };
    } catch (e) { return { model: null, provider: null }; }
}

function countEntries(dir) {
    try { return fs.readdirSync(dir).filter(function (f) { return f[0] !== '.'; }).length; }
    catch (e) { return 0; }
}

function readAgentSessions(profileDir) {
    // Per-profile state.db is the authoritative record of that agent's work.
    var dbPath = path.join(profileDir, 'state.db');
    try {
        var out = execSync(
            'sqlite3 "' + dbPath + '" "SELECT COUNT(*), COALESCE(SUM(message_count),0), ' +
            'COALESCE(MAX(last_activity_at),0) FROM sessions;" 2>/dev/null',
            { encoding: 'utf8' }
        ).trim();
        var parts = out.split('|');
        return {
            sessions: parseInt(parts[0], 10) || 0,
            messages: parseInt(parts[1], 10) || 0,
            last_activity: parseFloat(parts[2]) || 0 || null,
        };
    } catch (e) {
        return { sessions: 0, messages: 0, last_activity: null };
    }
}

function fetchFireBuiltRoster() {
    var profilesRoot = path.join(HERMES_HOME, 'profiles');
    var dirs;
    try { dirs = fs.readdirSync(profilesRoot); }
    catch (e) { return null; }

    var agents = [];
    dirs.forEach(function (name) {
        var dir = path.join(profilesRoot, name);
        try { if (!fs.statSync(dir).isDirectory()) return; } catch (e) { return; }

        var mm = readAgentModel(dir);
        var sess = readAgentSessions(dir);
        var role = readAgentRole(dir);
        agents.push({
            name: name.charAt(0).toUpperCase() + name.slice(1),
            id: name,
            role: role || FIREBUILT_ROLES[name] || 'FireBuilt agent',
            model: mm.model,
            provider: mm.provider,
            sessions: sess.sessions,
            messages: sess.messages,
            last_activity: sess.last_activity,
            skills: countEntries(path.join(dir, 'skills')),
            cron: countEntries(path.join(dir, 'cron')),
        });
    });

    if (!agents.length) return null;

    // Most recently active first — the roster should surface who is working.
    agents.sort(function (a, b) {
        var at = a.last_activity || 0, bt = b.last_activity || 0;
        if (at !== bt) return bt - at;
        return a.name.localeCompare(b.name);
    });

    var totalSessions = 0, totalMessages = 0, lastAny = null;
    agents.forEach(function (a) {
        totalSessions += a.sessions;
        totalMessages += a.messages;
        if (a.last_activity && (!lastAny || a.last_activity > lastAny)) lastAny = a.last_activity;
    });

    return {
        agents: agents,
        agent_count: agents.length,
        total_sessions: totalSessions,
        total_messages: totalMessages,
        last_activity: lastAny,
    };
}

// Real refresh history, read from the systemd journal by the companion
// script. Returns null when the history cannot be read at all, so the
// caller can show "unknown" rather than an empty list that looks like
// "nothing has ever run".
function readRefreshHistory() {
    try {
        var mod = require(path.join(__dirname, 'scripts', 'read-refresh-journal.js'));
        var result = mod.main ? mod.main({ quiet: true }) : null;
        if (!result || !result.runs || !result.runs.length) return null;
        return result;
    } catch (e) {
        console.warn('  ⚠ refresh history unavailable: ' + e.message);
        return null;
    }
}

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
                'input_tokens, output_tokens, started_at, last_activity_at, title, model_config ' +
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

// Current context occupancy for the live session, in tokens.
// Hermes persists the real figure in the session row's model_config blob
// under _usage_anchor: prompt_tokens for the last API call plus the
// completion, which is the same number the CLI shows as "Current context".
//
// The session row's own input_tokens/output_tokens are LIFETIME totals and
// must NOT be used here — they grow with every call and produce readings
// far above 100% of the context window.
//
// Returns null when no anchor is available, so the caller can show "—" rather
// than a wrong number.
function readCurrentContext(live) {
    if (!live) return null;
    try {
        var cfgBlob = live.model_config;
        if (!cfgBlob) return null;
        if (typeof cfgBlob === 'string') cfgBlob = JSON.parse(cfgBlob);
        var anchor = cfgBlob && cfgBlob._usage_anchor;
        if (!anchor || typeof anchor !== 'object') return null;
        var prompt = parseInt(anchor.prompt_tokens, 10);
        if (!isNaN(prompt) && prompt > 0) return prompt;
        return null;
    } catch (e) {
        return null;
    }
}

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

// Context window (in k) for a model.
// 1. Hermes' own context_length_cache.yaml (keyed "stem@base_url")
// 2. The OpenRouter model catalog (public, no auth) — cached to disk
// 3. A conservative default
const CTX_CACHE_FILE = path.join(HERMES_HOME, '.lifeos-context-cache.json');

function readContextWindow(modelId) {
    if (!modelId) return 256;
    var stem = modelId.split('/').pop().split(':')[0];

    // 1. Hermes' cache
    var cachePath = path.join(HERMES_HOME, 'context_length_cache.yaml');
    try {
        if (fs.existsSync(cachePath)) {
            var txt = fs.readFileSync(cachePath, 'utf8');
            var m = txt.match(new RegExp('^\\s*' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '@[^:]+:\\s*(\\d+)', 'm'));
            if (m) return Math.round(parseInt(m[1], 10) / 1000);
        }
    } catch (e) { /* fall through */ }

    // 2. Local cache of OpenRouter lookups
    var local = {};
    try {
        if (fs.existsSync(CTX_CACHE_FILE)) local = JSON.parse(fs.readFileSync(CTX_CACHE_FILE, 'utf8'));
    } catch (e) { /* ignore */ }
    if (local[modelId]) return Math.round(local[modelId] / 1000);

    // 3. OpenRouter catalog (public, no auth needed)
    if (modelId.indexOf('openrouter') === 0 || modelId.indexOf('/') !== -1) {
        var orId = modelId.indexOf('/') !== -1 ? modelId : modelId;
        try {
            var raw = execSync('curl -s --max-time 8 https://openrouter.ai/api/v1/models', { encoding: 'utf8' });
            var models = JSON.parse(raw).data || [];
            for (var i = 0; i < models.length; i++) {
                if (models[i].id === orId && models[i].context_length) {
                    local[modelId] = models[i].context_length;
                    try {
                        fs.writeFileSync(CTX_CACHE_FILE, JSON.stringify(local, null, 2));
                    } catch (e2) { /* cache write is best-effort */ }
                    return Math.round(models[i].context_length / 1000);
                }
            }
        } catch (e3) { /* offline — fall through to default */ }
    }

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

    // Current context occupancy.
    //
    // The session row's input_tokens/output_tokens are LIFETIME totals for
    // the whole session, not the size of the current context window. Adding
    // them together and calling it "context" produced readings over 100%
    // (e.g. "1413k / 1000k") once a session ran long enough.
    //
    // Hermes records the real occupancy in the session's _usage_anchor:
    // prompt_tokens for the last API call plus the messages appended since.
    // That is the same figure the CLI shows as "Current context".
    var contextUsed = readCurrentContext(live);
    var usedK = contextUsed === null ? 0 : Math.round(contextUsed / 1000);
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
            // null means "unknown" — the frontend renders an em dash rather
            // than a fabricated zero. 0 would claim the context is empty.
            tokens_used: contextUsed === null ? null : usedK,
            tokens_total: contextWindow,
        },
        logs: logs,
        // The REAL refresh history, read from the systemd journal. This
        // replaces a hardcoded boot sequence that used to be presented as
        // live telemetry.
        refresh: readRefreshHistory(),
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
        recordHealth('youtube', true, { count: youtube.length, source: 'youtube.com/feeds' });
        console.log('\n✅ YouTube: ' + youtube.length + ' videos');
    } else if (previous.youtube && previous.youtube.length) {
        vibes.youtube = previous.youtube;
        recordHealth('youtube', false, {
            count: previous.youtube.length,
            error: 'fetch returned no items',
            source: 'youtube.com/feeds',
        });
        console.log('⚠ YouTube: fetch failed, keeping last known-good (' + previous.youtube.length + ' videos)');
    } else {
        recordHealth('youtube', false, { error: 'fetch returned no items and no last known-good value' });
    }
    if (xPosts && xPosts.length > 0) {
        vibes.x_posts = xPosts;
        updated = true;
        recordHealth('x', true, { count: xPosts.length, source: 'nitter mirrors' });
        console.log('✅ X Personalities: ' + xPosts.length + ' posts');
    } else if (previous.x_posts && previous.x_posts.length) {
        vibes.x_posts = previous.x_posts;
        recordHealth('x', false, {
            count: previous.x_posts.length,
            error: 'all nitter mirrors failed',
            source: 'nitter mirrors',
        });
        console.log('⚠ X: fetch failed, keeping last known-good (' + previous.x_posts.length + ' posts)');
    } else {
        recordHealth('x', false, { error: 'all nitter mirrors failed and no last known-good value' });
    }
    if (hnPosts && hnPosts.length > 0) {
        vibes.hn_posts = hnPosts;
        updated = true;
        recordHealth('hackernews', true, { count: hnPosts.length, source: 'hnrss.org' });
        console.log('✅ Hacker News: ' + hnPosts.length + ' stories');
    } else if (previous.hn_posts && previous.hn_posts.length) {
        vibes.hn_posts = previous.hn_posts;
        recordHealth('hackernews', false, {
            count: previous.hn_posts.length,
            error: 'hnrss.org unreachable',
            source: 'hnrss.org',
        });
        console.log('⚠ Hacker News: fetch failed, keeping last known-good (' + previous.hn_posts.length + ' stories)');
    } else {
        recordHealth('hackernews', false, { error: 'hnrss.org unreachable and no last known-good value' });
    }
    if (peterX && peterX.length > 0) {
        vibes.peter_x = peterX;
        updated = true;
        recordHealth('steipete', true, { count: peterX.length, source: 'steipete.me' });
        console.log('✅ steipete: ' + peterX.length + ' posts');
    } else if (previous.peter_x && previous.peter_x.length) {
        vibes.peter_x = previous.peter_x;
        recordHealth('steipete', false, {
            count: previous.peter_x.length,
            error: 'steipete feeds unreachable',
            source: 'steipete.me',
        });
        console.log('⚠ steipete: fetch failed, keeping last known-good');
    } else {
        recordHealth('steipete', false, { error: 'steipete feeds unreachable and no last known-good value' });
    }
    if (geoData && geoData.news && geoData.news.length > 0) {
        vibes.news = geoData.news;
        vibes.vibes = geoData.vibes;
        updated = true;
        recordHealth('news', true, { count: geoData.news.length, source: 'RSS + CBC' });
        console.log('✅ US/Canada Geo: ' + geoData.news.length + ' articles');
    } else if (previous.news && previous.news.length) {
        vibes.news = previous.news;
        if (previous.vibes) vibes.vibes = previous.vibes;
        recordHealth('news', false, {
            count: previous.news.length,
            error: 'news feeds unreachable',
            source: 'RSS + CBC',
        });
        console.log('⚠ Geo: fetch failed, keeping last known-good');
    } else {
        recordHealth('news', false, { error: 'news feeds unreachable and no last known-good value' });
    }
    if (weather) {
        vibes.weather = weather;
        updated = true;
        recordHealth('weather', true, { count: 1, source: 'open-meteo' });
        console.log('✅ Weather: ' + weather.temp + '°C ' + weather.condition);
    } else if (previous.weather) {
        vibes.weather = previous.weather;
        recordHealth('weather', false, { count: 1, error: 'open-meteo unreachable', source: 'open-meteo' });
        console.log('⚠ Weather: fetch failed, keeping last known-good');
    } else {
        recordHealth('weather', false, { error: 'open-meteo unreachable and no last known-good value' });
    }
    if (verse && verse.text) {
        vibes.verse = verse;
        updated = true;
        // A 'fallback' status means the PRIMARY source failed and a
        // secondary one served the card. That is not the same as 'live':
        // the curated verse of the day was not available, only a stand-in.
        // The strip shows amber so the difference is visible.
        var servedByFallback = verse.source && verse.source !== 'youversion';
        recordHealth('verse', !servedByFallback, {
            count: 1,
            source: verse.source || 'bible-api.com',
            status: servedByFallback ? 'fallback' : undefined,
            error: servedByFallback
                ? (fetchDailyVerse.lastError
                    ? fetchDailyVerse.lastError + ' — served by the ' + verse.source + ' fallback'
                    : 'served by the ' + verse.source + ' fallback')
                : undefined,
        });
        console.log('✅ Daily Verse: ' + verse.reference);
    } else if (previous.verse && previous.verse.text) {
        vibes.verse = previous.verse;
        recordHealth('verse', false, {
            count: 1,
            error: (fetchDailyVerse.lastError ? fetchDailyVerse.lastError + ' — ' : '') +
                   'verse source unreachable',
            source: previous.verse.source || 'bible-api.com',
        });
        console.log('⚠ Daily Verse: fetch failed, keeping last known-good (' + previous.verse.reference + ')');
    } else {
        recordHealth('verse', false, {
            error: (fetchDailyVerse.lastError ? fetchDailyVerse.lastError + ' — ' : '') +
                   'verse source unreachable and no last known-good value',
        });
    }
    if (piStatus) {
        vibes.pi_status = piStatus;
        updated = true;
        recordHealth('pi', true, { count: 1, source: 'hermes local' });
        console.log('✅ Pi Intelligence: ' + piStatus.model.name);
    } else {
        recordHealth('pi', false, { count: 1, error: 'hermes state unreadable', source: 'hermes local' });
    }

    // FireBuilt roster — live from the Hermes profile directories.
    var firebuilt = null;
    try { firebuilt = fetchFireBuiltRoster(); }
    catch (err) { console.error('FireBuilt roster fatal:', err.message); }
    if (firebuilt && firebuilt.agents && firebuilt.agents.length) {
        vibes.firebuilt = firebuilt;
        updated = true;
        recordHealth('firebuilt', true, { count: firebuilt.agents.length, source: 'hermes profiles' });
        console.log('✅ FireBuilt: ' + firebuilt.agent_count + ' agents');
    } else if (previous.firebuilt && previous.firebuilt.agents) {
        vibes.firebuilt = previous.firebuilt;
        recordHealth('firebuilt', false, {
            count: previous.firebuilt.agent_count || 0,
            error: 'profile directory unreadable',
            source: 'hermes profiles',
        });
        console.log('⚠ FireBuilt: roster unavailable, keeping last known-good');
    } else {
        recordHealth('firebuilt', false, { error: 'no Hermes profiles found' });
    }

    // Publish the health snapshot alongside the data.
    vibes.feed_health = applyHealth(vibes);

    vibes.lastUpdate = new Date().toLocaleString('en-US', {
        timeZone: LOCATION.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });

    if (!updated) {
        console.warn('\n⚠ No feeds updated. vibes.json unchanged.');
        process.exit(1);
    }

    if (DRY_RUN) {
        // A dry run must leave nothing behind. Check this BEFORE writing
        // the files, not after — otherwise "dry run" still rewrites the
        // data files and the name lies.
        console.log('\n🔍 DRY RUN — nothing written, Gist push skipped. Sample:');
        if (vibes.verse) {
            console.log('  Verse:', JSON.stringify({
                reference: vibes.verse.reference,
                translation: vibes.verse.translation,
                source: vibes.verse.source,
                attribution: vibes.verse.attribution,
            }));
        }
        if (vibes.youtube && vibes.youtube[0]) console.log('  YouTube[0]:', JSON.stringify(vibes.youtube[0]));
        if (vibes.x_posts && vibes.x_posts[0]) console.log('  X[0]:', JSON.stringify(vibes.x_posts[0]));
        if (vibes.hn_posts && vibes.hn_posts[0]) console.log('  HN[0]:', JSON.stringify(vibes.hn_posts[0]));
        if (vibes.peter_x && vibes.peter_x[0]) console.log('  steipete[0]:', JSON.stringify(vibes.peter_x[0]));
        if (vibes.news && vibes.news[0]) console.log('  News[0]:', JSON.stringify(vibes.news[0]));
        console.log('  vibes:', vibes.vibes || '(none)');
        console.log('  pi_status:', vibes.pi_status ? vibes.pi_status.activity : '(none)');
        return;
    }

    fs.writeFileSync(VIBES_PATH, JSON.stringify(vibes, null, 2));
    console.log('\n💾 vibes.json written');

    // Also write vibes.js for local file:// access (JSONP)
    var vibesJsContent = 'window.__DASHBOARD_DATA_CALLBACK__(' + JSON.stringify(vibes, null, 2) + ');';
    fs.writeFileSync(path.join(__dirname, 'vibes.js'), vibesJsContent);
    console.log('💾 vibes.js written (for local file:// access)');

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
