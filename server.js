import express from 'express';
import path from 'path';
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import { Innertube, Platform, Parser, ProtoUtils } from 'youtubei.js';
import { JSDOM } from 'jsdom';
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { buildURL, getHeaders, base64ToU8, u8ToBase64 } from 'bgutils-js/utils';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// Auto-detect IPv6 connectivity or default to ipv4first
async function detectAndSetDnsOrder() {
    dns.setDefaultResultOrder('ipv4first');
    console.log('[DNS] Set default DNS result order to ipv4first');
    return 'ipv4first';
}

// Set a safe default immediately
dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Node does NOT read .env automatically — load it here, before any process.env reads.
// Existing environment variables (e.g. set by the hosting panel) are not overridden.
function loadDotEnv(file) {
    if (!fs.existsSync(file)) {
        console.log(`[Env] No .env found at ${file}`);
        return;
    }
    try {
        if (typeof process.loadEnvFile === 'function') {
            process.loadEnvFile(file); // Node >= 20.12
        } else {
            for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
                const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)\s*$/);
                if (!m || line.trim().startsWith('#')) continue;
                let val = m[2].trim();
                if (/^(["']).*\1$/.test(val)) val = val.slice(1, -1);
                if (process.env[m[1]] === undefined) process.env[m[1]] = val;
            }
        }
        console.log(`[Env] Loaded ${file}`);
    } catch (e) {
        console.warn(`[Env] Failed to load ${file}:`, e.message);
    }
}
loadDotEnv(path.join(__dirname, '.env'));

// Provide a custom JavaScript interpreter for deciphering streaming URLs
Platform.shim.eval = async (data, env) => {
    return new Function(data.output)();
};

// YouTube constantly ships new renderer types (e.g. PlayerErrorCommand). The parser
// JIT-generates them anyway, so "class not found/changed" warnings are just noise.
Parser.setParserErrorHandler(({ classname, error_type }) => {
    if (error_type === 'class_not_found' || error_type === 'class_changed') return;
    console.warn(`[YTJS Parser] ${error_type} at ${classname}`);
});

// Optional: Netscape-format cookie string of a (throwaway) logged-in account.
// This is the most reliable fix when the host IP gets "Sign in to confirm you're not a bot".
const YT_COOKIE = process.env.YT_COOKIE || undefined;

// Optional: route ALL YouTube traffic through a proxy, e.g. http://user:pass@host:port
// Stream URLs are bound to the requesting IP (`ip=` param), so CDN downloads must use
// the same proxy as the player requests — hence one shared ytFetch for everything.
const YT_PROXY = process.env.YT_PROXY || undefined;
const proxyAgent = YT_PROXY ? new ProxyAgent(YT_PROXY) : null;

async function ytFetch(input, init = {}) {
    if (!proxyAgent) return fetch(input, init);
    // youtubei.js passes Node's global Request objects; undici's own fetch needs plain values
    if (input instanceof Request) {
        const hasBody = !['GET', 'HEAD'].includes(input.method);
        init = {
            method: input.method,
            headers: Object.fromEntries(input.headers),
            body: hasBody ? await input.arrayBuffer() : undefined,
            redirect: input.redirect,
            ...init,
        };
        input = input.url;
    }
    if (init.headers instanceof Headers) init.headers = Object.fromEntries(init.headers);
    return undiciFetch(input, { ...init, dispatcher: proxyAgent });
}

// In-memory cache
class NodeCache {
    constructor() { this.cache = new Map(); }
    async get(key) { return this.cache.get(key) || null; }
    async set(key, value) { this.cache.set(key, value); }
    async remove(key) { this.cache.delete(key); }
}

// Shared cache so the player JS is downloaded once, not once per video
const sharedCache = new NodeCache();

const app = express();
const port = process.env.PORT || 3210;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Client fallback order — YTMUSIC is most reliable; ANDROID_VR works with a video-bound
// PoToken. WEB often returns SABR-only formats (no direct URL), so it's near the end.
const CLIENT_FALLBACKS = ['YTMUSIC', 'ANDROID_VR', 'TV', 'WEB', 'ANDROID'];
const AUDIO_ITAGS = [251, 140, 250, 249];

