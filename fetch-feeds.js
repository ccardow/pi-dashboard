#!/usr/bin/env node
// ═══════════════════════════════════════════════
//  LIFE.OS — Dynamic Feed Fetcher v3
//  Zero API keys required. Pure RSS/Atom.
//
//  YouTube:          Public Atom feeds (youtube.com/feeds)
//  X Intelligence:   Tech news RSS (Verge, HN, TechCrunch, Wired)
//  Peter Steinberger: Nutrient/PSPDFKit blog RSS + GitHub releases
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

// ─── YouTube Channels (public Atom RSS, no API key) ───
const YOUTUBE_CHANNELS = [
    { name: 'Lex Fridman', id: 'UCSHZKyawb77ixDdsGog4iWA' },
    { name: 'Two Minute Papers', id: 'UCbfYPyITQ-7l4upoX8nvctg' },
    { name: 'Fireship', id: 'UCsBjURrPoezykLs9EqgamOA' },
    { name: 'Andrej Karpathy', id: 'UCMLwFP3jHzJL7jdIbe0bXgg' },
    { name: 'Y Combinator', id: 'UCcefcZRL2oaA_uBNeo5UNqg' },
    { name: 'Matt Wolfe', id: 'UCXv0mKKjM_f-68B8C4KCXHQ' },
];
const YOUTUBE_MAX = 6;

// ─── X Intelligence: Tech News RSS feeds ───
// Real sources from the same outlets @theverge, @karpathy etc. share
const X_INTEL_FEEDS = [
    { source: '@theverge', url: 'https://www.theverge.com/rss/index.xml', tag: 'entry' },
    { source: '@hackernews', url: 'https://news.ycombinator.com/rss', tag: 'item' },
    { source: '@techcrunch', url: 'https://techcrunch.com/feed/', tag: 'item' },
    { source: '@wired', url: 'https://www.wired.com/feed/rss', tag: 'entry' },
    { source: '@arstechnica', url: 'https://feeds.arstechnica.com/arstechnica/index', tag: 'item' },
];
const X_INTEL_MAX = 5;

// ─── Peter Steinberger: Nutrient (PSPDFKit) blog + GitHub ───
// Peter Steinberger is founder/CEO of Nutrient (formerly PSPDFKit)
// Nutrient blog uses RSS <item> tags (confirmed 200 OK, 1.7MB feed)
const PETER_FEEDS = [
    { name: 'Nutrient Blog', url: 'https://www.nutrient.io/blog/feed.xml', tag: 'item' },
    { name: 'PSPDFKit iOS', url: 'https://github.com/PSPDFKit/PSPDFKit-Demo/releases.atom', tag: 'entry' },
    { name: 'steipete.com', url: 'https://steipete.com/posts/feed.xml', tag: 'entry' },
    { name: 'steipete.me', url: 'https://steipete.me/feed.xml', tag: 'entry' },
];
const PETER_MAX = 3;

