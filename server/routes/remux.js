const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');

/**
 * Remux stream (container conversion only)
 * GET /api/remux?url=...
 * 
 * Remuxes MPEG-TS to fragmented MP4 for browser playback.
 * This is a lightweight operation - no video/audio re-encoding.
 * Use this for raw .ts streams that browsers can't play directly.
 * 
 * Note: This does NOT fix Dolby/AC3 audio issues - use /api/transcode for that.
 */
router.get('/', async (req, res) => {
    const { url, audioCodec } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Remux] Starting remux for: ${url}`);
    console.log(`[Remux] Using User-Agent: ${settings.userAgentPreset}`);

    // FFmpeg arguments for pure remux (no encoding)
    // Very lightweight - just changes container from TS to fragmented MP4
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        // Probe budget tuned for IPTV: 1MB / 2s lets ffmpeg find audio PIDs in streams
        // with sparse audio packets (some channels send video for several seconds before
        // the first audio PES). Forcing `-f mpegts` skips container auto-detection.
        '-f', 'mpegts',
        '-probesize', '1000000',
        '-analyzeduration', '2000000',
        // Error resilience: discard corrupt packets, generate timestamps, ignore DTS, no buffering, low delay.
        '-fflags', '+genpts+discardcorrupt+igndts+nobuffer',
        '-flags', 'low_delay',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Demux delay of 2s — tight enough to keep TTFB low while tolerating DTS reordering
        // and brief network hiccups from the upstream.
        '-max_delay', '2000000',
        // Larger socket buffer reduces network blip → ffmpeg pause when provider hiccups.
        '-rtbufsize', '64M',
        // Reconnect settings for network drops
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-i', url,
        // Map only video and audio; trailing `?` makes both optional, so a stream that
        // hasn't surfaced audio yet within the probe window still produces a valid output.
        '-map', '0:v:0?',
        '-map', '0:a:0?',
        // Drop subtitles (-sn) and data (-dn) explicitly
        '-sn', '-dn',
        // Copy streams without re-encoding
        '-c', 'copy',
        // Ensure extradata is correctly extracted/converted (fixes Annex B -> AVCC issues in Firefox)
        '-bsf:v', 'dump_extra',
        // Apply aac_adtstoasc only when audio is AAC (required to mux ADTS AAC from MPEG-TS into MP4).
        // Skipping for AC3/EAC3/MP3 to avoid breaking those codecs.
        ...(audioCodec && audioCodec.toLowerCase().includes('aac') ? ['-bsf:a', 'aac_adtstoasc'] : []),
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming. frag_keyframe emits a moof at every keyframe,
        // which is the fastest "first playable byte" path for live IPTV. flush_packets
        // forces ffmpeg to push each output packet to the socket without internal buffering.
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-flush_packets', '1',
        '-' // Output to stdout
    ];

    console.log(`[Remux] Full command: ${ffmpegPath} ${args.join(' ')}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Headers are deferred until we know whether ffmpeg actually produced output.
    // This lets us send a proper 502 with a JSON error when the upstream is broken
    // (404/403/I/O error) instead of streaming 0 bytes as "video/mp4".
    let bytesWritten = 0;
    let stderrTail = '';
    let headerSent = false;

    const sendVideoHeaders = () => {
        if (headerSent || res.headersSent) return;
        headerSent = true;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');
    };

    ffmpeg.stdout.on('data', (chunk) => {
        bytesWritten += chunk.length;
        sendVideoHeaders();
        // Manual write keeps us in control of the response state machine.
        if (!res.writableEnded) res.write(chunk);
    });
    // Deliberately NOT closing the response on stdout 'end' — that fires before ffmpeg's
    // own exit event and would emit a 200 even when ffmpeg failed before writing anything.
    // The exit handler below decides whether to end with success or 502.

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        stderrTail = (stderrTail + msg).slice(-2000);
        if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
            console.log(`[Remux FFmpeg] ${msg}`);
        }
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        if (!ffmpeg.killed) {
            console.log('[Remux] Client disconnected, killing FFmpeg process');
            ffmpeg.kill('SIGKILL');
        }
    });

    // Map common ffmpeg failure modes to a user-friendly error message.
    function categorizeUpstreamFailure(tail) {
        const lower = tail.toLowerCase();
        if (lower.includes('404 not found')) return { reason: 'not_found', message: 'Stream not found on provider (404)' };
        if (lower.includes('403 forbidden')) return { reason: 'forbidden', message: 'Provider denied access to this stream (403)' };
        if (lower.includes('connection refused') || lower.includes('connection reset')) return { reason: 'unreachable', message: 'Provider is unreachable' };
        if (lower.includes('input/output error') || lower.includes('end of file') || lower.includes('stream ends prematurely')) {
            return { reason: 'broken_upstream', message: 'Upstream returned an empty or broken stream' };
        }
        if (lower.includes('could not find codec parameters')) return { reason: 'no_codec', message: 'Could not detect stream codecs' };
        return { reason: 'unknown', message: 'Stream unavailable' };
    }

    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) {
            console.error(`[Remux] FFmpeg exited with code ${code}`);
        }
        // No bytes piped → ffmpeg never opened a usable output stream. Surface as 502.
        if (bytesWritten === 0 && !headerSent && !res.headersSent && !res.writableEnded) {
            const failure = categorizeUpstreamFailure(stderrTail);
            res.status(502).json({ error: failure.message, reason: failure.reason });
        } else if (!res.writableEnded) {
            res.end();
        }
    });

    ffmpeg.on('error', (err) => {
        console.error('[Remux] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