// Headers required by YouTube CDN
const CDN_FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Origin': 'https://www.youtube.com',
    'Referer': 'https://www.youtube.com/',
};

// ============ PoToken Manager ============
// Creates a BotGuard minter once, then mints video-bound PoTokens in <1ms.
// Video-bound PoTokens allow streaming past 1MB without 403 blocks.

class PoTokenManager {
    constructor() {
        this.minterData = null;
        this.minterPromise = null;
        this.lastInit = 0;
        this.TTL = 30 * 60 * 1000; // Refresh minter every 30 minutes
    }

    async initMinter() {
        console.log('[PoToken] Initializing BotGuard challenge & minter...');
        const bareYt = await Innertube.create({
            cache: new NodeCache(),
            fetch: ytFetch,
            retrieve_player: false,
            generate_session_locally: false,
        });

        const visitorData = bareYt.session.context.client.visitorData;
        if (!visitorData) throw new Error('Could not get visitorData');

        const requestKey = 'O43z0dpjhgX20SCx4KAo';
        const challenge = await getChallenge({
            requestKey,
            fetchFunction: ytFetch,
        });
        if (!challenge) throw new Error('Could not create BotGuard challenge');

        const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
            url: 'https://www.youtube.com',
            pretendToBeVisual: true,
            runScripts: 'dangerously',
        });

        const scriptCode = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
        if (scriptCode) {
            dom.window.eval(scriptCode);
        }

        try {
            const bgClient = await BotGuardClient.create({
                program: challenge.program,
                globalName: challenge.globalName,
                globalObject: dom.window,
            });

            const webPoSignalOutput = [];
            const botguardResponse = await bgClient.snapshot({ webPoSignalOutput });

            const payload = [requestKey, botguardResponse];
            const integrityTokenResponse = await ytFetch(buildURL('GenerateIT'), {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify(payload)
            });
            const itJson = await integrityTokenResponse.json();
            const integrityToken = itJson[0];
            if (!integrityToken) throw new Error('Could not get integrityToken');

            const getMinter = webPoSignalOutput[0];
            if (!getMinter) throw new Error('Could not get minter function');

            const mintCallback = await getMinter(base64ToU8(integrityToken));
            if (typeof mintCallback !== 'function') throw new Error('mintCallback is not a function');

            this.minterData = { visitorData, mintCallback };
            this.lastInit = Date.now();
            console.log('[PoToken] BotGuard minter ready');
            return this.minterData;
        } finally {
            dom.window.close();
        }
    }

    async getMinter() {
        if (!this.minterData || (Date.now() - this.lastInit) > this.TTL) {
            if (!this.minterPromise) {
                this.minterPromise = this.initMinter().finally(() => {
                    this.minterPromise = null;
                });
            }
            await this.minterPromise;
        }
        return this.minterData;
    }

    async getPoTokenForVideo(videoId) {
        try {
            const { visitorData, mintCallback } = await this.getMinter();
            const rawBytes = await mintCallback(new TextEncoder().encode(videoId));
            const poToken = u8ToBase64(rawBytes, true);
            return { poToken, visitorData };
        } catch (e) {
            console.error('[PoToken] Minting error:', e.message);
            return null;
        }
    }
}

const poTokenManager = new PoTokenManager();

// ============ Innertube Management ============

let singletonInnertube = null;

// Visitor ID must match the cookie's VISITOR_INFO1_LIVE, otherwise YouTube sees
// "account A + random visitor B" in one request, which looks like a bot.
function getCookieValue(cookie, name) {
    const m = cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? m[1] : null;
}
const COOKIE_VISITOR_ID = getCookieValue(YT_COOKIE, 'VISITOR_INFO1_LIVE');
const cookieSessionOpts = () => (YT_COOKIE ? {
    cookie: YT_COOKIE,
    ...(COOKIE_VISITOR_ID ? { visitor_data: ProtoUtils.encodeVisitorData(COOKIE_VISITOR_ID, Math.floor(Date.now() / 1000)) } : {}),
} : {});