// ─── HTTP GET with redirect following ───
function httpsGet(url, depth) {
    depth = depth || 0;
    return new Promise(function (resolve, reject) {
        if (depth > 6) return reject(new Error('Too many redirects'));
        var lib = url.startsWith('https') ? https : http;
        var req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; LIFE.OS/2.0 FeedBot)',
                'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*',
            }
        }, function (res) {
            if ([301, 302, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
                var loc = res.headers.location;
                var next = loc.startsWith('http') ? loc : new URL(loc, url).href;
                res.resume();
                return httpsGet(next, depth + 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () { resolve(data); });
        });
        req.on('error', reject);
        req.setTimeout(12000, function () { req.destroy(); reject(new Error('Timeout')); });
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

// ─── Fetch YouTube ───
async function fetchYouTube() {
    console.log('\n📺 Fetching YouTube channels...');
    var allVideos = [];

    for (var i = 0; i < YOUTUBE_CHANNELS.length; i++) {
        var ch = YOUTUBE_CHANNELS[i];
        var url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.id;
        try {
            var xml = await httpsGet(url);
            var items = parseItems(xml, 'entry', 3);
            for (var j = 0; j < items.length; j++) {
                var item = items[j];
                // YouTube Atom: extract video ID from <yt:videoId> or link
                var ytIdMatch = xml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
                var vidMatch = item.link.match(/v=([a-zA-Z0-9_-]{11})/);
                var videoId = vidMatch ? vidMatch[1] : (ytIdMatch ? ytIdMatch[1] : null);
                allVideos.push({
                    title: item.title,
                    channel: ch.name,
                    url: videoId ? 'https://www.youtube.com/watch?v=' + videoId : item.link,
                    published: item.pubDate,
                });
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

// ─── Fetch X Intelligence (tech news RSS) ───
async function fetchXIntelligence() {
    console.log('\n⊡ Fetching X Intelligence (tech news RSS)...');
    var allPosts = [];

    for (var i = 0; i < X_INTEL_FEEDS.length; i++) {
        var feed = X_INTEL_FEEDS[i];
        try {
            var xml = await httpsGet(feed.url);
            var items = parseItems(xml, feed.tag, 2);
            for (var j = 0; j < items.length; j++) {
                var item = items[j];
                allPosts.push({
                    user: feed.source,
                    topic: inferTopic(item.title),
                    content: item.title.substring(0, 280),
                    url: item.link,
                    published: item.pubDate,
                });
            }
            console.log('  ✓ ' + feed.source + ': ' + items.length + ' posts');
        } catch (err) {
            console.warn('  ✗ ' + feed.source + ': ' + err.message);
        }
    }

    allPosts.sort(function (a, b) { return new Date(b.published) - new Date(a.published); });
    var top = allPosts.slice(0, X_INTEL_MAX);
    console.log('  → ' + top.length + ' posts selected');
    return top.length > 0 ? top : null;
}

// ─── Fetch Peter Steinberger ───
async function fetchPeterX() {
    console.log('\n◉ Fetching Peter Steinberger (Nutrient/PSPDFKit)...');
    var allPosts = [];

    for (var i = 0; i < PETER_FEEDS.length; i++) {
        var feed = PETER_FEEDS[i];
        try {
            var xml = await httpsGet(feed.url);
            var items = parseItems(xml, feed.tag, 3);
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
            if (allPosts.length >= PETER_MAX) break;
        } catch (err) {
            console.warn('  ✗ ' + feed.name + ': ' + err.message);
        }
    }

    allPosts.sort(function (a, b) { return new Date(b.published) - new Date(a.published); });
    var top = allPosts.slice(0, PETER_MAX);
    console.log('  → ' + top.length + ' posts selected');
    return top.length > 0 ? top : null;
}

// ─── Infer topic from text ───
function inferTopic(text) {
    var t = (text || '').toLowerCase();
    if (t.indexOf('ai') !== -1 || t.indexOf('llm') !== -1 || t.indexOf('openai') !== -1 || t.indexOf('gemini') !== -1 || t.indexOf('claude') !== -1 || t.indexOf('gpt') !== -1 || t.indexOf('model') !== -1) return 'AI / ML';
    if (t.indexOf('security') !== -1 || t.indexOf('hack') !== -1 || t.indexOf('breach') !== -1 || t.indexOf('vuln') !== -1 || t.indexOf('malware') !== -1) return 'Security';
    if (t.indexOf('apple') !== -1 || t.indexOf('ios') !== -1 || t.indexOf('iphone') !== -1 || t.indexOf('swift') !== -1 || t.indexOf('xcode') !== -1 || t.indexOf('pspdf') !== -1 || t.indexOf('nutrient') !== -1) return 'Apple / iOS';
    if (t.indexOf('canada') !== -1 || t.indexOf('trump') !== -1 || t.indexOf('tariff') !== -1 || t.indexOf('politic') !== -1 || t.indexOf('election') !== -1) return 'Geopolitics';
    if (t.indexOf('startup') !== -1 || t.indexOf('fund') !== -1 || t.indexOf('vc') !== -1 || t.indexOf('invest') !== -1 || t.indexOf('raise') !== -1) return 'Venture';
    if (t.indexOf('agent') !== -1 || t.indexOf('automation') !== -1 || t.indexOf('workflow') !== -1) return 'Agents';
    if (t.indexOf('open source') !== -1 || t.indexOf('github') !== -1 || t.indexOf('release') !== -1) return 'Open Source';
    return 'Tech Intel';
}

// ─── Main ───
async function main() {
    console.log('═══════════════════════════════════════');
    console.log(' LIFE.OS Feed Fetcher v3');
    console.log('  ' + new Date().toLocaleString('en-US', { timeZone: 'America/Winnipeg' }) + ' CST');
    console.log('  Mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE (push to Gist)'));
    console.log('═══════════════════════════════════════');

    var vibes = JSON.parse(fs.readFileSync(VIBES_PATH, 'utf8'));

    var results = await Promise.all([
        fetchYouTube().catch(function (err) { console.error('YouTube fatal:', err.message); return null; }),
        fetchXIntelligence().catch(function (err) { console.error('X Intel fatal:', err.message); return null; }),
        fetchPeterX().catch(function (err) { console.error('Peter fatal:', err.message); return null; }),
    ]);

    var youtube = results[0];
    var xPosts = results[1];
    var peterX = results[2];
    var updated = false;

    if (youtube && youtube.length > 0) {
        vibes.youtube = youtube;
        updated = true;
        console.log('\n✅ YouTube: ' + youtube.length + ' videos');
    }
    if (xPosts && xPosts.length > 0) {
        vibes.x_posts = xPosts;
        updated = true;
        console.log('✅ X Intelligence: ' + xPosts.length + ' posts');
    }
    if (peterX && peterX.length > 0) {
        vibes.peter_x = peterX;
        updated = true;
        console.log('✅ Peter Steinberger: ' + peterX.length + ' posts');
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
        if (vibes.peter_x && vibes.peter_x[0]) console.log('  Peter[0]:', JSON.stringify(vibes.peter_x[0]));
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

main().catch(function (err) {
    console.error('Fatal:', err);
    process.exit(1);
});
