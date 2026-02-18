const https = require("https");
const fs = require("fs");
const path = require("path");

const vibesPath = path.join(__dirname, "vibes.json");
const rssUrl = "https://www.cbc.ca/webfeed/rss/rss-topstories";

console.log("Starting Dashboard News Sync...");

function getFeed(url) {
    https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
            console.log("Redirecting to:", res.headers.location);
            return getFeed(res.headers.location.startsWith('http') ? res.headers.location : `https://www.cbc.ca${res.headers.location}`);
        }

        let xml = "";
        res.on("data", chunk => xml += chunk);
        res.on("end", () => {
            try {
                // Find the first <item>
                const itemStart = xml.indexOf('<item');
                const itemEnd = xml.indexOf('</item>', itemStart);
                if (itemStart === -1 || itemEnd === -1) throw new Error("No RSS items found");

                const item = xml.substring(itemStart, itemEnd);
                
                // Helper to extract between tags
                const extract = (tag) => {
                    const s = item.indexOf(`<${tag}>`);
                    const e = item.indexOf(`</${tag}>`, s);
                    if (s === -1 || e === -1) return null;
                    let content = item.substring(s + tag.length + 2, e);
                    // Remove CDATA if present
                    if (content.includes('<![CDATA[')) {
                        content = content.replace('<![CDATA[', '').replace(']]>', '');
                    }
                    return content.trim();
                };

                const headline = extract('title');
                let summary = extract('description') || "No summary available.";

                if (!headline) throw new Error("Could not parse headline");

                // Strip HTML tags and clean up
                summary = summary.replace(/<[^>]*>?/gm, "").replace(/\s+/g, " ").trim();
                if (!summary) summary = "View the latest updates at CBC.ca";

                const vibes = JSON.parse(fs.readFileSync(vibesPath, "utf8"));
                
                vibes.politics.headline = headline;
                vibes.politics.summary = summary;
                vibes.politics.source = "CBC RSS";
                vibes.politics.updated = new Date().toLocaleString("en-US", { 
                    timeZone: "America/Winnipeg",
                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" 
                }) + " CST";

                fs.writeFileSync(vibesPath, JSON.stringify(vibes, null, 2));
                console.log("✅ Dashboard updated!");
                console.log(`Headline: ${headline}`);
            } catch (err) {
                console.error("❌ Sync Error:", err.message);
            }
        });
    }).on("error", (err) => {
        console.error("❌ Network Error:", err.message);
    });
}

getFeed(rssUrl);