// Clients that accept cookies (ANDROID / ANDROID_VR ignore them).
// YTMUSIC first: TV currently returns "UNPLAYABLE (The page needs to be reloaded.)".
const COOKIE_CLIENTS = ['YTMUSIC', 'TV', 'WEB'];

async function getInnertube() {
    if (!singletonInnertube) {
        singletonInnertube = await Innertube.create({
            cache: sharedCache,
            fetch: ytFetch,
            generate_session_locally: true,
            ...cookieSessionOpts(),
        });
    }
    return singletonInnertube;
}

// Builds the ordered list of (session, client) attempts:
// 1) logged-in cookie session on cookie-capable clients (if YT_COOKIE set)
// 2) anonymous session using the BotGuard visitor + video-bound PoToken (NO cookie)
async function buildAttempts(poData) {
    const attempts = [];
    if (YT_COOKIE) {
        const ytCookie = await Innertube.create({
            cache: sharedCache,
            fetch: ytFetch,
            generate_session_locally: true,
            ...cookieSessionOpts(),
            ...(poData ? { po_token: poData.poToken } : {}),
        });
        for (const client of COOKIE_CLIENTS) attempts.push({ yt: ytCookie, client, label: `${client}+cookie` });
    }
    // po_token here is also appended to stream URLs as `pot` by the Player
    const ytAnon = await Innertube.create({
        cache: sharedCache,
        fetch: ytFetch,
        generate_session_locally: true,
        ...(poData ? { po_token: poData.poToken, visitor_data: poData.visitorData } : {}),
    });
    for (const client of CLIENT_FALLBACKS) attempts.push({ yt: ytAnon, client, label: client });
    return attempts;
}

// Verifies the cookie really logs in (expired/rotated cookies silently act as logged-out)
async function checkCookieLogin() {
    if (!YT_COOKIE) return;
    const missing = ['SAPISID', 'SID', '__Secure-3PSID'].filter(k => !getCookieValue(YT_COOKIE, k));
    if (missing.length) console.warn(`[Cookie] Missing keys: ${missing.join(', ')}`);
    try {
        const yt = await getInnertube();
        const resp = await yt.actions.execute('/account/account_menu', { client: 'WEB' });
        const raw = JSON.stringify(resp.data);
        const name = raw.match(/"accountName":\{(?:"simpleText":"([^"]+)"|"runs":\[\{"text":"([^"]+)")/);
        if (name) console.log(`[Cookie] Logged in as: ${name[1] || name[2]}`);
        else console.warn('[Cookie] NOT logged in — cookie is invalid, expired or was rotated by Google. Export a fresh one.');
    } catch (e) {
        console.warn('[Cookie] Login check failed:', e.message);
    }
}

function isBotCheck(reason = '') {
    return /not a bot|sign in to confirm/i.test(reason);
}

// Fetch player info ONCE for a client, then pick the best audio itag locally.
// (yt.getStreamingData() re-requests /player for every itag, multiplying traffic.)
async function tryClient(yt, videoId, client, poToken) {
    const info = await yt.getBasicInfo(videoId, { client, po_token: poToken });
    const ps = info.playability_status;
    if (ps?.status && ps.status !== 'OK') {
        return { error: `${ps.status}${ps.reason ? ` (${ps.reason})` : ''}`, botCheck: isBotCheck(ps.reason) };
    }
    if (!info.streaming_data) return { error: 'no streaming_data' };

    for (const itag of AUDIO_ITAGS) {
        let format;
        try { format = info.chooseFormat({ itag, type: 'audio' }); } catch { continue; }
        const url = await format.decipher(yt.session.player);
        if (url) return { url, itag: format.itag };
    }
    try {
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });
        const url = await format.decipher(yt.session.player);
        if (url) return { url, itag: format.itag };
    } catch { }
    return { error: 'no audio formats' };
}

// ============ Metadata Cache ============

