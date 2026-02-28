#!/usr/bin/env node
// ═══════════════════════════════════════════════
//  LIFE.OS — Dynamic Feed Fetcher v4
//  Zero API keys required. Pure RSS/Atom + Nitter.
//
//  Config:  feeds-config.json  ← edit THIS to manage follows
//
//  YouTube:   Public Atom feeds (youtube.com/feeds)
//  X / Twitter: Nitter RSS (nitter.poast.org, multi-instance fallback)
//  steipete:  steipete.me + steipete.com blog RSS
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
const STEIPETE_MAX = config.steipete_max || 10;

// ─── Nitter instances — all tried in parallel per handle, first success wins ───
const NITTER_INSTANCES = [
    'nitter.poast.org',
    'nitter.privacydev.net',
    'nitter.tiekoetter.com',
    'nitter.net',
    'n.opnxng.com',
];

// ─── steipete blog feeds ───
const STEIPETE_FEEDS = [
    { name: 'steipete.me', url: 'https://steipete.me/feed.xml', tag: 'entry' },
    { name: 'steipete.com', url: 'https://steipete.com/posts/feed.xml', tag: 'entry' },
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
                'User-Agent': 'Mozilla/5.0 (compatible; LIFE.OS/4.0 FeedBot)',
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

// ─── Extract XML tag value (handles CDATA) ───
function extractTag(xml, tag) {
    var cdataRe = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i');
    var cdataM = xml.match(cdataRe);
    if (cdataM) return cdataM[1].trim();
    var plainRe = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
    var plainM = xml.match(plainRe);
    return plainM ? plainM[1].replace(/<[^>]+>/g, '').trim() : null;
}

// ─── Parse RSS/Atom feed items ───
function parseItems(xml, itemTag, maxItems) {
    maxItems = maxItems || 5;
    var items = [];
    var re = new RegExp('<' + itemTag + '[\\s>]([\\s\\S]*?)<\\/' + itemTag + '>', 'gi');
    var match;
    while ((match = re.exec(xml)) !== null && items.length < maxItems) {
        var chunk = match[0];
        var title = (extractTag(chunk, 'title') || '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        // Link: RSS uses <link>, Atom uses <link href="...">
        var link = extractTag(chunk, 'link') || '';
        if (!link || link.indexOf('<') !== -1) {
            var hrefM = chunk.match(/<link[^>]+href="([^"]+)"/i);
            if (hrefM) link = hrefM[1];
        }
        link = (link || '#').trim();
        var pubDate = extractTag(chunk, 'pubDate') || extractTag(chunk, 'published') || extractTag(chunk, 'updated') || '';
        if (title && title.length > 3) {
            items.push({ title: title, link: link, pubDate: pubDate });
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

// ─── Fetch Hacker News (Replacing dead Nitter/X) ───
async function fetchTechIntel() {
    console.log('\n𝕏 Fetching Tech Intel (Hacker News)...');
    var allPosts = [];
    try {
        var xml = await httpsGet('https://news.ycombinator.com/rss');
        var items = parseItems(xml, 'item', X_MAX);
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            allPosts.push({
                user: 'Hacker News',
                topic: inferTopic(item.title),
                content: item.title,
                url: item.link,
                published: item.pubDate || new Date().toISOString(),
            });
        }
        console.log('  ✓ Fetched ' + allPosts.length + ' stories from HN');
    } catch (err) {
        console.warn('  ✗ HN fetch failed: ' + err.message);
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
            if (allPosts.length >= STEIPETE_MAX) break;
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
    var vibeStr = '⚠ ' + top[0].title.replace(/["]/g, '\'');
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

// ─── Fetch Steinbach Weather (Open-Meteo, free, no API key) ───
async function fetchWeather() {
    console.log('\n🌤 Fetching Steinbach, MB weather...');
    // Steinbach, MB coordinates: 49.5258°N, 96.6839°W
    var url = 'https://api.open-meteo.com/v1/forecast'
        + '?latitude=49.5258&longitude=-96.6839'
        + '&current=temperature_2m,apparent_temperature,weather_code'
        + '&daily=temperature_2m_max,temperature_2m_min'
        + '&timezone=America/Winnipeg'
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
        temp: String(Math.round(cur.temperature_2m || 0)),
        condition: condition,
        feels_like: String(Math.round(cur.apparent_temperature || 0)),
        hi: String(Math.round((daily.temperature_2m_max || [0])[0])),
        lo: String(Math.round((daily.temperature_2m_min || [0])[0])),
        updated: new Date().toLocaleString('en-US', {
            timeZone: 'America/Winnipeg',
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }) + ' CST',
    };
    console.log('  ✓ ' + weather.temp + '°C, ' + weather.condition + ' (feels ' + weather.feels_like + '°C)');
    return weather;
}

// ─── Fetch OpenClaw Pi Status (local filesystem) ───
function fetchPiStatus() {
    console.log('\n🥧 Reading OpenClaw gateway status...');
    var SESSIONS_PATH = '/home/cam/.openclaw/agents/main/sessions/sessions.json';
    var CONFIG_PATH_OC = '/home/cam/.openclaw/openclaw.json';

    var sessions, ocConfig;
    try { sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); }
    catch (e) { console.warn('  ✗ sessions.json: ' + e.message); return null; }
    try { ocConfig = JSON.parse(fs.readFileSync(CONFIG_PATH_OC, 'utf8')); }
    catch (e) { ocConfig = {}; }

    // Find the main interactive session (most recently updated)
    var entries = [];
    for (var key in sessions) {
        if (sessions[key] && sessions[key].updatedAt) {
            entries.push({ key: key, data: sessions[key] });
        }
    }
    entries.sort(function (a, b) { return (b.data.updatedAt || 0) - (a.data.updatedAt || 0); });

    var mainSession = entries[0] ? entries[0].data : null;
    if (!mainSession) { console.warn('  ✗ No sessions found'); return null; }

    var provider = mainSession.modelProvider || mainSession.provider || 'unknown';
    var model = mainSession.model || 'unknown';

    // Look up context window from config
    var contextWindow = 256; // default 256k
    var providers = (ocConfig.models && ocConfig.models.providers) || {};
    for (var prov in providers) {
        var models = providers[prov].models || [];
        for (var m = 0; m < models.length; m++) {
            if (models[m].id === model || models[m].name === model) {
                contextWindow = Math.round((models[m].contextWindow || 256000) / 1000);
                break;
            }
        }
    }

    // Build recent activity logs from the most recent sessions
    var logs = [];
    var now = Date.now();
    for (var i = 0; i < Math.min(entries.length, 5); i++) {
        var e = entries[i];
        var ts = new Date(e.data.updatedAt);
        var timeStr = ts.toLocaleTimeString('en-US', {
            timeZone: 'America/Winnipeg', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        var sessionModel = e.data.model || '?';
        var sessionType = e.key.indexOf('cron') !== -1 ? 'CRON' : 'Interactive';
        logs.push({
            time: timeStr,
            msg: sessionType + ': ' + sessionModel + ' via ' + (e.data.modelProvider || '?'),
        });
    }

    // Estimate token usage from session usage data (if available)
    var tokensUsed = 0;
    for (var j = 0; j < entries.length; j++) {
        var usage = entries[j].data.usage || {};
        tokensUsed += (usage.totalTokens || 0);
    }
    var tokensUsedK = Math.round(tokensUsed / 1000);

    var status = {
        status: 'ONLINE',
        activity: 'OpenClaw Gateway · ' + model + ' via ' + provider,
        model: {
            name: provider + '/' + model,
            tokens_used: tokensUsedK,
            tokens_total: contextWindow,
        },
        logs: logs,
        lastUpdate: new Date().toLocaleString('en-US', {
            timeZone: 'America/Winnipeg',
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }) + ' CST',
    };
    console.log('  ✓ Model: ' + status.model.name);
    console.log('  ✓ Sessions: ' + entries.length + ' total, tokens: ' + tokensUsedK + 'k / ' + contextWindow + 'k');
    return status;
}

// ─── Main ───
async function main() {
    console.log('═══════════════════════════════════════');
    console.log(' LIFE.OS Feed Fetcher v4');
    console.log('  ' + new Date().toLocaleString('en-US', { timeZone: 'America/Winnipeg' }) + ' CST');
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

    var results = await Promise.all([
        fetchYouTube().catch(function (err) { console.error('YouTube fatal:', err.message); return null; }),
        fetchTechIntel().catch(function (err) { console.error('TechIntel fatal:', err.message); return null; }),
        fetchSteipete().catch(function (err) { console.error('steipete fatal:', err.message); return null; }),
        fetchGeopolitics().catch(function (err) { console.error('Geo fatal:', err.message); return null; }),
        fetchWeather().catch(function (err) { console.error('Weather fatal:', err.message); return null; }),
    ]);

    // Pi status is sync (local filesystem), run separately
    var piStatus = null;
    try { piStatus = fetchPiStatus(); }
    catch (err) { console.error('Pi status fatal:', err.message); }

    var youtube = results[0];
    var xPosts = results[1];
    var peterX = results[2];
    var geoData = results[3];
    var weather = results[4];
    var updated = false;

    if (youtube && youtube.length > 0) {
        vibes.youtube = youtube;
        updated = true;
        console.log('\n✅ YouTube: ' + youtube.length + ' videos');
    }
    if (xPosts && xPosts.length > 0) {
        vibes.x_posts = xPosts;
        updated = true;
        console.log('✅ X Personalities: ' + xPosts.length + ' posts');
    }
    if (peterX && peterX.length > 0) {
        vibes.peter_x = peterX;
        updated = true;
        console.log('✅ steipete: ' + peterX.length + ' posts');
    }
    if (geoData && geoData.news && geoData.news.length > 0) {
        vibes.news = geoData.news;
        vibes.vibes = geoData.vibes;
        updated = true;
        console.log('✅ US/Canada Geo: ' + geoData.news.length + ' articles');
    }
    if (weather) {
        vibes.weather = weather;
        updated = true;
        console.log('✅ Weather: ' + weather.temp + '°C ' + weather.condition);
    }
    if (piStatus) {
        vibes.pi_status = piStatus;
        updated = true;
        console.log('✅ Pi Intelligence: ' + piStatus.model.name);
    }

    vibes.lastUpdate = new Date().toLocaleString('en-US', {
        timeZone: 'America/Winnipeg',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    }) + ' CST';

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
        if (vibes.peter_x && vibes.peter_x[0]) console.log('  steipete[0]:', JSON.stringify(vibes.peter_x[0]));
        if (vibes.news && vibes.news[0]) console.log('  News[0]:', JSON.stringify(vibes.news[0]));
        console.log('  vibes:', vibes.vibes || '(none)');
        console.log('  steipete total posts:', (vibes.peter_x || []).length);
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
    process.exit(0);  // Force exit — Promise.any leaves orphaned timers from losing Nitter races
}).catch(function (err) {
    console.error('Fatal:', err);
    process.exit(1);
});
