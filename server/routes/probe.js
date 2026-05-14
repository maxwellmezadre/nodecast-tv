const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Browser-compatible codecs
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

/**
 * Probe stream with ffprobe
 */
function probeStream(url, ffprobePath, userAgent = null, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-user_agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            '-allowed_extensions', 'ALL',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            // Smaller probe (1MB / 1s) is enough to detect codec/container; cuts probe latency.
            '-probesize', '1000000',
            '-analyzeduration', '1000000',
            url
        ];

        const proc = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Probe timeout'));
        }, timeout);

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output'));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url) {
    const streams = probeResult.streams || [];
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const container = format.format_name?.toLowerCase() || 'unknown';

    // Check codec compatibility
    const videoOk = BROWSER_VIDEO_CODECS.some(c => videoCodec.includes(c));
    const audioOk = BROWSER_AUDIO_CODECS.some(c => audioCodec.includes(c));

    // Browser-safe containers
    // Note: We exclude 'webm' because ffprobe reports MKV as "matroska,webm", 
    // and H.264/AAC in MKV/WebM is not universally supported. Best to remux to MP4.
    const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];
    const containerOk = BROWSER_CONTAINERS.some(c => container.includes(c));

    // Check if it's a raw TS stream (not HLS)
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    // Determine what processing is needed
    // 4. MKV files often cause OOM/decoding issues in browser fMP4 remux, 
    // so we force them to "needsTranscode" which uses HLS (more robust).
    // The frontend will still use "copy" mode if codecs are compatible.
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');

    // 1. Incompatible audio/video OR MKV OR multichannel audio -> Transcode (or HLS Copy)
    // Browsers (esp. Chrome on macOS) often play silence on multichannel AAC inside MP4.
    // Force transcode for >2 channels to downmix to stereo.
    const audioChannels = audioStream?.channels || 0;
    const audioMultichannel = audioChannels > 2;
    const needsTranscode = !audioOk || !videoOk || isMkv || audioMultichannel;

    // 2. Compatible audio/video but incompatible container (non-MKV) -> Remux (fMP4 pipe)
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    const compatible = !needsTranscode && !needsRemux;

    return {
        video: videoCodec,
        audio: audioCodec,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        audioChannels: audioStream?.channels || 0, // For Smart Audio Copy
        container: container,
        compatible: compatible,
        needsRemux: needsRemux,
        needsTranscode: needsTranscode,
        subtitles: subtitles
    };
}

/**
 * Build a synthetic probe result for known Xtream URL patterns to skip the slow ffprobe step.
 * The vast majority of Xtream provider channels follow the same codec mix per type:
 *   - /live/.../*.ts          → mpegts h264/aac stereo  (needsRemux)
 *   - /movie/.../*.mp4|.mkv   → mp4 h264/aac stereo     (compatible / direct play)
 *   - /series/.../*.mp4|.mkv  → mp4 h264/aac stereo     (compatible / direct play)
 * Returns null when the URL doesn't fit a known pattern, in which case the caller falls back
 * to a real probe. A background probe still runs to update the cache with the real answer
 * so future hits get accurate info if our assumption was wrong.
 */
function fastPathFromUrl(url) {
    if (url.includes('.m3u8')) return null; // HLS playlists need real probe
    const isLiveTs = /\/live\//.test(url) && /\.ts(\?|$)/.test(url);
    if (isLiveTs) {
        return {
            video: 'h264',
            audio: 'aac',
            width: 0,
            height: 0,
            audioChannels: 2,
            container: 'mpegts',
            compatible: false,
            needsRemux: true,
            needsTranscode: false,
            subtitles: [],
            __fastPath: true
        };
    }
    // VOD (movies/series) intentionally NOT fast-pathed: a non-trivial share of titles ship
    // 5.1 AAC, which the browser silently fails to render. Real probe is required to detect
    // channel count → fall back through transcode. Trading 5s probe latency for a guaranteed
    // first-play audio is worth it. Background-cache still warms via subsequent plays.
    return null;
}

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffprobePath = req.app.locals.ffprobePath;
    const cacheKey = `${url}${ua ? `|${ua}` : ''}`;

    if (!ffprobePath) {
        // No ffprobe available - assume needs transcoding to be safe
        console.log('[Probe] FFprobe not available, assuming transcode needed');
        return res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true
        });
    }

    // Check cache (real cached probe wins over fast-path).
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[Probe] Cache hit for: ${url.substring(0, 50)}...`);
        return res.json(cached.result);
    }

    // Fast-path: respond synthetically for well-known Xtream URLs, then validate in the background.
    const fast = fastPathFromUrl(url);
    if (fast) {
        console.log(`[Probe] Fast-path response (background probe queued) for: ${url.substring(0, 50)}...`);
        res.json(fast);
        // Fire-and-forget real probe to populate cache with accurate codec info for the next play.
        probeStream(url, ffprobePath, ua).then(probeResult => {
            const analysis = analyzeProbeResult(probeResult, url);
            probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });
            console.log(`[Probe] Background probe done: video=${analysis.video}, audio=${analysis.audio}, ` +
                `${analysis.audioChannels}ch, needsTranscode=${analysis.needsTranscode}`);
        }).catch(err => {
            console.warn('[Probe] Background probe failed:', err.message);
        });
        return;
    }

    console.log(`[Probe] Probing: ${url.substring(0, 80)}... ${ua ? `(UA: ${ua})` : ''}`);

    try {
        const probeResult = await probeStream(url, ffprobePath, ua);
        const analysis = analyzeProbeResult(probeResult, url);

        // Cache result
        probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });

        console.log(`[Probe] Result: video=${analysis.video}, audio=${analysis.audio}, ` +
            `container=${analysis.container}, compatible=${analysis.compatible}, ` +
            `needsRemux=${analysis.needsRemux}, needsTranscode=${analysis.needsTranscode}`);

        res.json(analysis);
    } catch (err) {
        console.error('[Probe] Failed:', err.message);

        // On error, assume transcode needed to be safe
        res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true,
            error: err.message
        });
    }
});

module.exports = router;