const META_CACHE = new Map(); // videoId -> { data, timestamp }
const META_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function getVideoMeta(videoId) {
    const cached = META_CACHE.get(videoId);
    if (cached && (Date.now() - cached.timestamp) < META_CACHE_TTL) {
        return cached.data;
    }

    const yt = await getInnertube();
    let title = videoId, author = 'Unknown', duration = 0;
    let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    try {
        const info = await yt.getBasicInfo(videoId);
        title = info.basic_info?.title || videoId;
        author = info.basic_info?.author || 'Unknown';
        duration = info.basic_info?.duration || 0;
        const thumbnails = info.basic_info?.thumbnail;
        if (thumbnails && thumbnails.length > 0) {
            thumbnail = thumbnails[thumbnails.length - 1].url;
        }
    } catch (e) {
        console.log('[Meta] Error:', e.message);
    }

    const data = { title, author, duration, thumbnail };
    META_CACHE.set(videoId, { data, timestamp: Date.now() });
    return data;
}

// ============ Stream URL Cache ============

const streamUrlCache = new Map(); // videoId -> { url, client, itag, timestamp }
const STREAM_URL_TTL = 30 * 60 * 1000; // 30 minutes (URLs live ~6h)

// Deduplication for concurrent requests to the same videoId
const pendingResolves = new Map(); // videoId -> Promise<{ url, client, itag }>

async function resolveStreamUrl(videoId) {
    // 1. Check cache
    const cached = streamUrlCache.get(videoId);
    if (cached && (Date.now() - cached.timestamp) < STREAM_URL_TTL) {
        return cached;
    }

    // 2. Deduplicate concurrent requests
    if (pendingResolves.has(videoId)) {
        return await pendingResolves.get(videoId);
    }

    // 3. Resolve with video-bound PoToken
    const promise = (async () => {
        const t0 = Date.now();
        const poData = await poTokenManager.getPoTokenForVideo(videoId);
        const attempts = await buildAttempts(poData);

        let botChecks = 0;
        for (const { yt, client, label } of attempts) {
            try {
                const r = await tryClient(yt, videoId, client, poData?.poToken);
                if (r.url) {
                    const entry = { url: r.url, client: label, itag: r.itag, timestamp: Date.now() };
                    streamUrlCache.set(videoId, entry);
                    console.log(`[URL] ${videoId} -> ${label} (itag: ${r.itag}) OK (${Date.now() - t0}ms)`);
                    return entry;
                }
                if (r.botCheck) botChecks++;
                console.log(`[URL] ${videoId} -> ${label}: ${r.error}`);
            } catch (e) {
                console.log(`[URL] ${videoId} -> ${label}: ${e.message}`);
            }
        }
        if (botChecks > 0) {
            const hint = YT_COOKIE
                ? 'Cookie did not help — check the [Cookie] startup log, or use a residential proxy (YT_PROXY).'
                : 'Set YT_COOKIE or use a residential proxy (YT_PROXY).';
            throw new Error(`YouTube bot check on ${botChecks}/${attempts.length} attempts — this server IP is flagged. ${hint}`);
        }
        throw new Error('No stream URLs available from any client');
    })();

    pendingResolves.set(videoId, promise);
    try {
        return await promise;
    } finally {
        pendingResolves.delete(videoId);
    }
}

// ============ Concurrency Stats ============
let activeStreams = 0;
let totalStreamsServed = 0;

// ====== API Endpoints ======

