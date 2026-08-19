import express from 'express';
import path from 'path';
import dns from 'dns';
import net from 'net';
import { fileURLToPath } from 'url';
import { Innertube, Platform } from 'youtubei.js';
import { JSDOM } from 'jsdom';
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { buildURL, getHeaders, base64ToU8, u8ToBase64 } from 'bgutils-js/utils';

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

// Provide a custom JavaScript interpreter for deciphering streaming URLs
Platform.shim.eval = async (data, env) => {
    return new Function(data.output)();
};

// In-memory cache
class NodeCache {
    constructor() { this.cache = new Map(); }
    async get(key) { return this.cache.get(key) || null; }
    async set(key, value) { this.cache.set(key, value); }
    async remove(key) { this.cache.delete(key); }
}

const app = express();
const port = 3210;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Client fallback order — YTMUSIC and ANDROID_VR provide reliable streams
const CLIENT_FALLBACKS = ['YTMUSIC', 'ANDROID_VR', 'TV', 'ANDROID', 'WEB'];

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
            retrieve_player: false,
            generate_session_locally: false,
        });

        const visitorData = bareYt.session.context.client.visitorData;
        if (!visitorData) throw new Error('Could not get visitorData');

        const requestKey = 'O43z0dpjhgX20SCx4KAo';
        const challenge = await getChallenge({
            requestKey,
            fetchFunction: fetch,
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
            const integrityTokenResponse = await fetch(buildURL('GenerateIT'), {
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

async function getInnertube() {
    if (!singletonInnertube) {
        singletonInnertube = await Innertube.create({
            cache: new NodeCache(),
            generate_session_locally: true,
        });
    }
    return singletonInnertube;
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

        const ytOpts = poData
            ? { po_token: poData.poToken, visitor_data: poData.visitorData, cache: new NodeCache(), generate_session_locally: true }
            : { cache: new NodeCache(), generate_session_locally: true };

        const yt = await Innertube.create(ytOpts);

        for (const client of CLIENT_FALLBACKS) {
            for (const itag of [251, 140, 250, 249]) {
                try {
                    const streamData = await yt.getStreamingData(videoId, { itag, client });
                    if (streamData?.url) {
                        const entry = { url: streamData.url, client, itag: streamData.itag, timestamp: Date.now() };
                        streamUrlCache.set(videoId, entry);
                        console.log(`[URL] ${videoId} -> ${client} (itag: ${streamData.itag}) OK (${Date.now() - t0}ms)`);
                        return entry;
                    }
                } catch (_) {}
            }
            console.log(`[URL] ${videoId} -> ${client}: no URL`);
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

        let firstChunkResp = await fetch(streamEntry.url, {
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
            firstChunkResp = await fetch(streamEntry.url, {
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
            const chunkResp = await fetch(streamEntry.url, {
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
        innertubeReady: !!singletonInnertube,
    });
});

// GET /api/debug-stream/:videoId — debug why streaming fails
app.get('/api/debug-stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const results = [];

    try {
        const poData = await poTokenManager.getPoTokenForVideo(videoId);
        const ytOpts = poData
            ? { po_token: poData.poToken, visitor_data: poData.visitorData, cache: new NodeCache(), generate_session_locally: true }
            : { cache: new NodeCache(), generate_session_locally: true };
        const yt = await Innertube.create(ytOpts);

        for (const client of CLIENT_FALLBACKS) {
            const entry = { client, status: null, error: null, urlLen: 0 };
            try {
                const streamData = await yt.getStreamingData(videoId, { itag: 140, client });
                if (!streamData?.url) {
                    entry.error = 'No URL returned';
                    results.push(entry);
                    continue;
                }
                entry.urlLen = streamData.url.length;
                entry.urlHost = new URL(streamData.url).hostname;

                const resp = await fetch(streamData.url, {
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

        res.json({ videoId, poToken: !!poData, results });
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
        console.log(`   Node.js: ${process.version}\n`);
    });

    // Pre-warm Innertube + BotGuard Minter in background
    Promise.all([
        getInnertube(),
        poTokenManager.getMinter(),
    ]).then(() => {
        console.log('[Startup] Innertube & BotGuard Minter pre-warmed successfully');
    }).catch(e => {
        console.error('[Startup] Pre-warm error:', e.message);
    });
})();
