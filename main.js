// ═══════════════════════════════════════════════
//  LIFE.OS — Main Controller
//  Cyber-Zen Manitoba Dashboard v2.0
// ═══════════════════════════════════════════════

// ─── Session Timer ───
const sessionStart = Date.now();

// ─── Theme Toggle ───
const themeToggle = document.getElementById('theme-toggle');
const body = document.body;

const setTheme = (isLight) => {
    body.classList.toggle('light-theme', isLight);
    body.classList.toggle('dark-theme', !isLight);
    themeToggle.textContent = isLight ? '🌑' : '🌓';
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
};

themeToggle.addEventListener('click', () => {
    setTheme(!body.classList.contains('light-theme'));
});

// Restore saved theme
if (localStorage.getItem('theme') === 'light') {
    setTheme(true);
}

// ─── Live Clock ───
// Timezone follows the configured location (America/Vancouver for Abbotsford).
// The zone is read from vibes.weather, which the fetcher populates from
// feeds-config.json. A sensible default is used until data lands.
const clockEl = document.getElementById('system-clock');
let clockZone = 'America/Vancouver';
let clockZoneLabel = 'PST';

const updateClock = () => {
    const now = new Date();
    const local = now.toLocaleTimeString('en-US', {
        timeZone: clockZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    const utc = now.toLocaleTimeString('en-US', {
        timeZone: 'UTC',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
    });
    clockEl.innerHTML = `${local} <span class="clock-label">${clockZoneLabel}</span> · <span class="clock-label">UTC</span> ${utc}`;
};

// Map a IANA zone to a short label (PST/PDT, CST/CDT, EST/EDT, MST/MDT).
const zoneLabel = (zone, date) => {
    const map = {
        'America/Vancouver': ['PST', 'PDT'],
        'America/Winnipeg': ['CST', 'CDT'],
        'America/Toronto': ['EST', 'EDT'],
        'America/Chicago': ['CST', 'CDT'],
        'America/Denver': ['MST', 'MDT'],
        'America/Los_Angeles': ['PST', 'PDT'],
        'America/New_York': ['EST', 'EDT'],
    };
    const pair = map[zone];
    if (!pair) return zone.split('/').pop().replace('_', ' ');
    // DST roughly: late March to early November in North America.
    const month = Number(date.toLocaleString('en-US', { timeZone: zone, month: 'numeric' }));
    const daylight = month >= 4 && month <= 10;
    return daylight ? pair[1] : pair[0];
};

const setClockZone = (zone) => {
    if (!zone) return;
    clockZone = zone;
    clockZoneLabel = zoneLabel(zone, new Date());
    updateClock();
};

updateClock();
setInterval(updateClock, 1000);

// ─── Scripture Engine ───
// The verse now comes from the fetched data (vibes.verse) — the old
// bible-api.com/random endpoint was removed and 404s, which left this card
// frozen on its hardcoded HTML default. The fetcher picks a deterministic
// verse per calendar day so it rolls over at local midnight.
const updateVerse = (data) => {
    const verseText = document.getElementById('verse-text');
    const verseRef = document.getElementById('verse-ref');
    if (!verseText || !verseRef) return;

    const v = data && data.verse;
    if (v && v.text) {
        verseText.textContent = `"${v.text}"`;
        verseRef.textContent = v.reference;
        logActivity('Daily verse loaded: ' + v.reference);
    } else {
        verseText.textContent = '"Verse unavailable."';
        verseRef.textContent = '—';
        logActivity('Daily verse unavailable.');
    }
};

// ─── Time-Aware Greeting ───
// Uses the location's timezone so "Good afternoon" matches Cam's wall clock.
const greetingEl = document.getElementById('greeting');
const updateGreeting = (tz) => {
    const hour = Number(new Date().toLocaleString('en-US', {
        timeZone: tz || 'America/Vancouver', hour: 'numeric', hour12: false,
    }));
    let greetWord = 'Good evening';
    if (hour >= 5 && hour < 12) greetWord = 'Good morning';
    else if (hour >= 12 && hour < 17) greetWord = 'Good afternoon';
    greetingEl.textContent = `${greetWord}, Cam.`;
};
updateGreeting();

// ─── Date & Day-of-Year Counter ───
// Calculated in the location's timezone, not the viewer's, so "Day 292 of 365"
// matches Cam's calendar.
const dateEl = document.getElementById('date-display');
const dayCountEl = document.getElementById('day-counter');
const now = new Date();
const startOfYear = new Date(now.getFullYear(), 0, 0);
const diff = now - startOfYear;
const oneDay = 1000 * 60 * 60 * 24;
const dayOfYear = Math.floor(diff / oneDay);
const isLeap = (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) || (now.getFullYear() % 400 === 0);
const totalDays = isLeap ? 366 : 365;

dateEl.textContent = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
});
dayCountEl.textContent = `Day ${String(dayOfYear).padStart(3, '0')} of ${totalDays}`;