// GET /api/stream/:videoId — returns stream URL + metadata
app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    try {
        const [streamEntry, meta] = await Promise.all([
            resolveStreamUrl(videoId),
            getVideoMeta(videoId),
        ]);

        res.json({
            url: streamEntry.url,
            itag: streamEntry.itag,
            ...meta,
            videoId
        });
    } catch (error) {
        console.error(`[Error] ${videoId}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/search?q=... — search YouTube videos
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' });

    try {
        const yt = await getInnertube();
        const results = await yt.search(q, { type: 'video' });

        const videos = (results.results || [])
            .filter(v => v.type === 'Video')
            .slice(0, 12)
            .map(v => ({
                videoId: v.id,
                title: v.title?.text || v.title || 'Unknown',
                author: v.author?.name || 'Unknown',
                duration: v.duration?.text || '',
                thumbnail: v.best_thumbnail?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
                views: v.view_count?.text || ''
            }));

        res.json({ results: videos });
    } catch (error) {
        console.error('[Search Error]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/trending — get trending/suggested music videos
const TRENDING_CACHE = { data: null, timestamp: 0 };
const TRENDING_CACHE_TTL = 60 * 60 * 1000; // 1 hour

app.get('/api/trending', async (req, res) => {
    try {
        if (TRENDING_CACHE.data && (Date.now() - TRENDING_CACHE.timestamp) < TRENDING_CACHE_TTL) {
            return res.json({ results: TRENDING_CACHE.data, cached: true });
        }

        const yt = await getInnertube();
        const results = await yt.search('nhạc hot trending', { type: 'video' });
        const videos = (results.results || [])
            .filter(v => v.type === 'Video')
            .slice(0, 12)
            .map(v => ({
                videoId: v.id,
                title: v.title?.text || v.title || 'Unknown',
                author: v.author?.name || 'Unknown',
                duration: v.duration?.text || '',
                thumbnail: v.best_thumbnail?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
                views: v.view_count?.text || ''
            }));

        TRENDING_CACHE.data = videos;
        TRENDING_CACHE.timestamp = Date.now();
        res.json({ results: videos, cached: false });
    } catch (error) {
        console.error('[Trending Error]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/proxy-stream/:videoId — robust chunked audio proxy streaming
app.get('/api/proxy-stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    activeStreams++;
    totalStreamsServed++;

    try {
        let streamEntry = await resolveStreamUrl(videoId);

        // Parse Range header if present
        const rangeHeader = req.headers.range;
        let startByte = 0;
        let endByte = null;

        if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (match) {
                startByte = parseInt(match[1], 10);
                if (match[2]) {
                    endByte = parseInt(match[2], 10);
                }
            }
        }

        const CHUNK_SIZE = 512 * 1024;
        const firstChunkEnd = endByte !== null ? Math.min(startByte + CHUNK_SIZE - 1, endByte) : startByte + CHUNK_SIZE - 1;

        let firstChunkResp = await ytFetch(streamEntry.url, {
            headers: {
                ...CDN_FETCH_HEADERS,
                'Range': `bytes=${startByte}-${firstChunkEnd}`,
            }
        });

        // If chunk fetch fails with 403, invalidate cache, re-resolve and retry once
        if (!firstChunkResp.ok && firstChunkResp.status !== 206) {
            console.log(`[Proxy] ${videoId} fetch returned ${firstChunkResp.status}, refreshing stream URL...`);
            streamUrlCache.delete(videoId);
            streamEntry = await resolveStreamUrl(videoId);
            firstChunkResp = await ytFetch(streamEntry.url, {
                headers: {
                    ...CDN_FETCH_HEADERS,
                    'Range': `bytes=${startByte}-${firstChunkEnd}`,
                }
            });
            if (!firstChunkResp.ok && firstChunkResp.status !== 206) {
                throw new Error(`Upstream CDN returned ${firstChunkResp.status}`);
            }
        }

        const contentType = firstChunkResp.headers.get('content-type') || 'audio/webm; codecs="opus"';
        const contentRange = firstChunkResp.headers.get('content-range'); // e.g. "bytes 0-524287/4159651"
        let totalSize = null;
        if (contentRange) {
            const parts = contentRange.split('/');
            if (parts[1] && parts[1] !== '*') {
                totalSize = parseInt(parts[1], 10);
            }
        }

        if (endByte === null && totalSize !== null) {
            endByte = totalSize - 1;
        }

        // Send headers
        if (rangeHeader) {
            res.status(206);
            if (totalSize !== null && endByte !== null) {
                res.set('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`);
                res.set('Content-Length', (endByte - startByte + 1).toString());
            }
        } else {
            res.status(200);
            if (totalSize !== null) {
                res.set('Content-Length', totalSize.toString());
            }
        }

        res.set('Content-Type', contentType);
        res.set('Accept-Ranges', 'bytes');

        // Write first chunk data immediately
        const firstBuf = Buffer.from(await firstChunkResp.arrayBuffer());
        if (!res.write(firstBuf)) {
            await new Promise(resolve => res.once('drain', resolve));
        }

        // Stream remaining chunks from CDN
        let isClosed = false;
        req.on('close', () => { isClosed = true; });

        let currentPos = startByte + firstBuf.length;
        const targetEnd = endByte !== null ? endByte : (totalSize ? totalSize - 1 : Infinity);

        while (currentPos <= targetEnd && !isClosed) {
            const chunkEnd = Math.min(currentPos + CHUNK_SIZE - 1, targetEnd);
            const chunkResp = await ytFetch(streamEntry.url, {
                headers: {
                    ...CDN_FETCH_HEADERS,
                    'Range': `bytes=${currentPos}-${chunkEnd}`,
                }
            });

            if (!chunkResp.ok && chunkResp.status !== 206) {
                console.error(`[Proxy] ${videoId} Chunk ${currentPos}-${chunkEnd} failed: ${chunkResp.status}`);
                break;
            }

            const arrayBuffer = await chunkResp.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            currentPos += buffer.length;

            if (!res.write(buffer)) {
                await new Promise(resolve => res.once('drain', resolve));
            }

            if (buffer.length === 0) break;
        }

        res.end();
    } catch (error) {
        console.error(`[Proxy Error] ${videoId}:`, error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    } finally {
        activeStreams--;
    }
});