// ─── Session Uptime ───
const uptimeEl = document.getElementById('uptime-display');
const updateUptime = () => {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    if (hrs > 0) {
        uptimeEl.textContent = `Session ${String(hrs).padStart(2, '0')}:${String(remainMins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    } else {
        uptimeEl.textContent = `Session ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
};
updateUptime();
setInterval(updateUptime, 1000);

// ─── Footer Year ───
document.getElementById('footer-year').textContent = now.getFullYear();

// ─── Activity Log ───
const logActivity = (message) => {
    const log = document.getElementById('activity-log');
    if (!log) return;
    const item = document.createElement('div');
    item.className = 'log-item';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    item.innerHTML = `<span class="log-time">${time}</span> <span class="log-msg">> ${message}</span>`;
    log.prepend(item);
    // Keep only last 20 entries
    while (log.children.length > 20) {
        log.lastChild.remove();
    }
};

// ─── Boot Sequence ───
const bootMessages = [
    'LIFE.OS v2.0 kernel loaded',
    'Initializing Cyber-Zen subsystems...',
    'Connecting intelligence feeds...',
    'Weather module: locked',
    'Scripture engine: ready',
    'Feed aggregator: scanning 𝕏...',
    'Hermes gateway: handshake',
    'Dashboard render: complete',
    'Awaiting operator input.'
];

const runBootSequence = () => {
    bootMessages.forEach((msg, i) => {
        setTimeout(() => logActivity(msg), i * 250);
    });
};

runBootSequence();

// ─── Fetch and Render Dashboard Data ───
const updateDashboard = async () => {
    try {
        logActivity('Synchronizing intelligence feeds...');

        let data;
        const isLocal = window.location.hostname === 'localhost'
            || window.location.hostname === '127.0.0.1'
            || window.location.hostname === '[::1]'
            || window.location.protocol === 'file:';

        if (isLocal) {
            logActivity('Local mode. Fetching data...');

            // If file:// protocol, use JSONP workaround to avoid CORS
            if (window.location.protocol === 'file:') {
                data = await fetchLocalData();
            } else {
                // Localhost server (npm run dev)
                const response = await fetch('vibes.json?t=' + Date.now());
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                data = await response.json();
            }
        } else {
            // REMOTE VERCEL MODE: Fetch from Gist (dynamic source)
            logActivity('Vercel mode. Fetching dynamic Gist data...');
            const GIST_URL = 'https://gist.githubusercontent.com/ccardow/e65c6cfabb1fbc98983381da98801408/raw/vibes.json?t=' + Date.now();
            try {
                const response = await fetch(GIST_URL);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                data = await response.json();
            } catch (gistErr) {
                // Fall back to the copy committed to the repo — GitHub Actions
                // refreshes it, and Vercel redeploys it, so the site still
                // updates even when the Gist is unreachable.
                logActivity('Gist unavailable, using repo fallback...');
                const fallback = await fetch('vibes.json?t=' + Date.now());
                if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
                data = await fallback.json();
            }
        }

        console.log('Dashboard data resolved:', data);
        updateVerse(data);
        // Clock + greeting follow the configured location's timezone.
        if (data.weather && data.weather.timezone) {
            setClockZone(data.weather.timezone);
            updateGreeting(data.weather.timezone);
        }
        renderData(data);
        logActivity('All feeds synchronized.');
    } catch (err) {
        console.error('Feed sync failed:', err);
        logActivity(`ERROR: ${err.message}`);
    }
};

// Helper for local file system fetch workaround
const fetchLocalData = () => {
    return new Promise((resolve, reject) => {
        const oldScript = document.querySelector('script[src^="vibes.js"]');
        if (oldScript) oldScript.remove();

        const script = document.createElement('script');
        window.__DASHBOARD_DATA_CALLBACK__ = (data) => {
            delete window.__DASHBOARD_DATA_CALLBACK__;
            script.remove();
            resolve(data);
        };
        script.src = 'vibes.js?t=' + Date.now();
        script.onerror = () => reject(new Error('Failed to load vibes.js'));
        document.head.appendChild(script);
    });
};

// ─── Render All Feed Data ───
const renderData = (data) => {
    const vibesBox = document.getElementById('vibes-box');
    const newsList = document.getElementById('news-list');
    const xList = document.getElementById('x-list');
    const hnList = document.getElementById('hn-list');
    const youtubeList = document.getElementById('youtube-list');
    const peterList = document.getElementById('peter-list');
    const piActivity = document.getElementById('pi-activity');
    const piStatus = document.getElementById('pi-status-display');
    const piLog = document.getElementById('pi-log');
    const piRoadmapList = document.getElementById('roadmap-list');
    const piMetrics = document.getElementById('pi-metrics');
    const modelName = document.getElementById('model-name');
    const modelTokens = document.getElementById('model-tokens');
    const modelRemaining = document.getElementById('model-remaining');
    const modelProgress = document.getElementById('model-progress');
    const weatherTemp = document.getElementById('weather-temp');
    const weatherHilo = document.getElementById('weather-hilo');
    const weatherCondition = document.getElementById('weather-condition');
    const weatherLabel = document.getElementById('weather-label');

    // Weather
    const fetchLiveWeather = async () => {
        try {
            // Coordinates come from the feed config (vibes.weather carries them),
            // so the card tracks wherever Cam actually lives.
            const w = data.weather || {};
            const lat = w.latitude || 49.0503;
            const lon = w.longitude || -122.3476;
            const tz = w.timezone || 'America/Vancouver';
            const url = 'https://api.open-meteo.com/v1/forecast'
                + '?latitude=' + lat + '&longitude=' + lon
                + '&current=temperature_2m,apparent_temperature,weather_code'
                + '&daily=temperature_2m_max,temperature_2m_min'
                + '&timezone=' + tz
                + '&forecast_days=1';
            const response = await fetch(url);
            const wx = await response.json();
            const cur = wx.current || {};
            const daily = wx.daily || {};

            const code = cur.weather_code || 0;
            let condition = 'Clear';
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

            if (weatherTemp) weatherTemp.textContent = `${Math.round(cur.temperature_2m || 0)}°C`;
            if (weatherCondition) weatherCondition.textContent = `${condition} · Feels like ${Math.round(cur.apparent_temperature || 0)}°C`;
            if (weatherHilo) {
                weatherHilo.innerHTML = `
                    <span>↑ ${Math.round((daily.temperature_2m_max || [0])[0])}°C</span>
                    <span>↓ ${Math.round((daily.temperature_2m_min || [0])[0])}°C</span>
                `;
            }
            if (weatherLabel) weatherLabel.textContent = w.label || 'Weather';
            logActivity('Weather updated: ' + (w.label || 'current location'));
        } catch (err) {
            console.error('Weather fetch failed:', err);
        }
    };

    fetchLiveWeather();

    // Pi Status
    if (data.pi_status) {
        if (piStatus) piStatus.textContent = data.pi_status.status || 'ONLINE';
        if (piActivity) piActivity.innerHTML = `<div class="pi-msg">> ${data.pi_status.activity}</div>`;
        if (piLog && data.pi_status.logs) {
            piLog.innerHTML = data.pi_status.logs.map(l => `
                <div class="log-item">
                    <span class="log-time">${l.time}</span> <span class="log-msg">> ${l.msg}</span>
                </div>
            `).join('');
        }

        // Roadmap
        if (piRoadmapList && data.pi_status.roadmap) {
            piRoadmapList.innerHTML = data.pi_status.roadmap.map(item => `
                <div class="roadmap-item">
                    <span class="roadmap-item-name">${item.name}</span>
                    <span class="roadmap-item-status">> ${item.status}</span>
                </div>
            `).join('');
        }

        // Model Stats
        if (data.pi_status.model) {
            if (modelName) modelName.textContent = data.pi_status.model.name || '--';
            if (modelTokens) {
                const used = data.pi_status.model.tokens_used || 0;
                const total = data.pi_status.model.tokens_total || 256;
                modelTokens.textContent = `${used}k / ${total}k`;
                if (modelRemaining) {
                    const remaining = Math.max(0, total - used);
                    modelRemaining.textContent = `${remaining}k`;
                }
                if (modelProgress) {
                    const pct = Math.min(100, Math.round((used / total) * 100));
                    modelProgress.style.width = `${pct}%`;
                }
            }
        }

        // Gateway Metrics — live from Hermes
        if (piMetrics && data.pi_status.gateway) {
            const gw = data.pi_status.gateway;
            const totals = data.pi_status.totals || {};
            const stateColor = gw.state === 'running' ? 'var(--accent-green)' : 'var(--accent-rose)';
            const rows = [
                ['Gateway', `${gw.state || 'unknown'} · v${gw.version || '?'} · pid ${gw.pid || '?'}`, stateColor],
                ['Profiles', (gw.profiles || []).length + ' served', 'var(--accent-indigo)'],
                ['Active', (gw.active_agents || 0) + ' agent' + (gw.active_agents === 1 ? '' : 's'), 'var(--accent-teal)'],
            ];
            if (totals.sessions) {
                rows.push(['Ledger', `${totals.sessions} sessions · ${Math.round((totals.input_tokens + totals.output_tokens) / 1000)}k tokens`, 'var(--text-dim)']);
            }
            piMetrics.innerHTML = rows.map(r => `
                <div class="log-item">
                    <span class="log-time">${r[0]}</span>
                    <span class="log-msg">> <span style="color:${r[2]}">${r[1]}</span></span>
                </div>
            `).join('');
        }
    }

    // Vibes
    if (vibesBox) {
        vibesBox.textContent = data.vibes ? `"${data.vibes}"` : 'No vibes data.';
    }

    // News
    if (newsList) {
        newsList.innerHTML = (data.news && data.news.length > 0)
            ? data.news.map(n => `
                <div class="feed-item">
                    <a href="${n.url || '#'}" target="_blank">
                        <div class="feed-title">${n.title}</div>
                        <div class="feed-summary">${n.summary}</div>
                    </a>
                </div>
            `).join('')
            : '<div class="feed-item"><span class="feed-summary">No news available.</span></div>';
    }

    // X Posts
    if (xList) {
        xList.innerHTML = (data.x_posts && data.x_posts.length > 0)
            ? data.x_posts.map(post => `
                <div class="feed-item">
                    <a href="${post.url || '#'}" target="_blank">
                        <span class="feed-user">@${(post.user || '').replace(/^@/, '')}</span>
                        <span class="feed-topic">· ${post.topic}</span>
                        <div class="feed-content">${post.content}</div>
                    </a>
                </div>
            `).join('')
            : '<div class="feed-item"><span class="feed-content">No X posts available.</span></div>';
    }

    // Hacker News
    if (hnList) {
        hnList.innerHTML = (data.hn_posts && data.hn_posts.length > 0)
            ? data.hn_posts.map(post => `
                <div class="feed-item">
                    <a href="${post.url || '#'}" target="_blank">
                        <span class="feed-user">${post.topic}</span>
                        <div class="feed-content">${post.content}</div>
                    </a>
                </div>
            `).join('')
            : '<div class="feed-item"><span class="feed-content">No HN stories available.</span></div>';
    }

    // YouTube
    if (youtubeList) {
        youtubeList.innerHTML = (data.youtube && data.youtube.length > 0)
            ? data.youtube.map(vid => `
                <div class="feed-item">
                    <a href="${vid.url}" target="_blank">
                        <div class="feed-title">${vid.title}</div>
                        <div class="feed-channel">${vid.channel}</div>
                    </a>
                </div>
            `).join('')
            : '<div class="feed-item"><span class="feed-content">No videos available.</span></div>';
    }

    // Peter Steinberger
    if (peterList) {
        peterList.innerHTML = (data.peter_x && data.peter_x.length > 0)
            ? data.peter_x.map(post => `
                <div class="feed-item">
                    <div class="feed-user">${post.topic}</div>
                    <div class="feed-content">${post.content}</div>
                </div>
            `).join('')
            : '<div class="feed-item"><span class="feed-content">No founder posts available.</span></div>';
    }
};

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key.toLowerCase()) {
        case 't':
            setTheme(!body.classList.contains('light-theme'));
            logActivity('Theme toggled.');
            break;
        case 'r':
            logActivity('Manual feed refresh triggered.');
            updateDashboard();
            break;
        case 'arrowup':
            window.scrollTo({ top: 0, behavior: 'smooth' });
            break;
        case '?':
            logActivity('Shortcuts: T=theme, R=refresh, ↑=top, ?=help');
            break;
    }
});

// ─── Periodic Ambient Events ───
const ambientEvents = [
    'Monitoring Steinbach weather...',
    'Scanning 𝕏 for intelligence...',
    'Checking YouTube feeds...',
    'Analyzing geopolitical signals...',
    'Ready for operator commands.',
    'Systems nominal. Standing by.',
    'Running integrity checks...',
    'Prairie skies: clear.',
];

setInterval(() => {
    const msg = ambientEvents[Math.floor(Math.random() * ambientEvents.length)];
    logActivity(msg);
}, 20000);

// ─── Initialize ───
// Delay dashboard fetch slightly to let boot sequence play
setTimeout(() => {
    updateDashboard();
}, bootMessages.length * 250 + 500);

// ─── Auto-Refresh Every 5 Minutes ───
// Re-fetches from the Gist so cards update as fetch-feeds.js runs on a schedule
setInterval(() => {
    logActivity('Auto-refresh: synchronizing feeds...');
    updateDashboard();
}, 5 * 60 * 1000);

console.log('LIFE.OS v2.0 (Cyber-Zen Manitoba) initialized.');