// GET /api/stats — monitoring endpoint
app.get('/api/stats', (req, res) => {
    res.json({
        activeStreams,
        totalStreamsServed,
        streamUrlCache: streamUrlCache.size,
        metaCache: META_CACHE.size,
        pendingResolves: pendingResolves.size,
        poTokenActive: !!poTokenManager.minterData,
        cookie: !!YT_COOKIE,
        proxy: !!YT_PROXY,
        innertubeReady: !!singletonInnertube,
    });
});

// GET /api/debug-stream/:videoId — debug why streaming fails
app.get('/api/debug-stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const results = [];

    try {
        const poData = await poTokenManager.getPoTokenForVideo(videoId);
        const attempts = await buildAttempts(poData);

        for (const { yt, client, label } of attempts) {
            const entry = { client: label, status: null, error: null, urlLen: 0 };
            try {
                const r = await tryClient(yt, videoId, client, poData?.poToken);
                if (!r.url) {
                    entry.error = r.error;
                    results.push(entry);
                    continue;
                }
                entry.itag = r.itag;
                entry.urlLen = r.url.length;
                entry.urlHost = new URL(r.url).hostname;

                const resp = await ytFetch(r.url, {
                    headers: { ...CDN_FETCH_HEADERS, 'Range': 'bytes=0-1023' }
                });
                entry.status = resp.status;
                entry.statusText = resp.statusText;
                entry.contentType = resp.headers.get('content-type');
                entry.contentLength = resp.headers.get('content-length');

                if (!resp.ok && resp.status !== 206) {
                    const text = await resp.text();
                    entry.body = text.substring(0, 200);
                } else {
                    resp.body?.cancel?.();
                    entry.body = '(stream OK)';
                }
            } catch (e) {
                entry.error = e.message;
            }
            results.push(entry);
        }

        res.json({ videoId, poToken: !!poData, cookie: !!YT_COOKIE, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup: initialize DNS order, Innertube, then listen
(async () => {
    const dnsOrder = await detectAndSetDnsOrder();

    app.listen(port, () => {
        console.log(`\n🎵 YT Stream Player running at http://localhost:${port}`);
        console.log(`   DNS order: ${dnsOrder}`);
        console.log(`   Platform: ${process.platform} ${process.arch}`);
        console.log(`   Node.js: ${process.version}`);
        console.log(`   YT_COOKIE: ${YT_COOKIE ? 'set' : 'not set'} | YT_PROXY: ${YT_PROXY ? YT_PROXY.replace(/\/\/[^@]*@/, '//***@') : 'not set'}\n`);
    });

    // Pre-warm Innertube + BotGuard Minter in background
    Promise.all([
        getInnertube(),
        poTokenManager.getMinter(),
    ]).then(() => {
        console.log('[Startup] Innertube & BotGuard Minter pre-warmed successfully');
        return checkCookieLogin();
    }).catch(e => {
        console.error('[Startup] Pre-warm error:', e.message);
    });
})();
