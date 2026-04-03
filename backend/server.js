const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const modelRouter = require('./models');
const axios = require('axios');
const RssParser = require('rss-parser');
require('dotenv').config();
const parser = new RssParser();
const { version: APP_VERSION } = require('./package.json');

const { spawn, exec } = require('child_process');
const app = express();
const port = 3001;
const API_BASE = `http://localhost:${port}`;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============================================================
// FREE TIER: Daily usage counter (20 uses/day, then BYOK)
// ============================================================
const FREE_DAILY_LIMIT = 20;
let freeUsage = { date: null, count: 0 };

function getFreeApiKey() {
    return process.env.FREE_GEMINI_KEY || null;
}

function checkAndConsumeFreeTier() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (freeUsage.date !== today) {
        freeUsage = { date: today, count: 0 }; // Reset daily
    }
    if (freeUsage.count < FREE_DAILY_LIMIT) {
        freeUsage.count++;
        return true; // OK to use free key
    }
    return false; // Limit hit, require user's key
}

function getRemainingFreeUses() {
    const today = new Date().toISOString().slice(0, 10);
    if (freeUsage.date !== today) return FREE_DAILY_LIMIT;
    return Math.max(0, FREE_DAILY_LIMIT - freeUsage.count);
}

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ============================================================
// BINARY PATH RESOLVER (Single source of truth)
// ============================================================
const { getYtDlpPath, getFfmpegPath } = require('./bin-resolver');
const ytdlpBinaryPath = getYtDlpPath();
const ffmpegBinaryPath = getFfmpegPath();

// ============================================================
// PYTHON PATH RESOLVER (Prefer venv Python for Whisper/WhisperX)
// ============================================================
const getPythonCmd = () => {
    const venvPython = path.join(__dirname, 'venv', 'bin', 'python3');
    const venvPythonWin = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
    if (process.platform === 'win32') {
        return fs.existsSync(venvPythonWin) ? venvPythonWin : 'python';
    }
    return fs.existsSync(venvPython) ? venvPython : 'python3';
};
const pythonBinaryPath = getPythonCmd();
console.log(`[INIT] Python binary: ${pythonBinaryPath}`);

// ============================================================
// OVERLAY RENDERER (Puppeteer-based PNG overlay)
// ============================================================
const { renderOverlayToPNG, closeBrowser, getDimensionsForFormat } = require('./lib/overlayRenderer');

// ============================================================
// RESOLUTION HELPER (Dynamic output dimensions)
// ============================================================
const { RESOLUTION_CONFIG, BITRATE_CONFIG, getBitrate, getResolutionDimensions } = require('./utils/resolution');

// ============================================================
// PATH RESOLVER (Portable media path resolution)
// ============================================================
const { resolveMediaPath } = require('./utils/path-resolver');

// ============================================================
// TIME UTILITIES (Timestamp parsing & formatting)
// ============================================================
const { parseTime, formatTime } = require('./utils/time');

// ============================================================
// LICENSE MIDDLEWARE (Server-side license verification)
// ============================================================
// Free version: license check removed
const licenseCheck = (req, res, next) => next();

// ============================================================
// TEXT WRAPPING HELPER (For FFmpeg drawtext overflow prevention)
// ============================================================

/**
 * Wrap text for FFmpeg drawtext filter to prevent overflow
 * Returns an array of lines instead of newline-joined text (FFmpeg drawtext doesn't support \n reliably)
 * Each line should be rendered as a separate drawtext filter
 * @param {string} text - The text to wrap
 * @param {number} fontSize - Base font size in pixels
 * @param {number} maxWidth - Maximum width in pixels (video width minus padding)
 * @param {number} maxLines - Maximum number of lines allowed (default 3)
 * @returns {{ lines: string[], fontSize: number, lineCount: number }} - Array of text lines and adjusted font size
 */
const wrapTextForDrawtext = (text, fontSize, maxWidth, maxLines = 3) => {
    if (!text) return { lines: [], fontSize, lineCount: 0 };

    // Approximate character width: average character is ~0.55 of font size for proportional fonts
    const charWidth = fontSize * 0.55;
    const maxCharsPerLine = Math.floor(maxWidth / charWidth);

    // If text fits on one line, return as-is
    if (text.length <= maxCharsPerLine) {
        return { lines: [text], fontSize, lineCount: 1 };
    }

    // Word wrap algorithm
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;

        if (testLine.length <= maxCharsPerLine) {
            currentLine = testLine;
        } else {
            // Current line is full, start new line
            if (currentLine) lines.push(currentLine);

            // Handle very long words (longer than maxCharsPerLine)
            if (word.length > maxCharsPerLine) {
                // Force break long word
                let remaining = word;
                while (remaining.length > maxCharsPerLine) {
                    lines.push(remaining.substring(0, maxCharsPerLine));
                    remaining = remaining.substring(maxCharsPerLine);
                }
                currentLine = remaining;
            } else {
                currentLine = word;
            }
        }
    }
    if (currentLine) lines.push(currentLine);

    // If too many lines, reduce font size and recurse
    if (lines.length > maxLines) {
        const scaleFactor = Math.sqrt(maxLines / lines.length); // Use sqrt for gentler reduction
        const newFontSize = Math.max(16, Math.floor(fontSize * scaleFactor)); // Minimum 16px

        // Prevent infinite recursion
        if (newFontSize < fontSize) {
            return wrapTextForDrawtext(text, newFontSize, maxWidth, maxLines);
        }
        // If we can't reduce further, just truncate with ellipsis
        const truncatedLines = lines.slice(0, maxLines);
        truncatedLines[maxLines - 1] = truncatedLines[maxLines - 1].substring(0, maxCharsPerLine - 3) + '...';
        return { lines: truncatedLines, fontSize, lineCount: maxLines };
    }

    // Return array of lines (each will be a separate drawtext filter)
    return { lines, fontSize, lineCount: lines.length };
};

// ============================================================
// VTT TEXT CLEANING HELPERS
// ============================================================

/**
 * Strip VTT/HTML inline tags from a text line.
 * Removes timing tags like <00:02:24.771>, <c>, </c>, and HTML entities.
 * Reuses the same regex pattern as parseVttToBlocks.js:80.
 */
function cleanVttLine(text) {
    if (!text) return '';
    return text
        .replace(/<[^>]*>/g, '')      // Strip ALL HTML/VTT tags (<00:02:24.771>, <c>, </c>, etc.)
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')         // Normalize whitespace
        .trim();
}

/**
 * Extract language code from a VTT filename.
 * yt-dlp VTT files follow pattern: name.LANG.vtt or name.LANG-REGION.vtt
 * Examples: "video.en.vtt" → "en", "video.de.vtt" → "de", "video.pt-BR.vtt" → "pt-br"
 */
function detectLangFromVttFilename(filename) {
    const match = filename.match(/\.([a-z]{2}(?:-[a-zA-Z]{2,})?)\.\w*vtt$/i);
    return match ? match[1].toLowerCase() : 'unknown';
}

/**
 * Pick the best VTT from a list, respecting an optional preferred language.
 *
 * Problem: fs.readdirSync() returns files alphabetically, so "video.ar.vtt"
 * sorts before "video.id.vtt". For Indonesian videos whose YouTube auto-subs
 * accidentally include an Arabic track, potentialVtts[0] was blindly picking
 * Arabic — poisoning the WhisperX lang hint and Gemini language detection.
 *
 * Priority:
 *   1. Exact match for preferredLang (e.g. "id" from YouTube metadata)
 *   2. Ordered preference list — common content languages first, less-likely
 *      auto-generated languages (ar, hi, ru) pushed to the back
 *   3. First file in the array as last-resort fallback
 */
// Languages ranked by likelihood of being the intended content language.
// Arabic (ar), Hindi (hi), Russian (ru) pushed to back — YouTube auto-generates
// these widely, causing them to appear alphabetically first (e.g. ar < id) and
// get picked incorrectly for non-Arabic/Hindi/Russian content.
const VTT_LANG_PREFERENCE = [
    'en', 'id', 'pt', 'es', 'fr', 'ko', 'ja', 'zh', 'de', 'it', 'nl', 'pl',
    'tr', 'vi', 'th', 'ms', 'tl', 'sv', 'no', 'da', 'fi', 'cs', 'sk', 'ro',
    'hu', 'uk', 'el', 'he', 'fa', 'bn', 'ta', 'te', 'ml', 'si',
    // Deprioritised — auto-generated widely by YouTube, often incorrectly included
    'ru', 'hi', 'ar'
];

function pickBestVtt(vtts, preferredLang) {
    if (!vtts || vtts.length === 0) return null;
    if (vtts.length === 1) return vtts[0];

    // 1. Honour an explicit caller preference (e.g. YouTube metadata language)
    if (preferredLang && preferredLang !== 'unknown') {
        const norm = preferredLang.toLowerCase();
        const exact = vtts.find(f => {
            const lang = detectLangFromVttFilename(f);
            return lang === norm || lang.startsWith(norm + '-');
        });
        if (exact) return exact;
    }

    // 2. Use ordered preference list (avoids alphabetical-first trap, keeps ar/hi/ru last)
    for (const lang of VTT_LANG_PREFERENCE) {
        const match = vtts.find(f => {
            const detected = detectLangFromVttFilename(f);
            return detected === lang || detected.startsWith(lang + '-');
        });
        if (match) return match;
    }

    // 3. Last resort: anything that is NOT Arabic/Hindi/Russian
    const nonArabic = vtts.find(f => {
        const lang = detectLangFromVttFilename(f);
        return lang !== 'ar' && lang !== 'hi' && lang !== 'ru';
    });
    if (nonArabic) {
        console.warn(`[VTT] pickBestVtt: falling back to non-Arabic track: ${nonArabic}`);
        return nonArabic;
    }

    // 4. Absolute last resort
    console.warn(`[VTT] pickBestVtt: no preferred match found in [${vtts.join(', ')}], falling back to first`);
    return vtts[0];
}

// ============================================================
// YT-DLP SPAWN HELPERS (No youtube-dl-exec dependency)
// ============================================================

// ============================================================
// FRIENDLY ERROR MESSAGE PARSERS
// ============================================================

/**
 * Parse yt-dlp error output and return user-friendly error message
 * @param {string} stderr - yt-dlp stderr output
 * @param {number} code - Exit code
 * @returns {{ title: string, message: string, code: string, canRetry: boolean, suggestions: string[] }}
 */
const parseYtdlpError = (stderr, code) => {
    const lowerStderr = stderr.toLowerCase();

    // Helper to create consistent error objects
    const createError = (title, message, errorCode, canRetry, suggestions) => ({
        title,
        message,
        code: errorCode,
        canRetry,
        suggestions
    });

    // === HTTP ERRORS ===

    // 403 Forbidden - YouTube blocking
    if (lowerStderr.includes('http error 403') || lowerStderr.includes('403 forbidden') ||
        (lowerStderr.includes('403') && lowerStderr.includes('forbidden'))) {
        return createError(
            '🚫 Access Denied (403)',
            'YouTube is blocking this download request. This is usually temporary and happens when YouTube detects automated access.',
            '403_FORBIDDEN',
            true,
            [
                'Update yt-dlp in Settings (most common fix)',
                'Wait 5-10 minutes and try again',
                'Try a different video to test',
                'Restart the application'
            ]
        );
    }

    // 429 Rate limiting
    if (lowerStderr.includes('429') || lowerStderr.includes('too many requests') || lowerStderr.includes('rate limit')) {
        return createError(
            '⏱️ Too Many Requests (429)',
            'You\'ve made too many download requests in a short time. YouTube has temporarily limited your access.',
            '429_RATE_LIMIT',
            true,
            [
                'Wait 10-15 minutes before trying again',
                'Avoid downloading multiple videos rapidly',
                'Your access will automatically restore after waiting'
            ]
        );
    }

    // 404 Not found
    if (lowerStderr.includes('404') || lowerStderr.includes('not found')) {
        return createError(
            '🔍 Video Not Found (404)',
            'The video could not be found at this URL. It may have been deleted or the URL is incorrect.',
            '404_NOT_FOUND',
            false,
            [
                'Double-check the video URL is correct',
                'Verify the video still exists on YouTube',
                'Try opening the URL in your browser first'
            ]
        );
    }

    // DRM Protected / JavaScript Runtime error (often misreported by yt-dlp)
    // This usually means yt-dlp couldn't solve YouTube's JS challenges, not actual DRM
    if (lowerStderr.includes('drm protected') || lowerStderr.includes('nsig') ||
        lowerStderr.includes('signature extraction')) {
        return createError(
            '🔐 JavaScript Runtime Issue',
            'YouTube requires a JavaScript runtime to download this video. This error often appears when yt-dlp cannot solve YouTube\'s protection challenges.',
            'JS_RUNTIME_REQUIRED',
            true,
            [
                'Update yt-dlp in Settings (most common fix)',
                'Ensure Node.js is installed and accessible',
                'Restart the application after updating',
                'Try a different video to test if yt-dlp works'
            ]
        );
    }

    // 410 Gone
    if (lowerStderr.includes('410') || lowerStderr.includes('gone')) {
        return createError(
            '🗑️ Video Removed (410)',
            'This video has been permanently removed from YouTube.',
            '410_GONE',
            false,
            [
                'The video was deleted by the creator or YouTube',
                'There is no way to recover this video',
                'Try finding an alternative source'
            ]
        );
    }

    // === VIDEO ACCESS ERRORS ===

    // Video unavailable (general)
    if (lowerStderr.includes('video unavailable') || lowerStderr.includes('video is unavailable') ||
        lowerStderr.includes('this video is not available')) {
        return createError(
            '🚫 Video Unavailable',
            'This video cannot be accessed. It may be private, deleted, or restricted.',
            'VIDEO_UNAVAILABLE',
            false,
            [
                'Check if the video is still available on YouTube',
                'The video may be private or unlisted',
                'The creator may have deleted or hidden it'
            ]
        );
    }

    // Private video
    if (lowerStderr.includes('private video') || lowerStderr.includes('is private')) {
        return createError(
            '🔒 Private Video',
            'This video is set to private by the creator. Only the owner can view it.',
            'PRIVATE_VIDEO',
            false,
            [
                'Contact the video owner for access',
                'The video cannot be downloaded without owner permission',
                'Try finding a public version of this content'
            ]
        );
    }

    // Age-restricted
    if ((lowerStderr.includes('age') && lowerStderr.includes('restrict')) ||
        lowerStderr.includes('sign in to confirm your age') ||
        lowerStderr.includes('age-restricted')) {
        return createError(
            '🔞 Age-Restricted Content',
            'This video is age-restricted by YouTube and requires authentication to access.',
            'AGE_RESTRICTED',
            true,
            [
                'Enable YouTube Authentication in Settings (recommended)',
                'Select your browser (Chrome/Firefox/Edge/Safari) to use your YouTube login',
                'Make sure you\'re logged into YouTube in that browser',
                'Alternatively, manually download the video and use "Upload File"'
            ]
        );
    }

    // Geo-restriction
    if (lowerStderr.includes('not available in your country') || lowerStderr.includes('geo') ||
        lowerStderr.includes('blocked in your') || lowerStderr.includes('region')) {
        return createError(
            '🌍 Region Restricted',
            'This video is not available in your country. The creator has limited viewing to specific regions.',
            'GEO_RESTRICTED',
            false,
            [
                'The video is blocked in your geographic region',
                'A VPN might help but may violate terms of service',
                'Try finding the content from a local source'
            ]
        );
    }

    // Premium/Member only
    if (lowerStderr.includes('member') || lowerStderr.includes('premium') ||
        lowerStderr.includes('subscription') || lowerStderr.includes('join this channel')) {
        return createError(
            '💎 Members-Only Content',
            'This video is exclusive to channel members or YouTube Premium subscribers.',
            'MEMBERS_ONLY',
            false,
            [
                'This content requires a paid membership',
                'Consider supporting the creator by subscribing',
                'Public videos from this creator may still be available'
            ]
        );
    }

    // Copyright/DMCA
    if (lowerStderr.includes('copyright') || lowerStderr.includes('dmca') ||
        lowerStderr.includes('blocked') || lowerStderr.includes('claim')) {
        return createError(
            '©️ Copyright Blocked',
            'This video has been blocked due to a copyright claim or takedown notice.',
            'COPYRIGHT_BLOCKED',
            false,
            [
                'The rights holder has restricted this content',
                'The video may be available in some regions but not others',
                'Try finding officially licensed alternatives'
            ]
        );
    }

    // === CONTENT TYPE ERRORS ===

    // Live stream
    if ((lowerStderr.includes('live') && lowerStderr.includes('stream')) ||
        lowerStderr.includes('is live') || lowerStderr.includes('live event')) {
        return createError(
            '🔴 Live Stream',
            'This is a live stream that cannot be downloaded while broadcasting.',
            'LIVE_STREAM',
            true,
            [
                'Wait until the live stream ends',
                'YouTube usually archives streams after they finish',
                'Try again once the broadcast is complete'
            ]
        );
    }

    // Premiere
    if (lowerStderr.includes('premiere') || lowerStderr.includes('premiering')) {
        return createError(
            '🎬 Video Premiere',
            'This video is scheduled as a premiere and not yet available for download.',
            'PREMIERE',
            true,
            [
                'Wait until the premiere starts and completes',
                'Check back after the scheduled premiere time',
                'The video will be available after the premiere ends'
            ]
        );
    }

    // Playlist error
    if (lowerStderr.includes('playlist') && (lowerStderr.includes('unavailable') || lowerStderr.includes('empty'))) {
        return createError(
            '📋 Playlist Error',
            'The playlist is unavailable or empty.',
            'PLAYLIST_ERROR',
            false,
            [
                'Check if the playlist still exists',
                'The playlist may be private or deleted',
                'Try downloading individual videos instead'
            ]
        );
    }

    // === NETWORK ERRORS ===

    // Connection/Network errors
    if (lowerStderr.includes('urlopen error') || lowerStderr.includes('connection') ||
        lowerStderr.includes('network') || lowerStderr.includes('unable to download') ||
        lowerStderr.includes('getaddrinfo') || lowerStderr.includes('name resolution')) {
        return createError(
            '🌐 Network Error',
            'Unable to connect to YouTube. Check your internet connection.',
            'NETWORK_ERROR',
            true,
            [
                'Check your internet connection',
                'Verify YouTube is accessible in your browser',
                'Check if a firewall is blocking the connection',
                'Try again in a few moments'
            ]
        );
    }

    // Timeout
    if (lowerStderr.includes('timeout') || lowerStderr.includes('timed out')) {
        return createError(
            '⏰ Connection Timeout',
            'The connection to YouTube timed out. The server may be slow or your network is unstable.',
            'TIMEOUT',
            true,
            [
                'Check your internet connection stability',
                'Try again - this is often temporary',
                'YouTube servers may be experiencing high load'
            ]
        );
    }

    // SSL/Certificate errors
    if (lowerStderr.includes('ssl') || lowerStderr.includes('certificate') || lowerStderr.includes('cert')) {
        return createError(
            '🔐 SSL/Security Error',
            'There was a security certificate issue connecting to YouTube.',
            'SSL_ERROR',
            true,
            [
                'Check your system date and time are correct',
                'Your network may be intercepting connections',
                'Try on a different network'
            ]
        );
    }

    // === URL/FORMAT ERRORS ===

    // Invalid URL
    if (lowerStderr.includes('unsupported url') || lowerStderr.includes('not a valid') ||
        lowerStderr.includes('no video formats') || lowerStderr.includes('url is not valid') ||
        lowerStderr.includes('is not a valid url')) {
        return createError(
            '🔗 Invalid URL',
            'The URL provided is not a valid YouTube video URL.',
            'INVALID_URL',
            false,
            [
                'Check the URL format is correct',
                'Supported: youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/...',
                'Copy the URL directly from your browser'
            ]
        );
    }

    // No formats available
    if (lowerStderr.includes('no video formats') || lowerStderr.includes('requested format') ||
        lowerStderr.includes('format not available')) {
        return createError(
            '📹 Format Unavailable',
            'The requested video quality/format is not available.',
            'FORMAT_UNAVAILABLE',
            true,
            [
                'Try selecting a different quality option',
                'Use "Best Available" quality setting',
                'Some videos have limited quality options'
            ]
        );
    }

    // === SYSTEM ERRORS ===

    // yt-dlp internal error
    if (lowerStderr.includes('extractor error') || lowerStderr.includes('extraction') ||
        lowerStderr.includes('unable to extract')) {
        return createError(
            '⚙️ Extraction Error',
            'yt-dlp encountered an internal error while processing the video. This often means yt-dlp needs updating.',
            'EXTRACTION_ERROR',
            true,
            [
                'Update yt-dlp in Settings',
                'YouTube may have changed their website',
                'Try again after updating'
            ]
        );
    }

    // Cookie extraction errors
    if (lowerStderr.includes('could not find') && (lowerStderr.includes('cookies') || lowerStderr.includes('browser'))) {
        return createError(
            '🍪 Cookie Extraction Failed',
            'Unable to extract cookies from the selected browser. Make sure the browser is installed and you\'re logged into YouTube.',
            'COOKIE_EXTRACTION_FAILED',
            true,
            [
                'Verify the selected browser is installed on your system',
                'Make sure you\'re logged into YouTube in that browser',
                'Try selecting a different browser in Settings',
                'Close the browser and try again (some browsers lock cookie files)',
                'Disable YouTube Authentication in Settings if not needed'
            ]
        );
    }

    // Sign in required (generic)
    if (lowerStderr.includes('sign in') || lowerStderr.includes('login') || lowerStderr.includes('authenticate')) {
        return createError(
            '🔑 Login Required',
            'YouTube is requiring a login to access this video. This usually happens with private videos, member-only content, or when YouTube detects automated access.',
            'LOGIN_REQUIRED',
            true,
            [
                'Enable YouTube Authentication in Settings (recommended)',
                'Select your browser to use your YouTube login session',
                'Try updating yt-dlp in Settings (fixes most cases)',
                'Wait a few minutes and try again — YouTube may be rate-limiting',
                'If the video is public, try a different video first to test'
            ]
        );
    }

    // === DEFAULT FALLBACK ===

    // Extract the most relevant error line
    const errorLines = stderr.split(/\r?\n/).filter(line =>
        line.toLowerCase().includes('error') ||
        line.toLowerCase().includes('warning') ||
        line.toLowerCase().includes('unable')
    );
    const relevantError = errorLines.length > 0
        ? errorLines[errorLines.length - 1].trim()
        : stderr.slice(-150).trim();

    return createError(
        '❌ Download Failed',
        `An unexpected error occurred while downloading the video.`,
        `UNKNOWN_${code}`,
        true,
        [
            'Update yt-dlp in Settings',
            'Try a different video',
            'Restart the application',
            `Technical: ${relevantError.substring(0, 100)}${relevantError.length > 100 ? '...' : ''}`
        ]
    );
};

/**
 * Format error object into user-friendly string
 * @param {object} errorObj - Error object from parseYtdlpError
 * @returns {string} - Formatted error message
 */
const formatYtdlpError = (errorObj) => {
    let output = `${errorObj.title}\n\n${errorObj.message}`;

    if (errorObj.suggestions && errorObj.suggestions.length > 0) {
        output += '\n\n💡 What to try:';
        errorObj.suggestions.forEach((suggestion, i) => {
            output += `\n${i + 1}. ${suggestion}`;
        });
    }

    return output;
};

/**
 * Parse FFmpeg error output and return user-friendly error message
 * @param {string} stderr - FFmpeg stderr output
 * @param {number} code - Exit code
 * @returns {string} - User-friendly error message
 */
const parseFFmpegError = (stderr, code) => {
    const lowerStderr = stderr.toLowerCase();

    // Invalid input file
    if (lowerStderr.includes('no such file') || lowerStderr.includes('does not exist')) {
        return 'Source video file not found. The video may have been moved, deleted, or the download was incomplete. Try downloading the video again.';
    }

    // Corrupt video
    if (lowerStderr.includes('invalid data') || lowerStderr.includes('corrupt') || lowerStderr.includes('moov atom not found')) {
        return 'The video file appears to be corrupted or incomplete. This can happen if the download was interrupted. Please re-download the video and try again.';
    }

    // Codec issues
    if (lowerStderr.includes('decoder') || lowerStderr.includes('codec not found') || lowerStderr.includes('unknown encoder')) {
        return 'Video codec error. The video uses an unsupported format. Try downloading the video in a different quality/format.';
    }

    // Disk space
    if (lowerStderr.includes('no space') || lowerStderr.includes('disk full') || lowerStderr.includes('write error')) {
        return 'Not enough disk space to process the video. Please free up some space and try again. Video processing requires temporary space of approximately 2-3x the video size.';
    }

    // Permission denied
    if (lowerStderr.includes('permission denied') || lowerStderr.includes('access denied')) {
        return 'Permission denied when writing files. Please check that the application has write access to the output folder, or try running as administrator.';
    }

    // Filter errors (drawtext, etc.)
    if (lowerStderr.includes('invalid argument') && lowerStderr.includes('drawtext')) {
        return 'Text overlay error. There may be special characters in your hook text that are causing issues. Try simplifying the text or removing special characters like & < > " \' [ ] { }.';
    }

    // Memory issues
    if (lowerStderr.includes('memory') || lowerStderr.includes('cannot allocate')) {
        return 'Not enough memory (RAM) to process this video. Try:\n\n• Closing other applications\n• Processing at a lower resolution\n• Processing fewer clips at once';
    }

    // Duration/timestamp issues
    if (lowerStderr.includes('duration') || lowerStderr.includes('invalid timestamp')) {
        return 'Invalid clip timestamp. The start or end time may be outside the video duration. Please check your clip timings.';
    }

    // Hardware encoder issues
    if (lowerStderr.includes('nvenc') || lowerStderr.includes('videotoolbox') || lowerStderr.includes('qsv')) {
        return 'Hardware encoder error. The system will automatically fall back to software encoding, which may be slower. If this happens frequently, check your GPU drivers.';
    }

    // Default
    const shortError = stderr.slice(-200).trim();
    return `Video processing failed (code ${code}). Technical details: ${shortError}\n\nTry:\n• Using a simpler video format\n• Reducing the output resolution\n• Processing fewer clips at once`;
};

/**
 * Parse AI/Gemini API errors and return user-friendly message
 * @param {Error} error - The error object
 * @param {string} model - The AI model being used
 * @returns {string} - User-friendly error message
 */
const parseAIError = (error, model = 'AI') => {
    const errorMsg = error.message?.toLowerCase() || '';

    // API Key issues
    if (errorMsg.includes('api key') || errorMsg.includes('invalid key') || errorMsg.includes('unauthorized') || errorMsg.includes('401')) {
        return `Invalid ${model} API key. Please check:\n\n• The API key is correctly copied from your ${model} account\n• The API key is active and not expired\n• You have billing enabled (for paid APIs)\n\nGo to Settings to update your API key.`;
    }

    // Rate limiting
    if (errorMsg.includes('rate limit') || errorMsg.includes('quota') || errorMsg.includes('429') || errorMsg.includes('too many')) {
        return `${model} rate limit exceeded. You've made too many requests. Please:\n\n• Wait a few minutes before trying again\n• Consider upgrading your API plan for higher limits\n• Try using a different AI model`;
    }

    // Model not available
    if (errorMsg.includes('model not found') || errorMsg.includes('not available') || errorMsg.includes('404')) {
        return `The ${model} model is not available. It may have been deprecated or renamed. Try selecting a different model variant in Settings.`;
    }

    // Content filtering
    if (errorMsg.includes('safety') || errorMsg.includes('blocked') || errorMsg.includes('content')) {
        return `${model} blocked the request due to content safety filters. The video content may have triggered safety restrictions. Try a different video or adjust your analysis instructions.`;
    }

    // Network issues
    if (errorMsg.includes('network') || errorMsg.includes('timeout') || errorMsg.includes('connection') || errorMsg.includes('econnrefused')) {
        return `Cannot connect to ${model} API. Please check your internet connection and try again. If the problem persists, the API service may be experiencing issues.`;
    }

    // JSON parsing issues
    if (errorMsg.includes('json') || errorMsg.includes('parse') || errorMsg.includes('invalid schema')) {
        return `${model} returned an invalid response format. This sometimes happens with complex videos. Try:\n\n• Running the analysis again\n• Using a different AI model\n• Simplifying your analysis instructions`;
    }

    // Token/context length
    if (errorMsg.includes('token') || errorMsg.includes('context') || errorMsg.includes('too long')) {
        return `The video transcript is too long for ${model} to process. Try:\n\n• Using a shorter video\n• Selecting a model with larger context (like Gemini 1.5 Pro)\n• Processing specific segments instead of the full video`;
    }

    // Server errors
    if (errorMsg.includes('500') || errorMsg.includes('502') || errorMsg.includes('503') || errorMsg.includes('server')) {
        return `${model} server is experiencing issues. This is temporary. Please wait a few minutes and try again. If the problem persists, try a different AI model.`;
    }

    // Default
    return `${model} analysis failed: ${error.message}\n\nTry:\n• Running the analysis again\n• Using a different AI model\n• Checking your API key in Settings`;
};

/**
 * Parse file system errors and return user-friendly message
 * @param {Error} error - The error object
 * @returns {string} - User-friendly error message
 */
const parseFileError = (error) => {
    const errorMsg = error.message?.toLowerCase() || '';
    const code = error.code?.toLowerCase() || '';

    if (code === 'enoent' || errorMsg.includes('no such file')) {
        return 'File not found. The file may have been moved, deleted, or the path is incorrect. Please verify the file location.';
    }

    if (code === 'eacces' || code === 'eperm' || errorMsg.includes('permission')) {
        return 'Permission denied. The application doesn\'t have access to this file or folder. Try:\n\n• Running the app as administrator\n• Moving files to a folder you have access to\n• Checking folder permissions';
    }

    if (code === 'enospc' || errorMsg.includes('no space')) {
        return 'Disk is full. Please free up space on your drive and try again. Video processing requires significant temporary space.';
    }

    if (code === 'emfile' || errorMsg.includes('too many open')) {
        return 'Too many files open. Please close some applications and try again, or restart the application.';
    }

    if (errorMsg.includes('busy') || errorMsg.includes('locked')) {
        return 'File is in use by another application. Please close any programs that might be using this file and try again.';
    }

    return `File operation failed: ${error.message}`;
};

/**
 * Player client strategies to try when 403 errors occur
 * YouTube frequently changes which clients work, so we try multiple strategies
 */
const PLAYER_CLIENT_STRATEGIES = [
    // Strategy 1: Default — no extractor-args, yt-dlp handles PO tokens automatically (matches terminal behavior)
    { name: 'default', args: null },
    // Strategy 2: iOS client — HLS combined streams, no PO token
    { name: 'ios', args: 'youtube:player_client=ios' },
    // Strategy 3: Android client — DASH separate streams, no PO token, H.264 up to 1080p
    { name: 'android', args: 'youtube:player_client=android' },
    // Strategy 4: Web + TV — DASH streams but web client now requires PO token; often falls back to 360p pre-muxed
    { name: 'web+tv', args: 'youtube:player_client=web,tv' },
    // Strategy 5: TV embedded
    { name: 'tv_embedded', args: 'youtube:player_client=tv_embedded' },
    // Strategy 6: Web + mweb fallback
    { name: 'web+mweb', args: 'youtube:player_client=web,mweb' },
];

// Track which strategy is currently working best
let currentStrategyIndex = 0;

/**
 * Build common yt-dlp arguments with platform-specific optimizations
 * @param {number} strategyIndex - Which player client strategy to use
 */
const getYtdlpBaseArgs = (strategyIndex = currentStrategyIndex) => {
    // Platform-specific user agent to avoid bot detection (use latest Chrome)
    const isWindows = process.platform === 'win32';
    const userAgent = isWindows
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--no-prefer-free-formats',    // IMPORTANT: don't pick VP9/WebM over H.264 — VP9 fails to merge to MP4
        '--ignore-errors',
        '--js-runtimes', 'node',
        '--add-header', 'referer:https://www.youtube.com/',
        '--add-header', `user-agent:${userAgent}`,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--socket-timeout', '60',
        '--retries', '50',
        '--fragment-retries', '50',
        '--file-access-retries', '10',
        '--force-ipv4'
    ];

    // Add player client strategy if specified
    const strategy = PLAYER_CLIENT_STRATEGIES[strategyIndex];
    if (strategy && strategy.args) {
        args.push('--extractor-args', strategy.args);
    }

    if (ffmpegBinaryPath) {
        args.push('--ffmpeg-location', ffmpegBinaryPath);
    }
    return args;
};

/**
 * Get current yt-dlp version
 */
const getYtdlpVersion = () => {
    return new Promise((resolve) => {
        if (!ytdlpBinaryPath) return resolve(null);
        const proc = spawn(ytdlpBinaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        let stdout = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.on('close', code => resolve(code === 0 ? stdout.trim() : null));
        proc.on('error', () => resolve(null));
    });
};

/**
 * Run yt-dlp with a specific strategy
 * @param {string} url - YouTube URL
 * @param {number} strategyIndex - Strategy to use
 * @param {string[]} extraArgs - Additional arguments
 * @returns {Promise<object>} - Parsed JSON output
 */
const ytdlpJsonWithStrategy = (url, strategyIndex, extraArgs = []) => {
    return new Promise((resolve, reject) => {
        if (!ytdlpBinaryPath) {
            return reject(new Error('yt-dlp binary not found. Place yt-dlp.exe in backend/bin/'));
        }
        const args = [...getYtdlpBaseArgs(strategyIndex), '--dump-single-json', ...extraArgs, url];
        const proc = spawn(ytdlpBinaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('close', code => {
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`JSON parse failed: ${e.message}`));
                }
            } else {
                const is403 = stderr.toLowerCase().includes('403') || stderr.includes('HTTP Error 403') ||
                    stderr.toLowerCase().includes('sign in to confirm') || stderr.toLowerCase().includes('not a bot');
                reject({ code, stderr, is403 });
            }
        });
        proc.on('error', err => reject(new Error(`Spawn error: ${err.message}`)));
    });
};

/**
 * Run yt-dlp and return parsed JSON output with multi-strategy fallback
 * @param {string} url - YouTube URL
 * @param {string[]} extraArgs - Additional arguments
 * @returns {Promise<object>} - Parsed JSON output
 */
const ytdlpJson = async (url, extraArgs = []) => {
    if (!ytdlpBinaryPath) {
        throw new Error('yt-dlp binary not found. Please restart the application to auto-download it, or manually place yt-dlp in backend/bin/');
    }

    let lastError = null;
    const triedStrategies = [];

    // First try with current best strategy
    const strategiesToTry = [
        currentStrategyIndex,
        ...PLAYER_CLIENT_STRATEGIES.map((_, i) => i).filter(i => i !== currentStrategyIndex)
    ];

    for (const strategyIndex of strategiesToTry) {
        const strategy = PLAYER_CLIENT_STRATEGIES[strategyIndex];
        triedStrategies.push(strategy.name);

        try {
            console.log(`[YTDLP] Trying strategy: ${strategy.name}`);
            const result = await ytdlpJsonWithStrategy(url, strategyIndex, extraArgs);

            // Success! Update the preferred strategy
            if (strategyIndex !== currentStrategyIndex) {
                console.log(`[YTDLP] Strategy ${strategy.name} worked! Updating default.`);
                currentStrategyIndex = strategyIndex;
            }

            return result;
        } catch (err) {
            lastError = err;

            // Only retry on 403 errors
            if (!err.is403) {
                console.log(`[YTDLP] Non-403 error with ${strategy.name}, not retrying other strategies`);
                break;
            }

            console.log(`[YTDLP] Strategy ${strategy.name} failed with 403, trying next...`);
        }
    }

    // All strategies failed - create user-friendly error
    if (lastError.stderr) {
        const errorObj = parseYtdlpError(lastError.stderr, lastError.code);

        // For 403 errors, add strategy info since we tried multiple approaches
        if (errorObj.code === '403_FORBIDDEN') {
            errorObj.suggestions.push(`Tried ${triedStrategies.length} different download methods`);
        }

        throw new Error(formatYtdlpError(errorObj));
    }

    throw new Error(lastError.message || 'An unknown error occurred while downloading');
};

/**
 * Spawn yt-dlp process for streaming/download (single strategy)
 * @param {string} url - YouTube URL
 * @param {string[]} extraArgs - Additional arguments
 * @param {number} strategyIndex - Strategy to use
 * @returns {ChildProcess}
 */
const ytdlpSpawnWithStrategy = (url, extraArgs = [], strategyIndex = currentStrategyIndex) => {
    if (!ytdlpBinaryPath) {
        throw new Error('yt-dlp binary not found. Place yt-dlp.exe in backend/bin/');
    }
    const args = [...getYtdlpBaseArgs(strategyIndex), ...extraArgs, url];
    return spawn(ytdlpBinaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
};

/**
 * Spawn yt-dlp process for streaming/download (legacy, uses current strategy)
 * @param {string} url - YouTube URL
 * @param {string[]} extraArgs - Additional arguments
 * @returns {ChildProcess}
 */
const ytdlpSpawn = (url, extraArgs = []) => {
    return ytdlpSpawnWithStrategy(url, extraArgs, currentStrategyIndex);
};

/**
 * Download with multi-strategy retry
 * Returns a promise that resolves when download completes or rejects with error
 * @param {string} url - YouTube URL
 * @param {string} outputPath - Output file path
 * @param {string[]} extraArgs - Additional arguments
 * @param {function} onProgress - Progress callback (progress, logs)
 * @param {function} onStderr - Stderr callback
 * @returns {Promise<{code: number, stderr: string, strategyUsed: string}>}
 */
const ytdlpDownloadWithRetry = async (url, outputPath, extraArgs = [], onProgress = null, onStderr = null) => {
    if (!ytdlpBinaryPath) {
        throw new Error('yt-dlp binary not found. Please restart the application to auto-download it.');
    }

    const triedStrategies = [];
    let lastError = null;

    // Order strategies: current best first, then others
    const strategiesToTry = [
        currentStrategyIndex,
        ...PLAYER_CLIENT_STRATEGIES.map((_, i) => i).filter(i => i !== currentStrategyIndex)
    ];

    for (const strategyIndex of strategiesToTry) {
        const strategy = PLAYER_CLIENT_STRATEGIES[strategyIndex];
        triedStrategies.push(strategy.name);

        console.log(`[YTDLP-DL] Trying download with strategy: ${strategy.name}`);

        try {
            const result = await new Promise((resolve, reject) => {
                // Clean up any partial file from previous attempt
                if (fs.existsSync(outputPath)) {
                    try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
                }

                const subprocess = ytdlpSpawnWithStrategy(url, extraArgs, strategyIndex);

                let stderrBuffer = '';
                let progressLogs = [];

                subprocess.stdout.on('data', (data) => {
                    const str = data.toString();
                    const match = str.match(/(\d+\.\d+)%/);
                    if (match && onProgress) {
                        onProgress(parseFloat(match[1]), str);
                    }
                    const lines = str.split(/\r?\n/).filter(l => l.trim());
                    progressLogs.push(...lines);
                });

                subprocess.stderr.on('data', (data) => {
                    const errStr = data.toString().trim();
                    stderrBuffer += errStr + '\n';
                    if (onStderr) onStderr(errStr);
                });

                subprocess.on('close', (code) => {
                    if (code === 0) {
                        resolve({ code: 0, stderr: stderrBuffer, strategyUsed: strategy.name });
                    } else {
                        // Check if it's a 403 error
                        const is403 = stderrBuffer.toLowerCase().includes('403') ||
                            stderrBuffer.includes('HTTP Error 403') ||
                            stderrBuffer.toLowerCase().includes('forbidden') ||
                            stderrBuffer.toLowerCase().includes('sign in to confirm') ||
                            stderrBuffer.toLowerCase().includes('not a bot');
                        // Check if it's a format-not-available error (different clients serve different formats)
                        const isFormatError = stderrBuffer.toLowerCase().includes('requested format') ||
                            stderrBuffer.toLowerCase().includes('format not available') ||
                            stderrBuffer.toLowerCase().includes('no video formats') ||
                            stderrBuffer.toLowerCase().includes('drm protected');  // Often false positive from TV/iOS clients
                        reject({ code, stderr: stderrBuffer, is403, isFormatError, strategyUsed: strategy.name });
                    }
                });

                subprocess.on('error', (err) => {
                    reject({ code: -1, stderr: err.message, is403: false, strategyUsed: strategy.name });
                });
            });

            // Success! Update the preferred strategy
            if (strategyIndex !== currentStrategyIndex) {
                console.log(`[YTDLP-DL] Strategy ${strategy.name} worked! Updating default.`);
                currentStrategyIndex = strategyIndex;
            }

            return result;

        } catch (err) {
            lastError = err;

            // Retry on 403 errors and format-not-available errors (different clients serve different formats)
            if (!err.is403 && !err.isFormatError) {
                console.log(`[YTDLP-DL] Non-retryable error with ${strategy.name} (code ${err.code}), not retrying`);
                break;
            }

            if (err.isFormatError) {
                console.log(`[YTDLP-DL] Format not available with ${strategy.name}, trying next strategy...`);
            }

            console.log(`[YTDLP-DL] Strategy ${strategy.name} failed with 403, trying next...`);
        }
    }

    // All strategies failed
    const errorObj = parseYtdlpError(lastError.stderr || '', lastError.code);
    if (errorObj.code === '403_FORBIDDEN') {
        errorObj.suggestions.push(`Tried ${triedStrategies.length} download strategies: ${triedStrategies.join(', ')}`);
    }

    throw {
        message: formatYtdlpError(errorObj),
        errorObj,
        triedStrategies,
        lastError
    };
};

/**
 * Get video title quickly (for filename generation)
 * @param {string} url
 * @returns {Promise<string|null>}
 */
const ytdlpGetTitle = async (url) => {
    return new Promise((resolve) => {
        if (!ytdlpBinaryPath) return resolve(null);
        const args = ['--get-title', '--no-warnings', '--no-playlist', url];
        const proc = spawn(ytdlpBinaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        let stdout = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.on('close', code => resolve(code === 0 ? stdout.trim() : null));
        proc.on('error', () => resolve(null));
    });
};

const multer = require('multer');

// --- DATABASE SETUP (Phase 2) ---
const DB_DIR = path.join(__dirname, 'db');
const DB_FILE = path.join(DB_DIR, 'db.json');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

// --- ASSETS DB SETUP ---
const ASSETS_FILE = path.join(DB_DIR, 'assets.json');
if (!fs.existsSync(ASSETS_FILE)) fs.writeFileSync(ASSETS_FILE, '[]');

const readAssets = () => {
    try {
        return JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf8'));
    } catch (e) { return []; }
};

const writeAssets = (data) => {
    fs.writeFileSync(ASSETS_FILE, JSON.stringify(data, null, 2));
};

// --- LOGOS DB SETUP ---
const LOGOS_FILE = path.join(DB_DIR, 'logos.json');
if (!fs.existsSync(LOGOS_FILE)) fs.writeFileSync(LOGOS_FILE, '[]');

const readLogos = () => {
    try {
        return JSON.parse(fs.readFileSync(LOGOS_FILE, 'utf8'));
    } catch (e) { return []; }
};

const writeLogos = (data) => {
    fs.writeFileSync(LOGOS_FILE, JSON.stringify(data, null, 2));
};

const readDb = () => {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) { return []; }
};

const writeDb = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};
// --------------------------------

const clipsDirRoot = path.join(__dirname, '..', 'clips');
const downloadsDirRoot = path.join(__dirname, '..', 'downloads');
const assetsDirRoot = path.join(__dirname, '..', 'assets');

if (!fs.existsSync(clipsDirRoot)) fs.mkdirSync(clipsDirRoot, { recursive: true });
if (!fs.existsSync(downloadsDirRoot)) fs.mkdirSync(downloadsDirRoot, { recursive: true });
if (!fs.existsSync(assetsDirRoot)) fs.mkdirSync(assetsDirRoot, { recursive: true });

const logosDirRoot = path.join(__dirname, '..', 'logos');
if (!fs.existsSync(logosDirRoot)) fs.mkdirSync(logosDirRoot, { recursive: true });

const transcriptsDir = path.join(assetsDirRoot, 'transcripts');
if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });

// ============================================================
// STARTUP CLEANUP: Remove orphaned temp files from crashed jobs
// ============================================================
const cleanupOrphanedTempFiles = () => {
    try {
        if (!fs.existsSync(clipsDirRoot)) return;
        const jobDirs = fs.readdirSync(clipsDirRoot);
        let cleanedCount = 0;

        jobDirs.forEach(dir => {
            const dirPath = path.join(clipsDirRoot, dir);
            if (!fs.statSync(dirPath).isDirectory()) return;

            const files = fs.readdirSync(dirPath);
            files.filter(f => f.startsWith('temp_raw_')).forEach(f => {
                fs.unlinkSync(path.join(dirPath, f));
                cleanedCount++;
            });
        });

        if (cleanedCount > 0) {
            console.log(`[STARTUP] Cleaned up ${cleanedCount} orphaned temp file(s) from previous sessions.`);
        } else {
            console.log('[STARTUP] No orphaned temp files found. Clean slate!');
        }
    } catch (err) {
        console.warn('[STARTUP] Cleanup warning:', err.message);
    }
};

// Run cleanup on server start
cleanupOrphanedTempFiles();

// Serve files statically
// Serve files statically with COEP/CORP headers
const staticConfig = {
    setHeaders: (res, path, stat) => {
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.set('Access-Control-Allow-Origin', '*');
    }
};

app.use('/downloaded', express.static(path.join(__dirname, '..', 'downloaded'), staticConfig));
app.use('/clips', express.static(clipsDirRoot, staticConfig));
app.use('/downloads', express.static(downloadsDirRoot, staticConfig));
app.use('/assets', express.static(assetsDirRoot, staticConfig));
app.use('/logos', express.static(logosDirRoot, staticConfig));

// Serve frontend from dist folder (production mode)
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath, staticConfig));
    console.log('[FRONTEND] Serving built frontend from:', frontendDistPath);
}

// Multer Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Dynamic destination based on fieldname or query
        if (req.query.type === 'asset') {
            cb(null, assetsDirRoot);
        } else if (req.query.type === 'logo') {
            cb(null, logosDirRoot);
        } else {
            cb(null, downloadsDirRoot);
        }
    },
    filename: (req, file, cb) => {
        const sanitizedName = file.originalname.toLowerCase().replace(/[^a-z0-9.]/g, '_');
        cb(null, `upload_${Date.now()}_${sanitizedName}`);
    }
});

const upload = multer({ storage });

// File Upload Endpoint
app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const relativePath = path.relative(path.join(__dirname, '..'), req.file.path);
    res.json({
        message: "Upload successful",
        path: relativePath,
        filename: req.file.filename
    });
});

// Medium RSS Feed Proxy
app.get('/api/rss', async (req, res) => {
    try {
        // Use static Qlipper.ai Medium feed
        const feedUrl = 'https://medium.com/feed/@qlipper.ai';

        // Fetch the feed
        const feed = await parser.parseURL(feedUrl).catch(err => {
            console.error(`Error parsing feed ${feedUrl}:`, err.message);
            return null;
        });

        if (!feed) {
            return res.status(500).json({ error: "Failed to fetch RSS feed" });
        }

        // Process items
        const sourceName = feed.title || feed.creator || "Qlipper.ai";
        const allItems = [];

        feed.items.forEach(item => {
            const content = item['content:encoded'] || item.content || '';
            const thumbnail = (content.match(/<img[^>]+src="([^">]+)"/) || [])[1];
            const snippet = (item.contentSnippet || content.replace(/<[^>]*>?/gm, '').substring(0, 160)) + '...';

            allItems.push({
                title: item.title,
                link: item.link,
                pubDate: item.pubDate,
                creator: item.creator || sourceName,
                source: sourceName,
                contentSnippet: snippet,
                categories: item.categories,
                thumbnail: thumbnail ? `${API_BASE}/api/proxy-image?url=${encodeURIComponent(thumbnail)}` : null
            });
        });

        // 4. Sort by Date Descending
        allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        res.json(allItems);
    } catch (error) {
        console.error("RSS Fetch Error:", error);
        res.status(500).json({ error: "Failed to fetch aggregated RSS feeds" });
    }
});

// Image Proxy to bypass COEP/CORS
app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send("URL required");
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        res.set('Content-Type', response.headers['content-type']);
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.send(response.data);
    } catch (error) {
        res.status(500).send("Error proxying image");
    }
});

// Tool A: YouTube Metadata Fetching
app.get('/api/youtube/metadata', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL is required" });

    try {
        const metadata = await ytdlpJson(url);

        // Filter and sort formats
        const formats = metadata.formats
            .filter(f => f.vcodec !== 'none') // Include all video formats
            .map(f => ({
                format_id: f.format_id,
                resolution: f.resolution || `${f.width}x${f.height}`,
                width: f.width || 0,
                height: f.height || 0,
                ext: f.ext,
                filesize: f.filesize || f.filesize_approx,
                note: f.format_note,
                fps: f.fps,
                has_audio: f.acodec !== 'none'
            }))
            .filter(f => f.height > 0)
            .sort((a, b) => b.height - a.height);

        // Determine what resolutions are actually available
        const availableHeights = [...new Set(formats.map(f => f.height))].sort((a, b) => b - a);
        const maxHeight = availableHeights[0] || 720;

        // Build meaningful quality tiers based on what's actually available
        const qualityTiers = [];

        // Always offer "Highest" - no cap, best possible
        qualityTiers.push({
            format_id: 'highest',
            resolution: maxHeight >= 2160 ? '4K' : maxHeight >= 1440 ? '1440p' : maxHeight >= 1080 ? '1080p' : `${maxHeight}p`,
            ext: 'mp4',
            note: `Highest Quality (${maxHeight}p max)`,
            height: maxHeight
        });

        // Offer specific tiers if the video supports them
        if (maxHeight >= 1080) {
            qualityTiers.push({ format_id: 'quality_1080', resolution: '1080p', ext: 'mp4', note: 'Full HD', height: 1080 });
        }
        if (maxHeight >= 720) {
            qualityTiers.push({ format_id: 'quality_720', resolution: '720p', ext: 'mp4', note: 'HD (Recommended)', height: 720 });
        }
        if (maxHeight >= 480) {
            qualityTiers.push({ format_id: 'quality_480', resolution: '480p', ext: 'mp4', note: 'SD - Fast download', height: 480 });
        }

        res.json({
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            duration: metadata.duration_string,
            duration_seconds: metadata.duration,
            channel: metadata.uploader,
            maxHeight,
            formats: qualityTiers,
            language: metadata.language || null
        });
    } catch (error) {
        console.error('[METADATA] Error fetching video info:', error.message);
        // The error message from ytdlpJson already uses parseYtdlpError
        res.status(500).json({
            error: error.message,
            hint: 'Check that the URL is a valid YouTube video link and try again.'
        });
    }
});

// System Status Check (yt-dlp)
app.get('/api/system/ytdlp-status', async (req, res) => {
    if (!ytdlpBinaryPath) {
        return res.json({
            available: false,
            error: 'yt-dlp binary not found',
            binaryPath: 'none',
            hint: 'Place yt-dlp.exe in backend/bin/ or install via winget/brew'
        });
    }

    // Run version check using spawn
    const proc = spawn(ytdlpBinaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.on('close', code => {
        if (code === 0) {
            res.json({
                available: true,
                version: stdout.trim(),
                binaryPath: ytdlpBinaryPath,
                source: ytdlpBinaryPath.includes('bin') ? 'vendored' : 'system'
            });
        } else {
            res.json({
                available: false,
                error: 'yt-dlp version check failed',
                binaryPath: ytdlpBinaryPath,
                hint: 'Binary exists but may be corrupted'
            });
        }
    });
    proc.on('error', err => {
        res.json({
            available: false,
            error: err.message,
            binaryPath: ytdlpBinaryPath,
            hint: 'Binary exists but failed to execute'
        });
    });
});

// System: Update yt-dlp to latest version (with retry + self-update strategy)
app.post('/api/system/ytdlp-update', async (req, res) => {
    const isWindows = process.platform === 'win32';
    const BIN_DIR = path.join(__dirname, 'bin');

    // yt-dlp download URLs
    const YTDLP_URLS = {
        win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
        linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
    };

    // Get current version first
    const oldVersion = await getYtdlpVersion();

    // Determine target path
    const targetPath = path.join(BIN_DIR, isWindows ? 'yt-dlp.exe' : 'yt-dlp');
    const backupPath = targetPath + '.backup';

    console.log(`[YTDLP-UPDATE] Starting update (current: ${oldVersion || 'unknown'})`);

    try {
        // Ensure bin directory exists
        if (!fs.existsSync(BIN_DIR)) {
            fs.mkdirSync(BIN_DIR, { recursive: true });
        }

        let updateMethod = 'unknown';

        // ========================================
        // Strategy 1: Try yt-dlp --update (fastest, most reliable)
        // ========================================
        const selfUpdateOk = await new Promise((resolve) => {
            console.log('[YTDLP-UPDATE] Trying self-update (--update)...');
            const proc = spawn(ytdlpBinaryPath || targetPath, ['--update'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 60000
            });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', d => stdout += d.toString());
            proc.stderr.on('data', d => stderr += d.toString());
            proc.on('close', (code) => {
                const output = stdout + stderr;
                if (code === 0 && !output.includes('ERROR')) {
                    console.log('[YTDLP-UPDATE] Self-update succeeded');
                    resolve(true);
                } else {
                    console.log(`[YTDLP-UPDATE] Self-update unavailable: ${output.trim().substring(0, 150)}`);
                    resolve(false);
                }
            });
            proc.on('error', (err) => {
                console.log(`[YTDLP-UPDATE] Self-update failed: ${err.message}`);
                resolve(false);
            });
        });

        if (selfUpdateOk) {
            updateMethod = 'self-update';
        } else {
            // ========================================
            // Strategy 2: Download binary (with retry + exponential backoff)
            // ========================================
            updateMethod = 'download';
            const downloadUrl = YTDLP_URLS[process.platform] || YTDLP_URLS.linux;
            console.log(`[YTDLP-UPDATE] Downloading from ${downloadUrl}`);

            // Backup existing binary
            if (fs.existsSync(targetPath)) {
                fs.copyFileSync(targetPath, backupPath);
                console.log('[YTDLP-UPDATE] Backed up existing binary');
            }

            // Download with retry (3 attempts, exponential backoff)
            const MAX_RETRIES = 3;
            let downloaded = false;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await new Promise((resolve, reject) => {
                        const followRedirect = (url, redirectCount = 0) => {
                            if (redirectCount > 5) {
                                reject(new Error('Too many redirects'));
                                return;
                            }

                            const protocol = url.startsWith('https') ? require('https') : require('http');
                            const req = protocol.get(url, {
                                headers: { 'User-Agent': 'Qlipper-AI/1.6' },
                                timeout: 60000
                            }, (response) => {
                                if (response.statusCode === 301 || response.statusCode === 302) {
                                    followRedirect(response.headers.location, redirectCount + 1);
                                    return;
                                }

                                if (response.statusCode !== 200) {
                                    reject(new Error(`HTTP ${response.statusCode}`));
                                    return;
                                }

                                const file = fs.createWriteStream(targetPath);
                                response.pipe(file);
                                file.on('finish', () => {
                                    file.close();
                                    resolve();
                                });
                                file.on('error', (err) => {
                                    fs.unlink(targetPath, () => { });
                                    reject(err);
                                });
                            });
                            req.on('error', reject);
                            req.on('timeout', () => {
                                req.destroy();
                                reject(new Error('Download timed out'));
                            });
                        };

                        followRedirect(downloadUrl);
                    });
                    downloaded = true;
                    break;
                } catch (dlErr) {
                    // Clean up partial download
                    try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch { }

                    const isRetryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up|timed out/i.test(dlErr.message);

                    if (isRetryable && attempt < MAX_RETRIES) {
                        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s
                        console.warn(`[YTDLP-UPDATE] Attempt ${attempt}/${MAX_RETRIES} failed: ${dlErr.message}. Retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                    } else {
                        // Restore backup before throwing
                        if (fs.existsSync(backupPath)) {
                            try {
                                fs.copyFileSync(backupPath, targetPath);
                                if (!isWindows) fs.chmodSync(targetPath, 0o755);
                                fs.unlinkSync(backupPath);
                            } catch { }
                        }
                        throw dlErr;
                    }
                }
            }

            if (!downloaded) {
                throw new Error('Download failed after all retries');
            }

            console.log('[YTDLP-UPDATE] Download complete');

            // Make executable on Unix
            if (!isWindows) {
                fs.chmodSync(targetPath, 0o755);
            }

            // Verify the new binary works
            const verifyVersion = await getYtdlpVersion();

            if (!verifyVersion) {
                // Restore backup if new binary doesn't work
                if (fs.existsSync(backupPath)) {
                    fs.copyFileSync(backupPath, targetPath);
                    if (!isWindows) fs.chmodSync(targetPath, 0o755);
                }
                throw new Error('Downloaded binary failed to execute');
            }

            // Clean up backup
            if (fs.existsSync(backupPath)) {
                try { fs.unlinkSync(backupPath); } catch { }
            }
        }

        // Get final version
        const newVersion = await getYtdlpVersion();

        // Reset strategy index on update
        currentStrategyIndex = 0;

        console.log(`[YTDLP-UPDATE] Success (${updateMethod}): ${oldVersion} → ${newVersion}`);

        res.json({
            success: true,
            oldVersion: oldVersion || 'unknown',
            newVersion: newVersion,
            method: updateMethod,
            message: `yt-dlp updated successfully from ${oldVersion || 'unknown'} to ${newVersion}`
        });

    } catch (error) {
        console.error('[YTDLP-UPDATE] Failed:', error.message);

        // Try to restore backup
        if (fs.existsSync(backupPath)) {
            try {
                fs.copyFileSync(backupPath, targetPath);
                if (!isWindows) fs.chmodSync(targetPath, 0o755);
                fs.unlinkSync(backupPath);
                console.log('[YTDLP-UPDATE] Restored backup');
            } catch (restoreErr) {
                console.error('[YTDLP-UPDATE] Failed to restore backup:', restoreErr.message);
            }
        }

        res.status(500).json({
            success: false,
            error: error.message,
            hint: 'Try manual update: download from https://github.com/yt-dlp/yt-dlp/releases and place in backend/bin/'
        });
    }
});

// System: Get 403 troubleshooting info
app.get('/api/system/ytdlp-troubleshoot', async (req, res) => {
    const version = await getYtdlpVersion();
    const currentStrategy = PLAYER_CLIENT_STRATEGIES[currentStrategyIndex];

    res.json({
        version: version || 'unknown',
        binaryPath: ytdlpBinaryPath || 'not found',
        currentStrategy: currentStrategy?.name || 'unknown',
        availableStrategies: PLAYER_CLIENT_STRATEGIES.map(s => s.name),
        tips: [
            'Update yt-dlp: Use the "Update yt-dlp" button in Settings',
            'YouTube changes their API frequently - updates are needed every 2-4 weeks',
            'Try a different video to test if the issue is video-specific',
            'Some videos are region-restricted and cannot be downloaded',
            'Age-restricted videos may require authentication (not supported)',
            'Wait a few minutes if you\'re being rate-limited',
            'Private/unlisted videos are not accessible without login'
        ],
        commonCauses: {
            '403': 'YouTube blocked the request - try updating yt-dlp or waiting',
            'timeout': 'Network issue or YouTube is slow - try again',
            'unavailable': 'Video may be private, deleted, or region-locked',
            'age_restricted': 'Video requires age verification (login needed)'
        }
    });
});

// System: Generic Model Check
app.post('/api/system/check-model', async (req, res) => {
    const { model, apiKey } = req.body;
    if (!model || !apiKey) return res.status(400).json({ success: false, message: 'Model and API Key required' });

    try {
        const result = await modelRouter.verifyKey(model, apiKey);
        if (result && result.valid) {
            res.json({ success: true, models: result.models });
        } else {
            throw new Error("Validation returned false");
        }
    } catch (error) {
        console.error(`${model} Check Failed:`, error.message);
        res.status(400).json({ success: false, message: error.message || 'Key Validation Failed' });
    }
});

// System: Open File/Folder (Cross-platform)
app.post('/api/system/open-file', (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'Missing path' });

    // Sanitize: Ensure it's inside our project (simple check)
    // In production, use stronger validation. Here, assuming local user trust.
    const absPath = path.resolve(path.join(__dirname, '..', filePath));

    console.log(`[OPEN-FILE] Opening file at: ${absPath}`);

    // Check if file exists
    if (!fs.existsSync(absPath)) {
        console.error(`[OPEN-FILE] File not found: ${absPath}`);
        return res.status(404).json({ error: 'File not found' });
    }

    // Cross-platform command to reveal file in folder
    const platform = process.platform;
    let command;

    if (platform === 'darwin') {
        // macOS: Reveal in Finder
        command = `open -R "${absPath}"`;
    } else if (platform === 'win32') {
        // Windows: Open Explorer and select file
        // Use forward slashes converted to backslashes for Windows
        const winPath = absPath.replace(/\//g, '\\');
        command = `explorer /select,"${winPath}"`;
    } else {
        // Linux: Open containing folder (xdg-open doesn't support select)
        const dirPath = path.dirname(absPath);
        command = `xdg-open "${dirPath}"`;
    }

    console.log(`[OPEN-FILE] Running command: ${command}`);

    exec(command, (err) => {
        if (err) {
            console.error("[OPEN-FILE] Failed to open file:", err);
            // On Windows, explorer sometimes returns error even when it works
            if (platform === 'win32') {
                return res.json({ success: true, warning: 'Command executed but may have returned an error' });
            }
            return res.status(500).json({ error: 'Failed to open file', details: err.message });
        }
        res.json({ success: true });
    });
});

// System: Download file directly (for "Save to Files" feature)
app.get('/api/system/download-file', (req, res) => {
    const { filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: 'Missing path' });

    const absPath = path.resolve(path.join(__dirname, '..', filePath));

    console.log(`[DOWNLOAD-FILE] Serving file: ${absPath}`);

    if (!fs.existsSync(absPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const filename = path.basename(absPath);
    res.download(absPath, filename, (err) => {
        if (err) {
            console.error("[DOWNLOAD-FILE] Error:", err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download failed' });
            }
        }
    });
});

// Stream Download (Direct to Browser)
app.post('/api/youtube/download-stream', async (req, res) => {
    const { url, title } = req.body;
    if (!url) return res.status(400).send("URL required");

    const safeTitle = (title || 'video').replace(/[^a-z0-9]/gi, '_');
    res.header('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
    res.header('Content-Type', 'video/mp4');

    try {
        console.log(`[DL-STREAM] Starting download for: ${url}`);
        // Use raw spawn to pipe stdout
        // H.264 + m4a → clean MP4 merge at up to 1080p
        // Fallback order:
        //   1. H.264 video + m4a audio → best quality MP4 merge
        //   2. Any video ≤1080p + any audio → merge
        //   3. Pre-muxed MP4 ≤1080p (no ffmpeg needed)
        //   4. YouTube legacy format 22 (720p MP4 pre-muxed)
        //   5. Absolute best available
        const subprocess = ytdlpSpawn(url, [
            '-f', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/mp4[height<=1080]/22/best',
            '--merge-output-format', 'mp4',
            '-o', '-'
        ]);

        subprocess.stdout.pipe(res);

        subprocess.stderr.on('data', (data) => {
            console.log(`[DL-STREAM-STDERR] ${data}`);
        });

        subprocess.on('error', (err) => {
            console.error(`[DL-STREAM-ERROR] Subprocess error:`, err);
            if (!res.headersSent) res.status(500).send("Stream process error");
        });

        subprocess.on('close', (code) => {
            console.log(`[DL-STREAM] Process closed with code ${code}`);
            if (code !== 0) {
                console.error(`[DL-STREAM] Failed with code ${code}`);
                // Can't send 500 if headers sent, but we log it.
            }
        });

    } catch (error) {
        console.error("Stream Error:", error);
        if (!res.headersSent) res.status(500).send("Stream failed");
    }
});

// Local Download for Pipeline (Saves to server disk)
// --- DOWNLOAD STORE ---
const activeDownloads = {};
const transcriptionJobs = {}; // Store transcription jobs


// Local Download for Pipeline (Async with Progress)
app.post('/api/youtube/download', async (req, res) => {
    let { url, format_id, title, preferredLang, cookieBrowser } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    // 1. Fetch Title if missing (For nice filenames)
    if (!title) {
        try {
            console.log(`[DL-LOCAL] Fetching title for: ${url}`);
            const titleRaw = await ytdlpGetTitle(url);
            if (titleRaw) {
                title = titleRaw;
            }
        } catch (e) {
            console.warn("Could not fetch title for filename:", e.message);
        }
    }

    // 2. Smart Filename Generation
    const baseName = (title || `video_${Date.now()}`)
        .replace(/[^a-zA-Z0-9 \-_]/g, '') // Remove special chars
        .trim()
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .substring(0, 100); // Limit length

    let filename = `${baseName}.mp4`;
    let counter = 1;

    // 3. Uniqueness Check (Counter instead of Timestamp)
    while (fs.existsSync(path.join(assetsDirRoot, filename))) {
        filename = `${baseName}_(${counter}).mp4`;
        counter++;
    }

    const downloadId = `dl_${Date.now()}`;
    const outputPath = path.join(assetsDirRoot, filename);

    // Initialize Status
    activeDownloads[downloadId] = {
        id: downloadId,
        status: 'downloading',
        progress: 0,
        logs: [`[Start] Initializing download for ${url}...`],
        filename: filename,
        path: null,
        title: title || baseName
    };

    console.log(`[DL-LOCAL] Starting download job ${downloadId} -> ${filename}`);
    res.json({ downloadId, message: "Download started", title: title || baseName, filename });

    // Map quality tier to yt-dlp format string
    // Quality tiers: 'highest', 'quality_1080', 'quality_720', 'quality_480', or a raw format_id
    // Format mirrors what works in terminal: bestvideo[ext=mp4]+bestaudio[ext=m4a]
    // No vcodec restrictions — let yt-dlp pick the best available with FFmpeg merge
    let formatArg;
    switch (format_id) {
        case 'highest':
            formatArg = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
            break;
        case 'quality_1080':
            formatArg = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
            break;
        case 'quality_720':
            formatArg = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
            break;
        case 'quality_480':
            formatArg = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best';
            break;
        default:
            formatArg = format_id
                ? `${format_id}+bestaudio[ext=m4a]/${format_id}+bestaudio/best`
                : 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
            break;
    }
    console.log(`[DL-LOCAL] Quality: ${format_id || 'default (1080p)'} → yt-dlp format: ${formatArg}`);

    const downloadArgs = [
        '-f', formatArg,
        '-o', outputPath,
        '--merge-output-format', 'mp4',
        '--write-subs',
        '--write-auto-subs',
        '--sub-lang', preferredLang ? `${preferredLang}.*,en.*` : 'en.*,de.*,es.*,fr.*,pt.*,ja.*,ko.*,zh.*,id.*,ar.*,hi.*,ru.*',
        '--sub-format', 'vtt'
    ];

    // Add browser cookies for authentication if enabled
    if (cookieBrowser && cookieBrowser !== 'none') {
        downloadArgs.push('--cookies-from-browser', cookieBrowser);
        console.log(`[DL-LOCAL] Using ${cookieBrowser} cookies for authentication`);
        activeDownloads[downloadId].logs.push(`[Auth] Using ${cookieBrowser} browser cookies for age-restricted/members-only content`);
    }

    // Use new multi-strategy retry download
    ytdlpDownloadWithRetry(
        url,
        outputPath,
        downloadArgs,
        // Progress callback
        (progress, logStr) => {
            activeDownloads[downloadId].progress = progress;
            const lines = logStr.split(/\r?\n/).filter(l => l.trim());
            lines.forEach(line => {
                if (activeDownloads[downloadId].logs.length > 10) activeDownloads[downloadId].logs.shift();
                activeDownloads[downloadId].logs.push(line);
            });
        },
        // Stderr callback
        (errStr) => {
            console.error(`[DL-STDERR] ${errStr}`);
            activeDownloads[downloadId].logs.push(`ERR: ${errStr}`);
        }
    ).then((result) => {
        // Success
        console.log(`[DL-LOCAL] Job ${downloadId} completed using strategy: ${result.strategyUsed}`);
        const relativePath = path.relative(path.join(__dirname, '..'), outputPath);

        // --- ASSET AUTO-REGISTRATION ---
        try {
            const assets = readAssets();
            const titleSanitized = (title || baseName).replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50);
            const assetRecord = {
                id: `asset_${Date.now()}`,
                name: `[DL] ${titleSanitized}`,
                type: 'video',
                path: relativePath,
                filename: filename,
                timestamp: new Date().toISOString(),
                language: preferredLang || null
            };
            assets.unshift(assetRecord);
            writeAssets(assets);
            activeDownloads[downloadId].logs.push("Registered to Assets Library.");
        } catch (assetErr) {
            console.error("Asset registration failed:", assetErr);
            activeDownloads[downloadId].logs.push("Asset registration failed.");
        }
        // -------------------------------

        activeDownloads[downloadId].status = 'completed';
        activeDownloads[downloadId].progress = 100;
        activeDownloads[downloadId].path = relativePath;
        activeDownloads[downloadId].strategyUsed = result.strategyUsed;
        activeDownloads[downloadId].logs.push(`Download complete (strategy: ${result.strategyUsed}).`);

        // Cleanup after 1 hour
        setTimeout(() => delete activeDownloads[downloadId], 3600000);

    }).catch((error) => {
        // Failed after all retries
        console.error(`[DL-LOCAL] Job ${downloadId} failed:`, error.message || 'Unknown error');

        activeDownloads[downloadId].status = 'failed';
        activeDownloads[downloadId].error = error.message || 'Download failed after trying multiple strategies';
        activeDownloads[downloadId].errorCode = error.errorObj?.code || 'UNKNOWN';
        activeDownloads[downloadId].canRetry = error.errorObj?.canRetry ?? true;
        activeDownloads[downloadId].triedStrategies = error.triedStrategies || [];
        activeDownloads[downloadId].logs.push(`Download failed: ${error.errorObj?.title || 'Unknown error'}`);

        // Cleanup after 1 hour
        setTimeout(() => delete activeDownloads[downloadId], 3600000);
    });
});

// Check Download Status
app.get('/api/youtube/download/:id', (req, res) => {
    const status = activeDownloads[req.params.id];
    if (!status) return res.status(404).json({ error: "Download job not found" });
    res.json(status);
});

// Tool B: Gemini Viral Moment Generator
// List available AI models
app.get('/api/models', (req, res) => {
    res.json(modelRouter.getAvailableModels());
});

app.post('/api/analyze', licenseCheck, async (req, res) => {
    const { url, instruction, mode, advanced, transcript, model = 'gemini', language } = req.body;

    // Get API key from header based on model
    const headerKeyMap = {
        'gemini': 'x-gemini-key',
        'gpt-4o': 'x-openai-key',
        'claude': 'x-anthropic-key',
        'groq': 'x-groq-key',
        'mistral': 'x-mistral-key',
        'deepseek': 'x-deepseek-key'
    };
    const headerKey = headerKeyMap[model] || 'x-gemini-key';
    let apiKey = req.headers[headerKey] || req.headers['x-gemini-key']; // Fallback for backwards compat
    let usingFreeKey = false;

    if (!url) return res.status(400).json({ error: "YouTube URL is required" });

    // Free tier: if no user key provided, try the shared free key
    if (!apiKey || apiKey === 'your_key_here') {
        const freeKey = getFreeApiKey();
        if (freeKey && checkAndConsumeFreeTier()) {
            apiKey = freeKey;
            usingFreeKey = true;
        } else if (freeKey) {
            return res.status(429).json({
                error: `Free daily limit of ${FREE_DAILY_LIMIT} uses reached. Add your own API key in Settings to continue.`,
                limitReached: true,
                remaining: 0
            });
        } else {
            return res.status(400).json({ error: `API Key for ${model} is missing. Please provide it in Settings.` });
        }
    }

    try {
        // Fetch video metadata
        const metadata = await ytdlpJson(url);

        const videoContext = {
            title: metadata.title,
            channel: metadata.uploader,
            duration: metadata.duration_string,
            description: metadata.description?.substring(0, 500)
        };

        // Build the prompt (shared across all models)
        let promptMain = "";
        if (mode === 'advanced' && advanced) {
            const minDuration = Math.floor(advanced.maxDuration * 0.6); // 60% of max as minimum
            promptMain = `
      [ADVANCED MODE CONSTRAINTS]
      - Target Focus: ${advanced.focus}
      - Energy & Vibe: ${advanced.vibe}
      - Rule 1: Each clip's TOTAL duration (sum of all timelines) should be between ${minDuration} and ${advanced.maxDuration} seconds.
      - Rule 2: Prefer LONGER clips closer to ${advanced.maxDuration} seconds. SHORT clips under ${minDuration}s are NOT acceptable.
      - Rule 3: You may use multiple timeline segments to build up the target duration.
      - Rule 4: Maintain the ${advanced.vibe} tone throughout the selection.
      `;
        } else {
            promptMain = `
      [AUTO MODE MISSION]
      Instruction: ${instruction || "Identify the most viral-worthy, high-engagement moments for social media shorts/reels."}
      Analyze the video naturally and find the best highlights regardless of length or cut count.
      `;
        }

        const prompt = `
      [SYSTEM ROLE]
      You are a professional Video Editor and Viral Strategist.
      You analyze YouTube transcripts to identify the most engaging segments.
      
      [CORE OBJECTIVE]
      maximize_yield: true
      Identify AS MANY high-potential viral clips as possible. Do not limit yourself to a "top 5" or "top 10". 
      If a segment is good, include it. The user wants choices.

      ${promptMain}

      [TECHNICAL DEFINITIONS]
      - A "video_clip" represents 1 Topic/Viral Moment.
      - A "timeline" object inside "timelines" is a single continuous "cut".
      - "total_duration_seconds" is the SUM of all durations in that clip's "timelines".

      [VIDEO CONTEXT]
      - Title: ${videoContext.title}
      - Channel: ${videoContext.channel}
      - Duration: ${videoContext.duration}
      - URL: ${url}
      ${language && language !== 'unknown'
          ? `- Content Language: ${language}\n      - IMPORTANT: The transcript is in ${language}. Generate "topic", "highlight", and "description" fields in ${language}.`
          : `- Content Language: UNKNOWN — detect from transcript and title.\n      - IMPORTANT: Detect the spoken language from the transcript. Generate "topic", "highlight", and "description" fields in the DETECTED language, NOT English.`}
      ${transcript ? `- FULL TRANSCRIPT:\n"${transcript.substring(0, 500000)}..."` : '- TRANSCRIPT: Not provided. Rely on metadata and title.'}

      [ANALYSIS STRATEGY — PRIORITY ORDER]
      1. **ACCURATE TIMESTAMPS** (MOST IMPORTANT): Every timeline start/end MUST be precise to the second. Verify against the transcript. Wrong timestamps = useless clips.
      2. **Sentence Bundling**: NEVER start or end a clip mid-sentence. Always buffer to capture the complete thought.
      3. **Audio Cues**: Prioritize moments with [laughter], [applause], [cheering], or high-energy interactions.
      4. **Chain of Thought**: Provide a "reasoning" field explaining WHY this part is viral-worthy.
      5. **Language Detection**: Detect spoken language per clip as ISO 639-1 code (e.g., "en", "id", "es"). Write "topic"/"highlight"/"description" in that language.
      6. **Negative Constraints**: EXCLUDE intro music, "Like and Subscribe" pleas, sponsorship segments, long silences.

      [OPTIONAL ENRICHMENT — include if possible, but do NOT sacrifice timestamp accuracy for these]
      7. **Hashtags**: Suggest hashtags per clip in 4 tiers: mega (1M+), macro (100K-1M), micro (10K-100K), nano (<10K). 2-4 per tier.
      8. **Face Positions** (estimate from context): Return "face_positions" with "speaker_count" and "speakers" array. Each speaker: "x_pct" (0-100), "y_pct" (0-100), "label". For interviews estimate left/right (25%/75%). For single speaker use center (50%, 40%).

      [OUTPUT FORMAT]
      Respond ONLY with a VALID JSON object.
      Do NOT use Markdown formatting (no \`\`\`json blocks).
      Do NOT include comments. 
      Format example:
{
    "source_info": { "video_title": "${videoContext.title.replace(/"/g, '\\"')}", "youtube_url": "${url}" },
    "video_clips": [
        {
            "clip_id": 1,
            "topic": "[Topic — in detected language, e.g. Indonesian if video is Indonesian]",
            "highlight": "[Short viral hook — in detected language]",
            "description": "[Brief description — in detected language]",
            "language": "id",
            "reasoning": "Chain of thought: Found [laughter] here and the joke setup started at...",
            "hashtags": {
                "mega": ["#viral", "#trending"],
                "macro": ["#podcast", "#interview"],
                "micro": ["#businesstips", "#startuplife"],
                "nano": ["#elonmuskinterview", "#specificniche"]
            },
            "face_positions": {
                "speaker_count": 2,
                "speakers": [
                    { "x_pct": 25, "y_pct": 40, "label": "left speaker" },
                    { "x_pct": 75, "y_pct": 45, "label": "right speaker" }
                ]
            },
            "total_duration_seconds": 30,
            "timelines": [
                { "start": "HH:MM:SS", "end": "HH:MM:SS", "duration": 10 }
            ]
        }
    ]
}

[STRICT RULES]
1. Timestamps MUST be in HH:MM:SS format (e.g., 00:01:30).
2. The "topic", "highlight", and "description" MUST be written in the detected spoken language of that clip. If the video is Indonesian, write in Indonesian. NEVER default to English.
3. Seconds (SS) and Minutes (MM) must NEVER exceed 59.
4. Sum of timeline durations must equal total_duration_seconds.
5. No individual "timeline" duration can exceed the user's requested limit if in Advanced mode.
6. Do not hallucinate. Use only the context of ${videoContext.title}.
7. The "language" field MUST be a valid ISO 639-1 code (2 letters).
`;

        console.log(`[ANALYZE] Using model: ${model}`);

        // Get model variant (Gemini or Others)
        // Frontend now sends 'x-model-variant' for generic variant selection OR 'x-gemini-variant'
        const rawVariant = req.headers['x-model-variant'] || req.headers[`x-${model}-variant`] || req.headers['x-gemini-variant'];

        // Sanitize: treat empty string as null so adapters use their defaults
        const specificVariant = rawVariant && rawVariant.trim() ? rawVariant.trim() : null;

        if (specificVariant) {
            console.log(`[ANALYZE] Using variant: ${specificVariant}`);
        } else {
            console.log(`[ANALYZE] Using default variant for ${model}`);
        }

        // Route to appropriate model adapter
        // YouTube URL passed for reference (not used as fileData — see gemini.js comment)
        const jsonData = await modelRouter.analyze(model, apiKey, prompt, specificVariant, url);

        // Validate Schema Basics
        if (!jsonData.video_clips || !Array.isArray(jsonData.video_clips)) {
            throw new Error("Invalid Schema: Missing 'video_clips' array");
        }

        // Validate and fix clip durations — prevents timeline mismatch in frontend
        for (const clip of jsonData.video_clips) {
            if (!clip.timelines || !Array.isArray(clip.timelines)) continue;
            let computedTotal = 0;
            for (const tl of clip.timelines) {
                const startSec = parseTime(tl.start);
                const endSec = parseTime(tl.end);
                const realDuration = endSec - startSec;
                if (realDuration > 0) {
                    tl.duration = Math.round(realDuration);
                    computedTotal += realDuration;
                } else if (tl.duration > 0) {
                    computedTotal += tl.duration;
                }
            }
            if (computedTotal > 0) {
                clip.total_duration_seconds = Math.round(computedTotal);
            }
        }

        res.json(jsonData);
    } catch (error) {
        console.error(`[${model.toUpperCase()}] Analysis Error:`, error.message);
        const friendlyError = parseAIError(error, model);
        res.status(500).json({
            error: friendlyError,
            model: model,
            technical: error.message // Keep technical details for debugging
        });
    }
});

// Tool C: Backend Video Processing
// --- JOB STORE (In-Memory for simplicity, syncs to DB on completion) ---
const activeJobs = {}; // { jobId: { status, progress, clips: [] } }

app.post('/api/video/process', licenseCheck, async (req, res) => {
    let { videoPath, config, outputFormat, outputResolution, useTransitions, turboMode, styleSettings } = req.body;
    outputResolution = outputResolution || '720p'; // Default to 720p

    // Free version: enforce 16:9 formats only
    const allowed16x9Formats = ['raw-cuts', 'face-track-zoom-landscape', 'landscape-blur', 'landscape-blur-motion', 'letterbox'];
    if (!allowed16x9Formats.includes(outputFormat)) {
        outputFormat = 'raw-cuts';
    }

    // Free version: force-disable subtitle and hook
    if (styleSettings) {
        styleSettings.subtitleEnabled = false;
        styleSettings.hookEnabled = false;
    }

    const dims = getResolutionDimensions(outputResolution, outputFormat);
    console.log(`[DEBUG] Received process request: Format = ${outputFormat} Resolution = ${outputResolution} (${dims.w}x${dims.h}) Turbo = ${turboMode} Path = ${videoPath} StyleSettings = ${styleSettings ? 'yes' : 'no'}`);

    if (!videoPath || !config) {
        console.error("[DEBUG] Missing videoPath or config");
        return res.status(400).json({ error: "Missing videoPath" });
    }

    // Resolve video path — portable: always resolve relative to app root
    const appRoot = path.resolve(__dirname, '..');
    const { resolved: resolvedVideoPath, error: pathError } = resolveMediaPath(appRoot, videoPath);
    if (pathError) {
        console.error(`[PATH-FIX] ${pathError}: ${videoPath}`);
        return res.status(404).json({ error: pathError });
    }
    videoPath = resolvedVideoPath;

    if (!config.video_clips || !Array.isArray(config.video_clips)) {
        console.error("[DEBUG] Invalid config: video_clips is missing or not an array");
        return res.status(400).json({ error: "Invalid config schema: video_clips array required" });
    }

    const jobId = `job_${Date.now()}`;
    const relativeVideoPath = path.isAbsolute(videoPath)
        ? path.relative(path.join(__dirname, '..'), videoPath)
        : videoPath;

    // Initialize Job
    activeJobs[jobId] = {
        id: jobId,
        status: 'processing',
        totalClips: config.video_clips.length,
        completedClips: [],
        timestamp: new Date().toISOString()
    };

    // --- IMMEDIATE PERSISTENCE (Phase 1) ---
    // Save to DB as 'pending' so it shows up in "My Files" immediately
    const projectRecord = {
        id: jobId,
        timestamp: new Date().toISOString(),
        promptConfig: config,
        sourceVideo: relativeVideoPath,
        clips: [],
        status: 'processing'
    };

    try {
        const history = readDb();
        history.unshift(projectRecord);
        writeDb(history);
        console.log(`[DB] Project ${jobId} initialized in database.`);
    } catch (dbError) {
        console.error(`[ERROR] Failed to initialize project in database: `, dbError.message);
    }

    // Return Job ID immediately (Non-blocking)
    res.json({ jobId, message: "Job started", totalClips: config.video_clips.length });

    // BACKGROUND PROCESSING (Fire & Forget)
    (async () => {
        try {
            // ============================================================
            // CROSS-PLATFORM HARDWARE ACCELERATION
            // ============================================================
            // Priority order for hardware encoders:
            // Mac: h264_videotoolbox
            // Windows/Linux: h264_nvenc (NVIDIA) > h264_qsv (Intel) > h264_amf (AMD) > libx264 (fallback)

            const detectHardwareEncoder = async () => {
                const os = require('os');
                const platform = os.platform();

                // Mac: Always use VideoToolbox
                if (platform === 'darwin') {
                    console.log('[HW_ACCEL] Mac detected → Using h264_videotoolbox');
                    return 'h264_videotoolbox';
                }

                // Windows/Linux: Probe for available encoders
                const encodersToTry = [
                    { name: 'h264_nvenc', label: 'NVIDIA NVENC' },
                    { name: 'h264_qsv', label: 'Intel Quick Sync' },
                    { name: 'h264_amf', label: 'AMD AMF' }
                ];

                for (const encoder of encodersToTry) {
                    try {
                        await new Promise((resolve, reject) => {
                            const proc = spawn(ffmpegBinaryPath || 'ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
                            let output = '';
                            proc.stdout.on('data', d => output += d.toString());
                            proc.on('close', () => {
                                if (output.includes(encoder.name)) {
                                    resolve(true);
                                } else {
                                    reject(new Error('Not found'));
                                }
                            });
                            proc.on('error', reject);
                        });
                        console.log(`[HW_ACCEL] ${encoder.label} detected → Using ${encoder.name}`);
                        return encoder.name;
                    } catch {
                        // Continue to next encoder
                    }
                }

                console.log('[HW_ACCEL] No hardware encoder found → Using libx264 (CPU)');
                return null;
            };

            // Detect once at job start
            const hwEncoder = await detectHardwareEncoder();

            const getEncodingParams = (isTurbo) => {
                const commonFlags = ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
                const bitrate = getBitrate(outputResolution);  // Dynamic bitrate based on resolution

                if (!isTurbo || !hwEncoder) {
                    // Software fallback - use CRF for quality-based encoding
                    // Lower CRF = higher quality (18 is visually lossless, 24 is good balance)
                    const crf = outputResolution === '4k' ? '18' : outputResolution === '1440p' ? '20' : outputResolution === '1080p' ? '22' : '24';
                    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', crf, ...commonFlags];
                }

                // Hardware-specific params with dynamic bitrate
                switch (hwEncoder) {
                    case 'h264_videotoolbox':
                        return ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, ...commonFlags];
                    case 'h264_nvenc':
                        return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', bitrate, ...commonFlags];
                    case 'h264_qsv':
                        return ['-c:v', 'h264_qsv', '-preset', 'fast', '-b:v', bitrate, ...commonFlags];
                    case 'h264_amf':
                        return ['-c:v', 'h264_amf', '-quality', 'balanced', '-b:v', bitrate, ...commonFlags];
                    default:
                        return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', ...commonFlags];
                }
            };

            const runFFmpeg = (args) => {
                return new Promise((resolve, reject) => {
                    // Start process with stdin ignored to prevent interactive hangs
                    const proc = spawn(ffmpegBinaryPath || 'ffmpeg', ['-nostdin', '-hide_banner', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

                    let stderr = '';
                    // Drain stdout just in case (prevent buffer fill)
                    proc.stdout.on('data', () => { });

                    proc.stderr.on('data', d => stderr += d.toString());

                    proc.on('error', (err) => reject(new Error(`Spawn Error: ${err.message}`)));

                    proc.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Exit code ${code}. Stderr: ${stderr.slice(-500)}`));
                    });
                });
            };

            const processClip = async (clip) => {
                const safeTopic = (clip.topic || 'clip').toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 50);
                const clipsDir = path.join(clipsDirRoot, jobId);
                if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

                // --- RAW CUTS MODE (Phase 5) ---
                if (outputFormat === 'raw-cuts') {
                    const results = [];

                    // --- FIX: Sort timelines chronologically and sanitize ---
                    clip.timelines.sort((a, b) => parseTime(a.start) - parseTime(b.start));
                    clip.timelines = clip.timelines.filter(tl => {
                        const s = parseTime(tl.start);
                        const e = parseTime(tl.end);
                        if (s >= e) {
                            console.warn(`[RAW-CUTS] Skipping inverted timeline: start=${tl.start}(${s}s) >= end=${tl.end}(${e}s)`);
                            return false;
                        }
                        return true;
                    });

                    // --- CLIP-LEVEL BUFFER: Calculate clip boundaries first ---
                    let clipEarliestStart = Infinity;
                    let clipLatestEnd = 0;
                    for (const tl of clip.timelines) {
                        const s = parseTime(tl.start);
                        const e = parseTime(tl.end);
                        if (s < clipEarliestStart) clipEarliestStart = s;
                        if (e > clipLatestEnd) clipLatestEnd = e;
                    }
                    // Apply 3s buffer at CLIP level only
                    const bufferedClipStart = Math.max(0, clipEarliestStart - 3);
                    const bufferedClipEnd = clipLatestEnd + 3;

                    // Extract each timeline with buffer applied at clip boundaries
                    for (let i = 0; i < clip.timelines.length; i++) {
                        let { start, end } = clip.timelines[i];
                        let startSec = parseTime(start);
                        let endSec = parseTime(end);

                        // Apply clip-level buffer: first timeline gets start buffer, last gets end buffer
                        const isFirst = (i === 0);
                        const isLast = (i === clip.timelines.length - 1);

                        if (isFirst) startSec = bufferedClipStart;
                        if (isLast) endSec = bufferedClipEnd;

                        let durationSec = endSec - startSec;

                        // --- FIX: Guard against negative/zero duration ---
                        if (durationSec <= 0) {
                            console.warn(`[RAW-CUTS] Negative duration: seg ${i}: start=${startSec}s end=${endSec}s dur=${durationSec}s. Falling back to original timestamps.`);
                            startSec = parseTime(start);
                            endSec = parseTime(end);
                            durationSec = endSec - startSec;
                            if (durationSec <= 0) {
                                console.warn(`[RAW-CUTS] Original timestamps also inverted. Using 1s minimum.`);
                                durationSec = 1;
                            }
                        }

                        const duration = formatTime(durationSec);
                        const startStr = formatTime(startSec);

                        const partName = `${safeTopic}_part${i + 1}.mp4`;
                        const partPath = path.join(clipsDir, partName);

                        // FRAME-ACCURATE EXTRACTION (Re-encode for precision)
                        const args = [
                            '-y',
                            '-ss', formatTime(startSec),
                            '-i', videoPath,
                            '-t', duration,
                            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                            '-c:a', 'aac', '-b:a', '128k',
                            '-avoid_negative_ts', 'make_zero',
                            partPath
                        ];
                        await runFFmpeg(args);

                        const relativePath = path.relative(path.join(__dirname, '..'), partPath);
                        results.push({
                            id: `${clip.clip_id}_part${i + 1} `,
                            topic: `${clip.topic} (Part ${i + 1})`,
                            highlight: clip.highlight,
                            ...clip,
                            url: relativePath,
                            name: partName,
                            status: 'done'
                        });
                    }
                    return results; // Return multiple items
                }

                // --- STANDARD MODES (Re-encoding) - TWO-PHASE PIPELINE ---
                const outputClipName = `${safeTopic}.mp4`;
                const finalOutputPath = path.join(clipsDir, outputClipName);
                const segmentFiles = [];
                const tempRawClips = []; // Phase 1 temp files

                // Find VTT for subtitles if needed
                let vttPath = null;
                if (req.body.burnSubtitles) {
                    const baseName = path.basename(videoPath, path.extname(videoPath));
                    const dir = path.dirname(videoPath);
                    const potential = fs.readdirSync(dir).find(f => f.startsWith(baseName) && f.endsWith('.vtt'));
                    if (potential) vttPath = path.join(dir, potential);
                }

                // ============================================================
                // PHASE 1: RAPID EXTRACTION (Fast -c copy from long source)
                // ============================================================
                console.log(`[PHASE1] Extracting ${clip.timelines.length} raw segments for clip ${clip.clip_id}...`);

                // --- FIX: Sort timelines chronologically and sanitize ---
                // The AI may return timelines in arbitrary order. The buffer logic
                // assumes timelines[0] is earliest, so we must sort first.
                clip.timelines.sort((a, b) => parseTime(a.start) - parseTime(b.start));

                // Sanitize: skip timelines where start >= end (inverted from AI)
                clip.timelines = clip.timelines.filter(tl => {
                    const s = parseTime(tl.start);
                    const e = parseTime(tl.end);
                    if (s >= e) {
                        console.warn(`[PHASE1] Skipping inverted timeline: start=${tl.start}(${s}s) >= end=${tl.end}(${e}s)`);
                        return false;
                    }
                    return true;
                });

                if (clip.timelines.length === 0) {
                    console.error(`[PHASE1] All timelines invalid for clip ${clip.clip_id}, skipping.`);
                    return { id: clip.clip_id, topic: clip.topic, status: 'error', error: 'All timelines had invalid timestamps' };
                }

                // --- CLIP-LEVEL BUFFER: Calculate clip boundaries first ---
                let clipEarliestStart = Infinity;
                let clipLatestEnd = 0;
                for (const tl of clip.timelines) {
                    const s = parseTime(tl.start);
                    const e = parseTime(tl.end);
                    if (s < clipEarliestStart) clipEarliestStart = s;
                    if (e > clipLatestEnd) clipLatestEnd = e;
                }
                // Apply 3s buffer at CLIP level only
                const bufferedClipStart = Math.max(0, clipEarliestStart - 3);
                const bufferedClipEnd = clipLatestEnd + 3;

                // Extract each timeline with buffer applied at clip boundaries
                for (let i = 0; i < clip.timelines.length; i++) {
                    let { start, end } = clip.timelines[i];
                    let startSec = parseTime(start);
                    let endSec = parseTime(end);

                    // Apply clip-level buffer: first timeline gets start buffer, last gets end buffer
                    const isFirst = (i === 0);
                    const isLast = (i === clip.timelines.length - 1);

                    if (isFirst) startSec = bufferedClipStart;
                    if (isLast) endSec = bufferedClipEnd;

                    let durationSec = endSec - startSec;

                    // --- FIX: Guard against negative/zero duration ---
                    // Even after sorting, edge cases could still produce bad durations.
                    // Clamp to a minimum of 0.5s and log a warning.
                    if (durationSec <= 0) {
                        console.warn(`[PHASE1] Negative duration detected for clip ${clip.clip_id} seg ${i}: start=${startSec}s end=${endSec}s dur=${durationSec}s. Falling back to original timestamps.`);
                        // Fall back to original parsed timestamps without buffer override
                        startSec = parseTime(start);
                        endSec = parseTime(end);
                        durationSec = endSec - startSec;
                        // If still invalid, use a minimum duration
                        if (durationSec <= 0) {
                            console.warn(`[PHASE1] Original timestamps also inverted (start=${start} end=${end}). Using 1s minimum.`);
                            durationSec = 1;
                        }
                    }

                    const duration = formatTime(durationSec);
                    const startStr = formatTime(startSec);

                    const tempRawName = `temp_raw_${clip.clip_id}_${i}.mp4`;
                    const tempRawPath = path.join(clipsDir, tempRawName);
                    tempRawClips.push({ path: tempRawPath, duration: durationSec });

                    // FRAME-ACCURATE EXTRACTION (Re-encode for precision)
                    // Using input-seek + re-encode ensures frame-accurate start
                    // This fixes the 0-3s blur/black frame issue from keyframe misalignment
                    const extractArgs = [
                        '-y',
                        '-ss', formatTime(startSec),      // Input-seek (fast, keyframe-based)
                        '-i', videoPath,
                        '-t', duration,
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',  // Fast re-encode for accuracy
                        '-c:a', 'aac', '-b:a', '128k',
                        '-avoid_negative_ts', 'make_zero',
                        tempRawPath
                    ];
                    await runFFmpeg(extractArgs);
                }

                console.log(`[PHASE1] Extracted ${tempRawClips.length} raw clips with combined seeking.`);

                // ============================================================
                // PHASE 2: APPLY EFFECTS (To short clips, not 1hr source)
                // ============================================================
                console.log(`[PHASE2] Applying effects (${outputFormat}) to short clips...`);

                for (let i = 0; i < tempRawClips.length; i++) {
                    const tempClip = tempRawClips[i];
                    const segmentName = `seg_${clip.clip_id}_${i}.mp4`;
                    const segmentPath = path.join(clipsDir, segmentName);
                    segmentFiles.push(segmentPath);

                    let filterGraph = '';
                    let inputArgs = ['-y', '-i', tempClip.path];

                    // --- OUTPUT FORMAT FILTERS (Dynamic Resolution) ---
                    // dims = { w, h } based on outputResolution and outputFormat
                    const W = dims.w;
                    const H = dims.h;
                    const halfH = Math.floor(H / 2); // For dual-stack
                    const sqSize = Math.min(W, H); // Square size for portrait-square

                    if (outputFormat === 'stacked-blur' || outputFormat === 'landscape-blur') {
                        // 9:16 with STATIC Blurred Background (Fast - single frame blur)
                        console.log(`[PHASE2] Processing Stacked Blur STATIC (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        const bgImagePath = path.join(clipsDir, `bg_${clip.clip_id}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (outputFormat === 'stacked-blur-motion' || outputFormat === 'landscape-blur-motion') {
                        // 9:16 with DYNAMIC Blurred Background (Motion - blur follows video)
                        console.log(`[PHASE2] Processing Stacked Blur MOTION (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        inputArgs = ['-y', '-i', tempClip.path];
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15[bg];` +
                            `[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (outputFormat === 'portrait-square') {
                        // 9:16 with centered 1:1 square video + STATIC blurred background
                        console.log(`[PHASE2] Processing Portrait Square STATIC (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        const bgImagePath = path.join(clipsDir, `bg_ps_${clip.clip_id}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:18`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${sqSize}:${sqSize}:force_original_aspect_ratio=increase,crop=${sqSize}:${sqSize}[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (outputFormat === 'portrait-square-motion') {
                        // 9:16 with centered 1:1 square video + DYNAMIC blurred background
                        console.log(`[PHASE2] Processing Portrait Square MOTION (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        inputArgs = ['-y', '-i', tempClip.path];
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:18[bg];` +
                            `[fg_src]scale=${sqSize}:${sqSize}:force_original_aspect_ratio=increase,crop=${sqSize}:${sqSize}[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (outputFormat === 'square-blur') {
                        // 1:1 with STATIC Blurred Background
                        console.log(`[PHASE2] Processing Square Blur STATIC (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        const bgImagePath = path.join(clipsDir, `bg_sq_${clip.clip_id}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (outputFormat === 'square-blur-motion') {
                        // 1:1 with DYNAMIC Blurred Background
                        console.log(`[PHASE2] Processing Square Blur MOTION (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        inputArgs = ['-y', '-i', tempClip.path];
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15[bg];` +
                            `[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (outputFormat === 'zoomed-nine-sixteen' || outputFormat === 'center-crop') {
                        // 9:16 Center Crop (Zoomed POV)
                        console.log(`[PHASE2] Processing Center Crop (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                    } else if (outputFormat === 'square-zoom') {
                        // 1:1 Center Crop (No Blur)
                        console.log(`[PHASE2] Processing Square Zoom (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                    } else if (outputFormat === 'ig-post-blur' || outputFormat === 'ig-post' || outputFormat === 'portrait-3-4') {
                        // 3:4 Instagram Post with STATIC Blurred Background
                        console.log(`[PHASE2] Processing IG Post 3:4 STATIC (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        const bgImagePath = path.join(clipsDir, `bg_ig_${clip.clip_id}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (outputFormat === 'ig-post-blur-motion' || outputFormat === 'ig-post-motion' || outputFormat === 'portrait-3-4-motion') {
                        // 3:4 Instagram Post with DYNAMIC Blurred Background
                        console.log(`[PHASE2] Processing IG Post 3:4 MOTION (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        inputArgs = ['-y', '-i', tempClip.path];
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15[bg];` +
                            `[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (outputFormat === 'ig-post-crop' || outputFormat === 'portrait-3-4-crop') {
                        // 3:4 Instagram Post Center Crop (No Blur)
                        console.log(`[PHASE2] Processing IG Post Crop 3:4 (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                    } else if (outputFormat === 'letterbox') {
                        filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2[v_base]`;
                    } else if (outputFormat === 'split-speaker') {
                        // 9:16 Split Speaker: Left half on top, Right half on bottom (for interviews/podcasts)
                        console.log(`[PHASE2] Processing Split Speaker L→R (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        // Crop left half of source, scale to top half; Crop right half, scale to bottom half
                        filterGraph = `[0:v]crop=iw/2:ih:0:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:iw/2:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                    } else if (outputFormat === 'split-speaker-inv') {
                        // 9:16 Split Speaker Inverted: Right half on top, Left half on bottom
                        console.log(`[PHASE2] Processing Split Speaker R→L (${W}x${H}) for Clip ${clip.clip_id} segment ${i}`);
                        // Crop right half of source, scale to top half; Crop left half, scale to bottom half
                        filterGraph = `[0:v]crop=iw/2:ih:iw/2:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:0:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                    } else if (outputFormat === 'split-face-track') {
                        // Face-tracking split: crop centered on each speaker's face position
                        const fp = clip.face_positions;
                        if (fp && fp.speakers && fp.speakers.length >= 2) {
                            const sp1 = fp.speakers[0];
                            const sp2 = fp.speakers[1];
                            // Clamp x_pct to safe crop range (25-75) to avoid out-of-bounds
                            const x1 = Math.max(25, Math.min(75, sp1.x_pct || 25));
                            const x2 = Math.max(25, Math.min(75, sp2.x_pct || 75));
                            console.log(`[PHASE2] Processing Split Face-Track (${W}x${H}) for Clip ${clip.clip_id} segment ${i} — faces at ${x1}%, ${x2}%`);
                            filterGraph = `[0:v]crop=iw/2:ih:iw*${(x1 / 100) - 0.25}:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:iw*${(x2 / 100) - 0.25}:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                        } else {
                            // Fallback to standard L/R split if no face data
                            console.log(`[PHASE2] Split Face-Track fallback to L→R (no face data) for Clip ${clip.clip_id} segment ${i}`);
                            filterGraph = `[0:v]crop=iw/2:ih:0:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:iw/2:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                        }
                    } else if (outputFormat === 'face-track-zoom' || outputFormat === 'face-track-zoom-3-4' || outputFormat === 'face-track-zoom-square' || outputFormat === 'face-track-zoom-landscape') {
                        // Face-tracking zoom: center-crop on primary speaker's face position
                        const fp = clip.face_positions;
                        const primarySpeaker = fp?.speakers?.[0];
                        if (primarySpeaker) {
                            const xPct = Math.max(10, Math.min(90, primarySpeaker.x_pct || 50));
                            const yPct = Math.max(10, Math.min(90, primarySpeaker.y_pct || 40));
                            console.log(`[PHASE2] Processing Face-Track Zoom (${W}x${H}) for Clip ${clip.clip_id} segment ${i} — face at ${xPct}%, ${yPct}%`);
                            // Scale up to fill, then crop centered on face position
                            filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:iw*${xPct / 100}-${W / 2}:ih*${yPct / 100}-${H / 2}[v_base]`;
                        } else {
                            // Fallback to center crop if no face data
                            console.log(`[PHASE2] Face-Track Zoom fallback to center crop (no face data) for Clip ${clip.clip_id} segment ${i}`);
                            filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                        }
                    } else {
                        // Default passthrough (raw-cuts)
                        filterGraph = `null[v_base]`;
                    }

                    // --- OVERLAYS: CAPTIONS & SUBTITLES ---
                    let lastLink = '[v_base]';

                    // 0. Hook Overlay (Brand + Headline + Subtitle) - ENHANCED with per-element customization + multi-line text wrapping
                    if (styleSettings && styleSettings.hookEnabled) {
                        // Helper to convert hex to FFmpeg color format
                        const toFFmpegColor = (hex) => (hex || '#04FF00').replace('#', '0x');

                        // Calculate max text width (video width minus padding on both sides)
                        const textPadding = 80; // 40px padding on each side
                        const maxTextWidth = W - textPadding;

                        // Alignment-based X position
                        const alignment = styleSettings.hookAlignment || 'left';
                        let xPos;
                        if (alignment === 'left') xPos = '40';
                        else if (alignment === 'center') xPos = '(w-text_w)/2';
                        else xPos = 'w-text_w-40'; // right

                        // Dynamic Y position (0-100% from top, default 80% = near bottom)
                        const verticalPct = styleSettings.hookVerticalPosition || 80;
                        const baseY = `h*${verticalPct / 100}`;

                        // Enhanced stroke settings for OpusClip-like impact
                        const strokeEnabled = styleSettings.hookStroke !== false; // default true
                        const shadowEnabled = styleSettings.hookShadowEnabled !== false; // default true
                        const strokeColor = toFFmpegColor(styleSettings.hookStrokeColor || '#000000');
                        const shadowPart = shadowEnabled ? ':shadowcolor=black@0.5:shadowx=4:shadowy=4' : '';
                        const strokeParams = strokeEnabled
                            ? `:borderw=5:bordercolor=${strokeColor}${shadowPart}`
                            : shadowPart;

                        // Track Y offset for stacking elements and filter counter
                        let currentYOffset = 0;
                        let hookFilterIdx = 0;

                        // Helper to escape text for FFmpeg drawtext filter
                        const escapeForFFmpegDrawtext = (text) => {
                            // FFmpeg drawtext filter special characters that need escaping
                            return text
                                .replace(/\\/g, '\\\\')       // backslash first
                                .replace(/:/g, '\\:')         // colon (parameter separator)
                                .replace(/'/g, "\\'")         // single quote
                                .replace(/\[/g, '\\[')        // bracket
                                .replace(/\]/g, '\\]')        // bracket
                                .replace(/,/g, '\\,')         // comma (argument separator)
                                .replace(/;/g, '\\;');        // semicolon (filter separator)
                        };

                        // Helper to add a single line drawtext filter
                        const addDrawtextLine = (text, color, fontSize, yOffset, alpha = 1) => {
                            const safeText = escapeForFFmpegDrawtext(text);
                            const alphaStr = alpha < 1 ? `@${alpha}` : '';
                            filterGraph += `;${lastLink}drawtext=text='${safeText}':fontcolor=${color}${alphaStr}:fontsize=${fontSize}:x=${xPos}:y=${baseY}+${yOffset}${strokeParams}[v_hook${hookFilterIdx}]`;
                            lastLink = `[v_hook${hookFilterIdx}]`;
                            hookFilterIdx++;
                        };

                        // Brand name (medium, top of hook) - max 2 lines
                        const hookBrand = styleSettings.hookBrand || {};
                        if (hookBrand.text) {
                            const baseFontSize = 28;
                            const wrapped = wrapTextForDrawtext(hookBrand.text, baseFontSize, maxTextWidth, 2);
                            const brandColor = toFFmpegColor(hookBrand.color);
                            const lineHeight = Math.ceil(wrapped.fontSize * 1.2);

                            // Render each line as separate drawtext
                            wrapped.lines.forEach((line, idx) => {
                                addDrawtextLine(line, brandColor, wrapped.fontSize, currentYOffset + (idx * lineHeight));
                            });
                            currentYOffset += (lineHeight * wrapped.lineCount) + 10;
                        }

                        // Headline (LARGE, main text) - Most important, max 3 lines
                        const hookHeadline = styleSettings.hookHeadline || {};
                        if (hookHeadline.text) {
                            const headlineText = styleSettings.hookUppercase ? hookHeadline.text.toUpperCase() : hookHeadline.text;
                            const baseFontSize = 72;
                            const wrapped = wrapTextForDrawtext(headlineText, baseFontSize, maxTextWidth, 3);
                            const headlineColor = toFFmpegColor(hookHeadline.color);
                            const lineHeight = Math.ceil(wrapped.fontSize * 1.15);

                            // Render each line as separate drawtext
                            wrapped.lines.forEach((line, idx) => {
                                addDrawtextLine(line, headlineColor, wrapped.fontSize, currentYOffset + (idx * lineHeight));
                            });
                            currentYOffset += (lineHeight * wrapped.lineCount) + 15;
                        }

                        // Subtitle (medium, below headline) - max 2 lines
                        const hookSubtitle = styleSettings.hookSubtitle || {};
                        if (hookSubtitle.text) {
                            const baseFontSize = 32;
                            const wrapped = wrapTextForDrawtext(hookSubtitle.text, baseFontSize, maxTextWidth, 2);
                            const subtitleColor = toFFmpegColor(hookSubtitle.color);
                            const lineHeight = Math.ceil(wrapped.fontSize * 1.2);

                            // Render each line as separate drawtext with slight transparency
                            wrapped.lines.forEach((line, idx) => {
                                addDrawtextLine(line, subtitleColor, wrapped.fontSize, currentYOffset + (idx * lineHeight), 0.9);
                            });
                        }

                        console.log(`[HOOK] Rendering hook overlay: Brand="${hookBrand.text}" Headline="${hookHeadline.text}" Align=${alignment} Y=${verticalPct}% Stroke=${strokeEnabled} MaxWidth=${maxTextWidth}px Filters=${hookFilterIdx}`);
                    }

                    // 1. Video Title Caption (Drawtext) - Legacy support
                    if (req.body.captionText) {
                        const text = req.body.captionText.replace(/:/g, '\\:').replace(/'/g, '');
                        const style = req.body.captionStyle || 'simple';
                        let drawtext = '';
                        let yPos = '50';
                        if (outputFormat === 'stacked-blur') {
                            yPos = '(h/2)-(w*9/32)-text_h-20';
                        }

                        if (style === 'yellow-bold') {
                            drawtext = `drawtext=text='${text}':fontcolor=yellow:fontsize=48:x=(w-text_w)/2:y=${yPos}:box=1:boxcolor=black@0.6:boxborderw=10`;
                        } else if (style === 'minimal-white') {
                            drawtext = `drawtext=text='${text}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=${yPos}:shadowcolor=black:shadowx=2:shadowy=2`;
                        } else {
                            drawtext = `drawtext=text='${text}':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=${yPos}:box=1:boxcolor=black@0.5`;
                        }

                        filterGraph += `;${lastLink}${drawtext}[v_text]`;
                        lastLink = '[v_text]';
                    }

                    // 2. Lyrics / Subtitles (Burn VTT)
                    if (req.body.burnSubtitles && vttPath) {
                        const subStyle = req.body.subtitleStyle || 'default';
                        const safeVtt = vttPath.replace(/\\/g, '/').replace(/:/g, '\\:');

                        let forceStyle = '';
                        if (subStyle === 'karaoke-yellow') {
                            forceStyle = ":force_style='Fontname=Arial,PrimaryColour=&H00FFFF00,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1,Alignment=2,MarginV=20'";
                        } else if (subStyle === 'modern-clean') {
                            forceStyle = ":force_style='Fontname=Roboto,PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=1,Shadow=0,Alignment=2,MarginV=30'";
                        }

                        filterGraph += `;${lastLink}subtitles=${safeVtt}${forceStyle}[v_subs]`;
                        lastLink = '[v_subs]';
                    }

                    // Final map to [v]
                    filterGraph += `;${lastLink}null[v]`;

                    // Construct FFmpeg Command for PHASE 2 (no seeking needed - processing whole short clip)
                    const baseArgs = [...inputArgs, '-filter_complex', filterGraph, '-map', '[v]', '-map', '0:a?'];
                    const outputArgs = ['-c:a', 'aac', '-b:a', '128k', segmentPath];

                    try {
                        const params = getEncodingParams(turboMode);
                        await runFFmpeg([...baseArgs, ...params, ...outputArgs]);
                    } catch (err) {
                        if (turboMode) {
                            console.warn(`[WARN] Clip ${clip.clip_id}:${i} failed with Turbo. Retrying...`);
                            const softwareParams = getEncodingParams(false);
                            await runFFmpeg([...baseArgs, ...softwareParams, ...outputArgs]);
                        } else {
                            throw err;
                        }
                    }
                }

                // ============================================================
                // CLEANUP PHASE 1 TEMP FILES
                // ============================================================
                console.log(`[CLEANUP] Removing ${tempRawClips.length} temp raw clips...`);
                tempRawClips.forEach(t => { if (fs.existsSync(t.path)) fs.unlinkSync(t.path); });

                if (segmentFiles.length > 1) {
                    const listPath = path.join(clipsDir, `list_${clip.clip_id}.txt`);
                    // FFmpeg concat requires forward slashes on all platforms
                    const listContent = segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
                    fs.writeFileSync(listPath, listContent);
                    const mergeArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalOutputPath];
                    await new Promise((resolve, reject) => {
                        const proc = spawn(ffmpegBinaryPath || 'ffmpeg', mergeArgs);
                        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg merge failed with code ${code} `)));
                    });
                    fs.unlinkSync(listPath);
                } else {
                    fs.renameSync(segmentFiles[0], finalOutputPath);
                }
                segmentFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

                const relativePath = path.relative(path.join(__dirname, '..'), finalOutputPath);
                return [{
                    id: clip.clip_id,
                    topic: clip.topic,
                    highlight: clip.highlight,
                    ...clip,
                    url: relativePath,
                    name: outputClipName,
                    status: 'done'
                }];
            };

            const CONCURRENCY_LIMIT = 2;
            const clipChunks = [];
            for (let i = 0; i < config.video_clips.length; i += CONCURRENCY_LIMIT) {
                clipChunks.push(config.video_clips.slice(i, i + CONCURRENCY_LIMIT));
            }

            // Sequential processing for better reliability and progress tracking
            for (const clip of config.video_clips) {
                try {
                    const results = await processClip(clip);
                    if (activeJobs[jobId]) {
                        activeJobs[jobId].completedClips.push(...results);

                        // --- PER-CLIP SYNC (Phase 2) ---
                        // Update DB after each successful clip
                        try {
                            const history = readDb();
                            const idx = history.findIndex(p => p.id === jobId);
                            if (idx !== -1) {
                                history[idx].clips = activeJobs[jobId].completedClips;
                                writeDb(history);
                                console.log(`[DB] Project ${jobId} updated sync(Clips: ${history[idx].clips.length} / ${config.video_clips.length})`);
                            }
                        } catch (dbError) {
                            console.warn(`[WARN] Failed to sync clip ${clip.clip_id} to DB: `, dbError.message);
                        }
                    }
                } catch (clipError) {
                    console.error(`[ERROR] Failed to process clip ${clip.clip_id}: `, clipError.message);
                    if (activeJobs[jobId]) {
                        if (!activeJobs[jobId].errors) activeJobs[jobId].errors = [];
                        // Use friendly error message based on error type
                        let friendlyError;
                        if (clipError.message.includes('Exit code') || clipError.message.includes('ffmpeg')) {
                            friendlyError = parseFFmpegError(clipError.message, 1);
                        } else if (clipError.code) {
                            friendlyError = parseFileError(clipError);
                        } else {
                            friendlyError = `Clip ${clip.clip_id} processing failed: ${clipError.message}`;
                        }
                        activeJobs[jobId].errors.push(`Clip ${clip.clip_id}: ${friendlyError}`);
                    }
                }
            }

            // --- JOB COMPLETE: FINAL STATUS UPDATE ---
            if (activeJobs[jobId]) {
                activeJobs[jobId].status = 'completed';
                try {
                    const history = readDb();
                    const idx = history.findIndex(p => p.id === jobId);
                    if (idx !== -1) {
                        history[idx].status = 'completed';
                        history[idx].status = 'completed';
                        history[idx].clips = activeJobs[jobId].completedClips;
                        if (activeJobs[jobId].errors) history[idx].errors = activeJobs[jobId].errors;
                        writeDb(history);
                    }
                } catch (dbError) {
                    console.error(`[ERROR] Final DB update failed: `, dbError.message);
                }
                setTimeout(() => delete activeJobs[jobId], 3600000);
            }

        } catch (error) {
            console.error("Async Processing Error:", error);
            if (activeJobs[jobId]) {
                activeJobs[jobId].status = 'failed';
                // Add friendly error message
                let friendlyError;
                if (error.message?.includes('ffmpeg') || error.message?.includes('Exit code')) {
                    friendlyError = parseFFmpegError(error.message, 1);
                } else if (error.code) {
                    friendlyError = parseFileError(error);
                } else {
                    friendlyError = `Video processing failed: ${error.message}. Please try again or use a different video.`;
                }
                activeJobs[jobId].error = friendlyError;

                // Update DB with error
                try {
                    const history = readDb();
                    const idx = history.findIndex(p => p.id === jobId);
                    if (idx !== -1) {
                        history[idx].status = 'failed';
                        history[idx].error = friendlyError;
                        writeDb(history);
                    }
                } catch (dbErr) {
                    console.error('Failed to update DB with error:', dbErr.message);
                }
            }
        }
    })();
});

// GET Job Status Endpoint (Phase 3)
app.get('/api/job/:id', (req, res) => {
    const job = activeJobs[req.params.id];
    if (job) {
        res.json(job);
    } else {
        // Fallback: Check if it exists in DB (completed)
        const history = readDb();
        const found = history.find(p => p.id === req.params.id);
        if (found) {
            res.json({ id: found.id, status: 'completed', completedClips: found.clips, totalClips: found.clips.length });
        } else {
            res.status(404).json({ error: "Job not found" });
        }
    }
});

// GET History Endpoint (Phase 2)
app.get('/api/history', (req, res) => {
    res.json(readDb());
});

// Test Gemini API Key
app.post('/api/test-key', async (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: "Key required" });
    try {
        const dynamicGenAI = new GoogleGenerativeAI(apiKey);
        const model = dynamicGenAI.getGenerativeModel({ model: "gemini-flash-latest" });
        const result = await model.generateContent("Respond with 'OK'");
        const response = await result.response;
        res.json({ status: "ok", message: response.text() });
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
});

// Get supported Gemini variants (static list)
app.get('/api/gemini/variants', (req, res) => {
    const gemini = require('./models/gemini');
    res.json({ variants: gemini.getVariants(), default: gemini.DEFAULT_MODEL });
});

// Fetch user's accessible Gemini models via API key validation
app.get('/api/gemini/models', async (req, res) => {
    const apiKey = req.headers['x-gemini-key'];
    if (!apiKey) return res.status(400).json({ error: "API key required in x-gemini-key header" });

    try {
        // Fetch available models from Gemini API
        const response = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );

        const gemini = require('./models/gemini');

        // Extract model names and dynamic discovery
        const apiModels = response.data.models || [];
        const accessibleModels = [];

        // 1. Process API models (Dynamic)
        apiModels.forEach(model => {
            // Filter only generation models
            if (!model.supportedGenerationMethods?.includes('generateContent')) return;

            const id = model.name.replace('models/', '');

            // Determine tier/recommended based on ID patterns
            let tier = 'free'; // Default assumption
            if (id.includes('pro') || id.includes('ultra')) tier = 'paid'; // Rough heuristic

            // Check if it's in our known list for extra metadata
            const knownVariant = gemini.GEMINI_VARIANTS[id];

            accessibleModels.push({
                id: id,
                displayName: model.displayName || knownVariant?.displayName || id,
                tier: knownVariant?.tier || tier,
                recommended: knownVariant?.recommended || id.includes('flash'), // Recommend flash by default
                accessible: true
            });
        });

        // 2. Add any hardcoded Recommended models if they weren't found (marked as inaccessible)
        // This keeps the UI table full even if API key doesn't have access
        Object.entries(gemini.GEMINI_VARIANTS).forEach(([id, info]) => {
            if (!accessibleModels.find(m => m.id === id)) {
                accessibleModels.push({
                    id: id,
                    displayName: info.displayName,
                    tier: info.tier,
                    recommended: info.recommended,
                    accessible: false
                });
            }
        });

        // Sort: Accessible first, then Recommended, then Name
        accessibleModels.sort((a, b) => {
            if (a.accessible !== b.accessible) return b.accessible - a.accessible;
            if (a.recommended !== b.recommended) return b.recommended - a.recommended;
            return a.displayName.localeCompare(b.displayName);
        });

        res.json({
            models: accessibleModels,
            default: gemini.DEFAULT_MODEL,
            totalApiModels: apiModels.length
        });
    } catch (err) {
        console.error('[GEMINI-MODELS] Error:', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({
            error: err.response?.data?.error?.message || err.message
        });
    }
});

// Phase 19: Delete Project Endpoint
app.delete('/api/history/:id', (req, res) => {
    const { id } = req.params;
    try {
        const history = readDb();
        const newHistory = history.filter(p => p.id !== id);

        if (history.length === newHistory.length) {
            return res.status(404).json({ error: "Project not found" });
        }

        // 1. Remove from DB
        writeDb(newHistory);

        // 2. Remove Files (Recursive)
        const projectDir = path.join(__dirname, 'clips', id);
        if (fs.existsSync(projectDir)) {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- CLIP POST-PROCESSING ENDPOINTS ---

// PATCH: Update clip metadata (hook, subtitle, custom title)
app.patch('/api/history/:projectId/clips/:clipIdx', (req, res) => {
    const { projectId, clipIdx } = req.params;
    const { customHook, customSubtitle, customTitle } = req.body;

    try {
        const history = readDb();
        const projectIdx = history.findIndex(p => p.id === projectId);

        if (projectIdx === -1) {
            return res.status(404).json({ error: "Project not found" });
        }

        const idx = parseInt(clipIdx);
        if (!history[projectIdx].clips || idx >= history[projectIdx].clips.length) {
            return res.status(404).json({ error: "Clip not found" });
        }

        // Update clip metadata
        if (customHook !== undefined) history[projectIdx].clips[idx].customHook = customHook;
        if (customSubtitle !== undefined) history[projectIdx].clips[idx].customSubtitle = customSubtitle;
        if (customTitle !== undefined) history[projectIdx].clips[idx].customTitle = customTitle;

        writeDb(history);
        res.json({ success: true, clip: history[projectIdx].clips[idx] });
    } catch (error) {
        console.error("Clip Update Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// POST: Re-render a single clip with new style/format
app.post('/api/video/reprocess-single', licenseCheck, async (req, res) => {
    // Free version: edit/reprocess is disabled
    return res.status(403).json({ error: 'Edit is not available in the Free version. Upgrade to Qlipper Pro.' });
    const { projectId, clipIdx, outputFormat, outputResolution = '720p', styleSettings, turboMode = true } = req.body;
    const dims = getResolutionDimensions(outputResolution, outputFormat);
    console.log(`[REPROCESS] Resolution: ${outputResolution} (${dims.w}x${dims.h})`);

    // Debug: Log full styleSettings to verify what's being received
    console.log('[REPROCESS] Received styleSettings:', JSON.stringify({
        hookEnabled: styleSettings?.hookEnabled,
        hookBrand: styleSettings?.hookBrand,
        hookHeadline: styleSettings?.hookHeadline,
        hookSubtitle: styleSettings?.hookSubtitle,
        hookAlignment: styleSettings?.hookAlignment,
        hookVerticalPosition: styleSettings?.hookVerticalPosition,
        // Custom FFmpeg style parameters
        hookTextColor: styleSettings?.hookTextColor,
        hookStroke: styleSettings?.hookStroke,
        hookStrokeColor: styleSettings?.hookStrokeColor,
        hookBorderWidth: styleSettings?.hookBorderWidth,
        hookBgEnabled: styleSettings?.hookBgEnabled,
        hookBackground: styleSettings?.hookBackground,
        hookFontFamily: styleSettings?.hookFontFamily,
        hookFontSize: styleSettings?.hookFontSize,
        // Subtitle
        subtitleEnabled: styleSettings?.subtitleEnabled,
        subtitlePreset: styleSettings?.subtitlePreset
    }, null, 2));

    if (!projectId || clipIdx === undefined) {
        return res.status(400).json({ error: "projectId and clipIdx required" });
    }

    try {
        const history = readDb();
        const project = history.find(p => p.id === projectId);

        if (!project) {
            return res.status(404).json({ error: "Project not found" });
        }

        const idx = parseInt(clipIdx);
        if (!project.clips || idx >= project.clips.length) {
            return res.status(404).json({ error: "Clip not found" });
        }

        const existingClip = project.clips[idx];

        // Get timeline from promptConfig
        const originalClipConfig = project.promptConfig?.video_clips?.[idx];
        if (!originalClipConfig) {
            return res.status(400).json({ error: "Original timeline data not found" });
        }

        // Resolve video path — portable: always resolve relative to app root
        const appRoot = path.resolve(__dirname, '..');
        const { resolved: resolvedVideoPath, error: pathError } = resolveMediaPath(appRoot, project.sourceVideo);
        if (pathError) {
            return res.status(404).json({ error: pathError });
        }
        let videoPath = resolvedVideoPath;

        const jobId = `reprocess_${Date.now()}`;
        const reprocessStartTime = new Date().toISOString();
        console.log(`[REPROCESS] Starting single clip re-render: Project=${projectId} Clip=${idx} Format=${outputFormat}`);

        // Mark clip as processing in DB before returning
        try {
            const freshHistory = readDb();
            const projIdx = freshHistory.findIndex(p => p.id === projectId);
            if (projIdx !== -1 && freshHistory[projIdx].clips[idx]) {
                freshHistory[projIdx].clips[idx].reprocessStatus = 'processing';
                freshHistory[projIdx].clips[idx].reprocessStartedAt = reprocessStartTime;
                writeDb(freshHistory);
            }
        } catch (e) {
            console.error('[REPROCESS] Failed to mark clip as processing:', e.message);
        }

        // Return immediately
        res.json({ jobId, message: "Re-processing started", startedAt: reprocessStartTime });

        // Background processing
        (async () => {
            try {
                const clipsDir = path.join(clipsDirRoot, projectId);
                if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

                const safeTopic = (originalClipConfig.topic || 'clip').toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 50);
                const newOutputName = `${safeTopic}_v${Date.now()}.mp4`;
                const finalOutputPath = path.join(clipsDir, newOutputName);

                const runFFmpeg = (args) => {
                    return new Promise((resolve, reject) => {
                        const proc = spawn(ffmpegBinaryPath || 'ffmpeg', ['-nostdin', '-hide_banner', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
                        let stderr = '';
                        proc.stdout.on('data', () => { });
                        proc.stderr.on('data', d => stderr += d.toString());
                        proc.on('error', (err) => reject(new Error(`Spawn Error: ${err.message}`)));
                        proc.on('close', (code) => {
                            if (code === 0) resolve();
                            else reject(new Error(`Exit code ${code}. Stderr: ${stderr.slice(-500)}`));
                        });
                    });
                };

                // Cross-platform encoder detection for reprocess
                const detectReprocessEncoder = async () => {
                    const os = require('os');
                    const platform = os.platform();

                    // Mac: Always use VideoToolbox
                    if (platform === 'darwin') {
                        console.log('[REPROCESS] Mac detected → Using h264_videotoolbox');
                        return 'h264_videotoolbox';
                    }

                    // Windows/Linux: Probe for available encoders
                    const encodersToTry = [
                        { name: 'h264_nvenc', label: 'NVIDIA NVENC' },
                        { name: 'h264_qsv', label: 'Intel Quick Sync' },
                        { name: 'h264_amf', label: 'AMD AMF' }
                    ];

                    for (const encoder of encodersToTry) {
                        try {
                            await new Promise((resolve, reject) => {
                                const proc = spawn(ffmpegBinaryPath || 'ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
                                let output = '';
                                proc.stdout.on('data', d => output += d.toString());
                                proc.on('close', () => {
                                    if (output.includes(encoder.name)) resolve(true);
                                    else reject(new Error('Not found'));
                                });
                                proc.on('error', reject);
                            });
                            console.log(`[REPROCESS] ${encoder.label} detected → Using ${encoder.name}`);
                            return encoder.name;
                        } catch {
                            // Continue to next encoder
                        }
                    }

                    console.log('[REPROCESS] No hardware encoder found → Using libx264 (CPU)');
                    return null;
                };

                const hwEncoder = await detectReprocessEncoder();

                const getReprocessEncodingParams = () => {
                    const commonFlags = ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
                    const bitrate = getBitrate(outputResolution);  // Dynamic bitrate based on resolution

                    if (!hwEncoder) {
                        // Software fallback - use CRF for quality-based encoding
                        const crf = outputResolution === '4k' ? '18' : outputResolution === '1440p' ? '20' : outputResolution === '1080p' ? '22' : '24';
                        return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', crf, ...commonFlags];
                    }

                    // Hardware-specific params with dynamic bitrate
                    let params;
                    switch (hwEncoder) {
                        case 'h264_videotoolbox':
                            params = ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, ...commonFlags];
                            break;
                        case 'h264_nvenc':
                            params = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', bitrate, ...commonFlags];
                            break;
                        case 'h264_qsv':
                            params = ['-c:v', 'h264_qsv', '-preset', 'fast', '-b:v', bitrate, ...commonFlags];
                            break;
                        case 'h264_amf':
                            params = ['-c:v', 'h264_amf', '-quality', 'balanced', '-b:v', bitrate, ...commonFlags];
                            break;
                        default:
                            params = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', ...commonFlags];
                    }
                    return params;
                };

                // Phase 1: Extract raw clip segments with CLIP-LEVEL buffer
                const tempRawClips = [];

                // --- FIX: Sort timelines chronologically and sanitize ---
                originalClipConfig.timelines.sort((a, b) => parseTime(a.start) - parseTime(b.start));
                originalClipConfig.timelines = originalClipConfig.timelines.filter(tl => {
                    const s = parseTime(tl.start);
                    const e = parseTime(tl.end);
                    if (s >= e) {
                        console.warn(`[REPROCESS] Skipping inverted timeline: start=${tl.start}(${s}s) >= end=${tl.end}(${e}s)`);
                        return false;
                    }
                    return true;
                });

                // --- CLIP-LEVEL BUFFER: Calculate clip boundaries first ---
                let clipEarliestStart = Infinity;
                let clipLatestEnd = 0;
                for (const tl of originalClipConfig.timelines) {
                    const s = parseTime(tl.start);
                    const e = parseTime(tl.end);
                    if (s < clipEarliestStart) clipEarliestStart = s;
                    if (e > clipLatestEnd) clipLatestEnd = e;
                }
                // Apply 3s buffer at CLIP level only
                const bufferedClipStart = Math.max(0, clipEarliestStart - 3);
                const bufferedClipEnd = clipLatestEnd + 3;

                // Extract each timeline with buffer applied at clip boundaries
                for (let i = 0; i < originalClipConfig.timelines.length; i++) {
                    let { start, end } = originalClipConfig.timelines[i];
                    let startSec = parseTime(start);
                    let endSec = parseTime(end);

                    // Apply clip-level buffer: first timeline gets start buffer, last gets end buffer
                    const isFirst = (i === 0);
                    const isLast = (i === originalClipConfig.timelines.length - 1);

                    if (isFirst) startSec = bufferedClipStart;
                    if (isLast) endSec = bufferedClipEnd;

                    let durationSec = endSec - startSec;

                    // --- FIX: Guard against negative/zero duration ---
                    if (durationSec <= 0) {
                        console.warn(`[REPROCESS] Negative duration: clip seg ${i}: start=${startSec}s end=${endSec}s dur=${durationSec}s. Falling back to original timestamps.`);
                        startSec = parseTime(start);
                        endSec = parseTime(end);
                        durationSec = endSec - startSec;
                        if (durationSec <= 0) {
                            console.warn(`[REPROCESS] Original timestamps also inverted. Using 1s minimum.`);
                            durationSec = 1;
                        }
                    }

                    const tempRawPath = path.join(clipsDir, `temp_reprocess_${idx}_${i}.mp4`);
                    // Store both buffered extraction start AND unbuffered timeline start.
                    // originalStart = buffered (used for FFmpeg extraction)
                    // unbufferedStart = true timeline start (used for subtitle offset calculation)
                    const unbufferedStart = parseTime(originalClipConfig.timelines[i].start);
                    tempRawClips.push({ path: tempRawPath, duration: durationSec, originalStart: startSec, unbufferedStart });

                    // FRAME-ACCURATE EXTRACTION (Re-encode for precision)
                    const extractArgs = [
                        '-y',
                        '-ss', formatTime(startSec),
                        '-i', videoPath,
                        '-t', formatTime(durationSec),
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                        '-c:a', 'aac', '-b:a', '128k',
                        '-avoid_negative_ts', 'make_zero',
                        tempRawPath
                    ];
                    await runFFmpeg(extractArgs);
                }

                // Phase 2: Apply new format/style
                const segmentFiles = [];
                const format = outputFormat || 'stacked-blur';
                let lastSubtitleSkipReason = null; // Track subtitle skip reason across segments

                for (let i = 0; i < tempRawClips.length; i++) {
                    const tempClip = tempRawClips[i];
                    const segmentPath = path.join(clipsDir, `seg_reprocess_${idx}_${i}.mp4`);
                    segmentFiles.push(segmentPath);

                    let filterGraph = '';
                    let inputArgs = ['-y', '-i', tempClip.path];

                    // Dynamic resolution dimensions
                    const W = dims.w;
                    const H = dims.h;
                    const halfH = Math.floor(H / 2);
                    const sqSize = Math.min(W, H);

                    // Format filters (Dynamic Resolution) - Both STATIC and MOTION blur options
                    if (format === 'stacked-blur' || format === 'landscape-blur') {
                        // 9:16 with STATIC Blurred Background (Fast)
                        const bgImagePath = path.join(clipsDir, `bg_reprocess_${idx}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (format === 'stacked-blur-motion' || format === 'landscape-blur-motion') {
                        // 9:16 with DYNAMIC Blurred Background (Motion)
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15[bg];` +
                            `[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (format === 'portrait-square') {
                        // 9:16 with centered 1:1 square video + STATIC blurred background
                        const bgImagePath = path.join(clipsDir, `bg_ps_reprocess_${idx}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:18`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${sqSize}:${sqSize}:force_original_aspect_ratio=increase,crop=${sqSize}:${sqSize}[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (format === 'portrait-square-motion') {
                        // 9:16 with centered 1:1 square video + DYNAMIC blurred background
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:18[bg];` +
                            `[fg_src]scale=${sqSize}:${sqSize}:force_original_aspect_ratio=increase,crop=${sqSize}:${sqSize}[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (format === 'square-blur') {
                        // 1:1 with STATIC Blurred Background
                        const bgImagePath = path.join(clipsDir, `bg_sq_reprocess_${idx}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (format === 'square-blur-motion') {
                        // 1:1 with DYNAMIC Blurred Background
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15[bg];` +
                            `[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (format === 'center-crop' || format === 'zoomed-nine-sixteen') {
                        filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                    } else if (format === 'square-zoom') {
                        filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                    } else if (format === 'ig-post-blur' || format === 'ig-post' || format === 'portrait-3-4') {
                        // 3:4 Instagram Post with STATIC Blurred Background
                        const bgImagePath = path.join(clipsDir, `bg_ig_reprocess_${idx}_${i}.png`);
                        const bgArgs = ['-y', '-i', tempClip.path, '-ss', '0', '-vframes', '1', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15`, bgImagePath];
                        await runFFmpeg(bgArgs);
                        inputArgs = ['-y', '-i', tempClip.path, '-loop', '1', '-i', bgImagePath];
                        filterGraph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v_base]`;
                    } else if (format === 'ig-post-blur-motion' || format === 'ig-post-motion' || format === 'portrait-3-4-motion') {
                        // 3:4 Instagram Post with DYNAMIC Blurred Background
                        filterGraph = `[0:v]split[bg_src][fg_src];` +
                            `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:15[bg];` +
                            `[fg_src]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
                            `[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]`;
                    } else if (format === 'ig-post-crop' || format === 'portrait-3-4-crop') {
                        // 3:4 Instagram Post Center Crop (No Blur)
                        filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                    } else if (format === 'split-speaker') {
                        // 9:16 Split Speaker: Left half on top, Right half on bottom
                        console.log(`[REPROCESS] Processing Split Speaker L→R (${W}x${H}) for clip ${idx}`);
                        filterGraph = `[0:v]crop=iw/2:ih:0:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:iw/2:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                    } else if (format === 'split-speaker-inv') {
                        // 9:16 Split Speaker Inverted: Right half on top, Left half on bottom
                        console.log(`[REPROCESS] Processing Split Speaker R→L (${W}x${H}) for clip ${idx}`);
                        filterGraph = `[0:v]crop=iw/2:ih:iw/2:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:0:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                    } else if (format === 'split-face-track') {
                        // Face-tracking split: crop centered on each speaker's face position
                        const fp = originalClipConfig.face_positions;
                        if (fp && fp.speakers && fp.speakers.length >= 2) {
                            const sp1 = fp.speakers[0];
                            const sp2 = fp.speakers[1];
                            const x1 = Math.max(25, Math.min(75, sp1.x_pct || 25));
                            const x2 = Math.max(25, Math.min(75, sp2.x_pct || 75));
                            console.log(`[REPROCESS] Processing Split Face-Track (${W}x${H}) for clip ${idx} — faces at ${x1}%, ${x2}%`);
                            filterGraph = `[0:v]crop=iw/2:ih:iw*${(x1 / 100) - 0.25}:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:iw*${(x2 / 100) - 0.25}:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                        } else {
                            console.log(`[REPROCESS] Split Face-Track fallback to L→R (no face data) for clip ${idx}`);
                            filterGraph = `[0:v]crop=iw/2:ih:0:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[top];[0:v]crop=iw/2:ih:iw/2:0,scale=${W}:${halfH}:force_original_aspect_ratio=increase,crop=${W}:${halfH}[bottom];[top][bottom]vstack[v_base]`;
                        }
                    } else if (format === 'face-track-zoom' || format === 'face-track-zoom-3-4' || format === 'face-track-zoom-square' || format === 'face-track-zoom-landscape') {
                        // Face-tracking zoom: center-crop on primary speaker's face position
                        const fp = originalClipConfig.face_positions;
                        const primarySpeaker = fp?.speakers?.[0];
                        if (primarySpeaker) {
                            const xPct = Math.max(10, Math.min(90, primarySpeaker.x_pct || 50));
                            const yPct = Math.max(10, Math.min(90, primarySpeaker.y_pct || 40));
                            console.log(`[REPROCESS] Processing Face-Track Zoom (${W}x${H}) for clip ${idx} — face at ${xPct}%, ${yPct}%`);
                            filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:iw*${xPct / 100}-${W / 2}:ih*${yPct / 100}-${H / 2}[v_base]`;
                        } else {
                            console.log(`[REPROCESS] Face-Track Zoom fallback to center crop (no face data) for clip ${idx}`);
                            filterGraph = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_base]`;
                        }
                    } else if (format === 'raw-cuts') {
                        // Just copy
                        await runFFmpeg(['-y', '-i', tempClip.path, '-c', 'copy', segmentPath]);
                        continue;
                    } else {
                        filterGraph = `null[v_base]`;
                    }

                    // Hook overlay if provided - using Puppeteer PNG overlay for pixel-perfect styling
                    let lastLink = '[v_base]';
                    let overlayPngPath = null;

                    if (styleSettings?.hookEnabled && styleSettings.hookHeadline?.text) {
                        console.log('[REPROCESS-HOOK] Using Puppeteer PNG overlay for pixel-perfect styling');

                        // Extract style settings with defaults (neon-green as default)
                        const hookTextRaw = styleSettings.hookHeadline.text;
                        const hookText = styleSettings.hookUppercase ? hookTextRaw.toUpperCase() : hookTextRaw;
                        const textColor = styleSettings.hookTextColor || styleSettings.hookHeadline?.color || '#00FF00';
                        const bgEnabled = styleSettings.hookBgEnabled || false;
                        const backgroundColor = styleSettings.hookBackground || 'transparent';
                        const outlineEnabled = styleSettings.hookOutlineEnabled ?? styleSettings.hookStroke ?? true;
                        const shadowEnabled = styleSettings.hookShadowEnabled !== false; // default true
                        const borderColor = styleSettings.hookStrokeColor || '#000000';
                        const borderWidth = styleSettings.hookBorderWidth ?? 8;
                        const fontFamily = styleSettings.hookFontFamily || 'Sans-Bold';
                        const fontSize = styleSettings.hookFontSize ?? 72;
                        const alignment = styleSettings.hookAlignment || 'center';
                        const verticalPosition = styleSettings.hookVerticalPosition ?? 75;

                        // Sticker settings
                        const stickerEnabled = styleSettings.stickerEnabled || false;
                        const stickerText = styleSettings.stickerText || '';
                        const stickerShape = styleSettings.stickerShape || 'pill';
                        const stickerBgColor = styleSettings.stickerBgColor || '#FF3B30';
                        const stickerTextColor = styleSettings.stickerTextColor || '#FFFFFF';
                        const stickerImagePath = styleSettings.stickerImagePath || null;

                        console.log(`[REPROCESS-HOOK] Text: "${hookText.substring(0, 30)}..."`);
                        console.log(`[REPROCESS-HOOK] TextColor: ${textColor}, BgEnabled: ${bgEnabled}, BgColor: ${backgroundColor}`);
                        console.log(`[REPROCESS-HOOK] OutlineEnabled: ${outlineEnabled}, ShadowEnabled: ${shadowEnabled}, BorderColor: ${borderColor}, BorderWidth: ${borderWidth}`);
                        console.log(`[REPROCESS-HOOK] Font: ${fontFamily}, Size: ${fontSize}, Align: ${alignment}, Y: ${verticalPosition}%`);
                        if (stickerEnabled) console.log(`[REPROCESS-HOOK] Sticker: "${stickerText}" shape=${stickerShape} image=${stickerImagePath ? 'yes' : 'no'}`);

                        // Render overlay PNG using Puppeteer
                        overlayPngPath = path.join(clipsDir, `overlay_${idx}_${i}.png`);

                        try {
                            await renderOverlayToPNG({
                                text: hookText,
                                textColor,
                                backgroundColor,
                                bgEnabled,
                                outlineEnabled,
                                shadowEnabled,
                                borderColor,
                                borderWidth,
                                fontFamily,
                                fontSize,
                                alignment,
                                verticalPosition,
                                width: W,
                                height: H,
                                stickerEnabled,
                                stickerText,
                                stickerShape,
                                stickerBgColor,
                                stickerTextColor,
                                stickerImagePath,
                            }, overlayPngPath);

                            console.log(`[REPROCESS-HOOK] Overlay PNG rendered: ${overlayPngPath}`);
                        } catch (overlayError) {
                            console.error('[REPROCESS-HOOK] Failed to render overlay PNG:', overlayError.message);
                            overlayPngPath = null; // Fall back to no overlay
                        }
                    }

                    // If we have an overlay PNG, add it to the filter graph
                    if (overlayPngPath && fs.existsSync(overlayPngPath)) {
                        // Add overlay PNG as additional input
                        inputArgs.push('-i', overlayPngPath);
                        // Count -i flags to get the overlay's input index (0-based)
                        const overlayInputIdx = inputArgs.filter(a => a === '-i').length - 1;

                        // Overlay the PNG on top of the video (PNG is transparent)
                        filterGraph += `;${lastLink}[${overlayInputIdx}:v]overlay=0:0:format=auto[v_overlay]`;
                        lastLink = '[v_overlay]';
                        console.log(`[REPROCESS] Added overlay PNG to filter graph (input ${overlayInputIdx})`);
                    }

                    // Logo/Sticker overlay if enabled
                    if (styleSettings?.logoEnabled && styleSettings.logoPath) {
                        let logoAbsPath = styleSettings.logoPath;
                        if (!path.isAbsolute(logoAbsPath)) {
                            logoAbsPath = path.resolve(__dirname, '..', logoAbsPath);
                        }

                        if (fs.existsSync(logoAbsPath)) {
                            inputArgs.push('-i', logoAbsPath);
                            const logoInputIdx = inputArgs.filter(a => a === '-i').length - 1;

                            const logoScale = styleSettings.logoScale ?? 25; // % of video width
                            const logoX = styleSettings.logoX ?? 5;          // % from left
                            const logoY = styleSettings.logoY ?? 5;          // % from top
                            const logoOpacity = styleSettings.logoOpacity ?? 1.0;

                            const scaleW = Math.round(W * (logoScale / 100));
                            const posX = Math.round(W * (logoX / 100));
                            const posY = Math.round(H * (logoY / 100));

                            // Build logo filter: scale → opacity → overlay
                            let logoFilter = `[${logoInputIdx}:v]scale=${scaleW}:-1,format=rgba`;
                            if (logoOpacity < 1.0) {
                                logoFilter += `,colorchannelmixer=aa=${logoOpacity.toFixed(2)}`;
                            }
                            logoFilter += `[logo_scaled];${lastLink}[logo_scaled]overlay=${posX}:${posY}:format=auto[v_logo]`;
                            filterGraph += `;${logoFilter}`;
                            lastLink = '[v_logo]';

                            console.log(`[REPROCESS] Added logo overlay: scale=${scaleW}px pos=(${posX},${posY}) opacity=${logoOpacity}`);
                        } else {
                            console.warn(`[REPROCESS] Logo file not found: ${logoAbsPath}`);
                        }
                    }

                    // Subtitle burning if enabled
                    // Track subtitle overlay PNGs for cleanup
                    const subtitlePngPaths = [];
                    let subtitleSkipReason = null; // Track why subtitles were skipped (for user feedback)

                    // Mutual exclusion: if subtitleEnabled (ASS), disable legacy burnSubtitles (VTT)
                    if (styleSettings?.subtitleEnabled && req.body.burnSubtitles) {
                        console.warn('[REPROCESS] Both subtitleEnabled (ASS) and burnSubtitles (VTT) are true. Using subtitleEnabled only and disabling burnSubtitles.');
                        req.body.burnSubtitles = false;
                    }

                    if (styleSettings?.subtitleEnabled) {
                        // Find caption source - prefer Whisper word-level data over VTT
                        const { findAndParseVttForVideo, addWordTimings, deduplicateBlocks, findAndParseWhisperForVideo } = require('./lib/parseVttToBlocks');
                        const { generateSubtitleASS, smoothSubtitleBlocks, escapePathForFFmpegFilter, CUSTOM_FONTS_DIR } = require('./lib/overlayRenderer');

                        const appDir = path.join(__dirname, '..');

                        // Try Whisper transcript first (has real word-level timestamps)
                        let captionSource = null;
                        let captionSourceType = 'none';
                        const whisperResult = findAndParseWhisperForVideo(videoPath, appDir);
                        if (whisperResult && whisperResult.blocks && whisperResult.blocks.length > 0) {
                            captionSource = whisperResult;
                            captionSourceType = whisperResult.hasWordTimestamps ? 'whisper-word' : 'whisper-segment';
                            console.log(`[REPROCESS] Found Whisper transcript: ${whisperResult.transcriptPath} (word-level: ${whisperResult.hasWordTimestamps})`);
                        }

                        // Fallback to VTT
                        if (!captionSource) {
                            const vttResult = findAndParseVttForVideo(videoPath, appDir);
                            if (vttResult && vttResult.blocks && vttResult.blocks.length > 0) {
                                captionSource = vttResult;
                                captionSourceType = 'vtt';
                                console.log(`[REPROCESS] Found VTT: ${vttResult.vttPath}`);
                            }
                        }

                        if (captionSource && captionSource.blocks && captionSource.blocks.length > 0) {
                            console.log(`[REPROCESS] Caption source: ${captionSourceType}, total blocks: ${captionSource.blocks.length}`);

                            // ---- Calculate time offset for this segment ----
                            // The extracted clip starts at t=0 locally, but caption timestamps are absolute.
                            // We use the BUFFERED start for both filtering AND offset calculation,
                            // because FFmpeg extracted from the buffered start (local t=0 = bufferedStart).
                            // bufferOffset is tracked for logging only.
                            const segmentOriginalStart = tempClip.originalStart; // buffered extraction start
                            const segmentUnbufferedStart = tempClip.unbufferedStart ?? tempClip.originalStart; // true timeline start
                            const bufferOffset = segmentUnbufferedStart - segmentOriginalStart; // how much buffer was prepended (typically ~3s)
                            const segmentDuration = tempClip.duration;
                            const segmentOriginalEnd = segmentOriginalStart + segmentDuration;

                            console.log(`[REPROCESS] Segment time range: ${segmentOriginalStart.toFixed(1)}s - ${segmentOriginalEnd.toFixed(1)}s (duration: ${segmentDuration.toFixed(1)}s, buffer: ${bufferOffset.toFixed(1)}s)`);

                            // Process blocks based on source type
                            let allTimedBlocks;
                            if (captionSourceType === 'whisper-word') {
                                // Whisper blocks already have real word-level timestamps — no interpolation needed
                                allTimedBlocks = captionSource.blocks;
                                console.log(`[REPROCESS] Using Whisper word-level timestamps (${allTimedBlocks.length} blocks)`);
                            } else if (captionSourceType === 'vtt') {
                                // VTT blocks need word timing interpolation
                                allTimedBlocks = captionSource.blocks.map(addWordTimings);
                                console.log(`[REPROCESS] Using VTT with interpolated word timing (${allTimedBlocks.length} blocks)`);
                            } else {
                                // Whisper segment-level (no word data) — still has better timing than VTT
                                allTimedBlocks = captionSource.blocks;
                                console.log(`[REPROCESS] Using Whisper segment-level timestamps (${allTimedBlocks.length} blocks)`);
                            }

                            const relevantBlocks = allTimedBlocks.filter(block => {
                                // Block overlaps with segment if: block.end > segStart AND block.start < segEnd
                                return block.endTime > segmentOriginalStart && block.startTime < segmentOriginalEnd;
                            });

                            console.log(`[REPROCESS] Relevant caption blocks for this segment: ${relevantBlocks.length} (filtered from ${allTimedBlocks.length})`);

                            if (relevantBlocks.length > 0) {
                                // Advance subtitles to compensate for caption latency.
                                // Whisper has precise word-level timing — no advance needed.
                                // YouTube VTT auto-captions lag slightly, so apply a small advance.
                                const SUBTITLE_ADVANCE = captionSourceType === 'whisper-word' ? 0.0 : 0.3;
                                const timeOffset = segmentOriginalStart + SUBTITLE_ADVANCE;
                                console.log(`[REPROCESS] Subtitle advance: ${SUBTITLE_ADVANCE}s (source: ${captionSourceType})`);

                                // Offset blocks to local time (subtract segment start + advance)
                                const offsetBlocks = relevantBlocks.map(block => ({
                                    ...block,
                                    startTime: Math.max(0, block.startTime - timeOffset),
                                    endTime: Math.max(0, Math.min(segmentDuration, block.endTime - timeOffset)),
                                    words: block.words ? block.words.map(w => ({
                                        ...w,
                                        startTime: Math.max(0, w.startTime - timeOffset),
                                        endTime: Math.max(0, Math.min(segmentDuration, w.endTime - timeOffset)),
                                    })) : []
                                })).filter(block => block.endTime > block.startTime);

                                // Only deduplicate VTT blocks (YouTube auto-captions repeat words).
                                // Whisper blocks don't have progressive reveal, so skip dedup.
                                let localBlocks;
                                if (captionSourceType === 'vtt') {
                                    localBlocks = deduplicateBlocks(offsetBlocks, 0.3);
                                    console.log(`[REPROCESS] After VTT dedup: ${localBlocks.length} blocks (from ${offsetBlocks.length})`);
                                } else {
                                    localBlocks = offsetBlocks;
                                    console.log(`[REPROCESS] Whisper blocks (no dedup needed): ${localBlocks.length} blocks`);
                                }

                                // Smooth subtitle timing: group words into comfortable reading chunks,
                                // enforce minimum display time, close micro-gaps, add punctuation pauses.
                                const maxWords = styleSettings.subtitleMaxWordsPerLine ?? 4;
                                localBlocks = smoothSubtitleBlocks(localBlocks, {
                                    maxWordsPerChunk: maxWords,
                                    maxCharsPerChunk: Math.max(20, maxWords * 6),
                                    minDisplaySec: styleSettings.subtitleMinDisplaySec ?? 0.8,
                                    maxGapSec: 0.05,
                                    punctuationHoldSec: 0.15,
                                });
                                console.log(`[REPROCESS] After smoothing: ${localBlocks.length} chunks (max ${maxWords} words/chunk, max ${Math.max(20, maxWords * 6)} chars/chunk)`);

                                // Extract subtitle style settings
                                const subSettings = {
                                    textColor: styleSettings.subtitleTextColor || '#FFFFFF',
                                    highlightColor: styleSettings.subtitleHighlightColor || '#00FF66',
                                    outlineColor: styleSettings.subtitleOutlineColor || '#000000',
                                    bgColor: styleSettings.subtitleBgColor || 'transparent',
                                    bgEnabled: styleSettings.subtitleBgEnabled ?? false,
                                    fontFamily: styleSettings.subtitleFontFamily || 'Sans-Bold',
                                    fontSize: styleSettings.subtitleFontSize ?? 48,
                                    outlineWidth: styleSettings.subtitleOutlineWidth ?? 3,
                                    uppercase: styleSettings.subtitleUppercase ?? true,
                                    position: styleSettings.subtitlePosition ?? 85,
                                    alignment: styleSettings.subtitleAlignment || 'center',
                                    wordByWord: styleSettings.subtitleWordByWord ?? true,
                                    shadowEnabled: styleSettings.subtitleShadowEnabled ?? true,
                                    glowEffect: styleSettings.subtitleGlowEffect ?? true,
                                    scaleEffect: styleSettings.subtitleScaleEffect ?? false,
                                    highlightScale: styleSettings.subtitleHighlightScale ?? 115,
                                    maxWordsPerLine: styleSettings.subtitleMaxWordsPerLine ?? 4,
                                    lineSpacing: styleSettings.subtitleLineSpacing ?? 1.2
                                };

                                // Get output dimensions (use the same W/H computed for the output format)
                                const outWidth = W;
                                const outHeight = H;

                                // ---- ASS SUBTITLE APPROACH ----
                                // Generate a single ASS file with karaoke timing instead of
                                // rendering 200+ PNGs. This uses ONE FFmpeg filter and ZERO
                                // extra inputs — eliminates the "stream #199" crash entirely.
                                const assContent = generateSubtitleASS({
                                    blocks: localBlocks,
                                    textColor: subSettings.textColor,
                                    highlightColor: subSettings.highlightColor,
                                    outlineColor: subSettings.outlineColor,
                                    outlineWidth: subSettings.outlineWidth,
                                    bgColor: subSettings.bgColor,
                                    bgEnabled: subSettings.bgEnabled,
                                    fontFamily: subSettings.fontFamily,
                                    fontSize: subSettings.fontSize,
                                    position: subSettings.position,
                                    alignment: subSettings.alignment,
                                    width: outWidth,
                                    height: outHeight,
                                    shadowEnabled: subSettings.shadowEnabled,
                                    glowEffect: subSettings.glowEffect,
                                    scaleEffect: subSettings.scaleEffect,
                                    highlightScale: subSettings.highlightScale,
                                    wordByWord: subSettings.wordByWord,
                                    uppercase: subSettings.uppercase,
                                    maxWordsPerLine: subSettings.maxWordsPerLine,
                                    lineSpacing: subSettings.lineSpacing,
                                    minDisplaySec: styleSettings.subtitleMinDisplaySec ?? 0.8,
                                });

                                const assPath = path.join(clipsDir, `subtitle_${idx}_${i}.ass`);
                                fs.writeFileSync(assPath, assContent, 'utf-8');
                                subtitlePngPaths.push(assPath); // reuse cleanup array for temp file removal

                                // Add ASS subtitle filter to the filter graph (single filter, zero extra inputs)
                                const assPathEscaped = escapePathForFFmpegFilter(assPath);
                                // Use fontsdir for custom bundled fonts (e.g. Komika Axis)
                                const fontsDirEscaped = escapePathForFFmpegFilter(CUSTOM_FONTS_DIR);
                                filterGraph += `;${lastLink}ass='${assPathEscaped}':fontsdir='${fontsDirEscaped}'[v_sub]`;
                                lastLink = '[v_sub]';

                                let totalWordsInRange = 0;
                                for (const block of localBlocks) {
                                    totalWordsInRange += (block.words?.length || 0);
                                }
                                console.log(`[REPROCESS] ASS subtitle generated: ${totalWordsInRange} words, ${localBlocks.length} blocks, ${subSettings.wordByWord ? 'word-by-word' : 'full-line'} mode, max ${subSettings.maxWordsPerLine} words/line (source: ${captionSourceType})`);
                            } else {
                                console.log(`[REPROCESS] No caption blocks in this segment's time range`);
                                subtitleSkipReason = 'no_captions_in_range';
                                lastSubtitleSkipReason = 'no_captions_in_range';
                            }
                        } else {
                            console.log(`[REPROCESS] No caption source found (no Whisper transcript or VTT file)`);
                            subtitleSkipReason = 'no_caption_source';
                            lastSubtitleSkipReason = 'no_caption_source';
                        }
                    }

                    filterGraph += `;${lastLink}null[v]`;

                    // Validate filter graph length to prevent FFmpeg command line length overflow
                    // Windows has ~8191 char limit, Unix has higher limit but let's be safe
                    const filterGraphLength = filterGraph.length;
                    const maxSafeFilterLength = 6000; // Conservative limit
                    if (filterGraphLength > maxSafeFilterLength) {
                        console.warn(`[REPROCESS] Filter graph is very long (${filterGraphLength} chars), exceeds safe limit (${maxSafeFilterLength}). This may cause FFmpeg errors.`);
                    }

                    const baseArgs = [...inputArgs, '-filter_complex', filterGraph, '-map', '[v]', '-map', '0:a?'];
                    const encodingParams = getReprocessEncodingParams();
                    const outputArgs = [...encodingParams, '-c:a', 'aac', '-b:a', '128k', segmentPath];

                    try {
                        await runFFmpeg([...baseArgs, ...outputArgs]);
                    } catch (reprocessErr) {
                        // Fallback to software encoding if hardware encoder failed
                        if (hwEncoder) {
                            console.warn(`[REPROCESS] Hardware encoder ${hwEncoder} failed. Retrying with software encoding (libx264)...`);
                            // Build software fallback params
                            const commonFlags = ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
                            const crf = outputResolution === '4k' ? '18' : outputResolution === '1440p' ? '20' : outputResolution === '1080p' ? '22' : '24';
                            const softwareParams = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', crf, ...commonFlags];
                            const softwareOutputArgs = [...softwareParams, '-c:a', 'aac', '-b:a', '128k', segmentPath];

                            await runFFmpeg([...baseArgs, ...softwareOutputArgs]);
                            console.log(`[REPROCESS] Software encoding fallback succeeded`);
                        } else {
                            throw reprocessErr; // No fallback available, re-throw
                        }
                    }

                    // Cleanup overlay PNG after use
                    if (overlayPngPath && fs.existsSync(overlayPngPath)) {
                        fs.unlinkSync(overlayPngPath);
                        console.log(`[REPROCESS] Cleaned up overlay PNG: ${overlayPngPath}`);
                    }

                    // Cleanup subtitle PNGs after use
                    if (subtitlePngPaths && subtitlePngPaths.length > 0) {
                        for (const pngPath of subtitlePngPaths) {
                            if (fs.existsSync(pngPath)) {
                                fs.unlinkSync(pngPath);
                            }
                        }
                        console.log(`[REPROCESS] Cleaned up ${subtitlePngPaths.length} subtitle temp file(s)`);
                    }
                }

                // Cleanup temp files
                tempRawClips.forEach(t => { if (fs.existsSync(t.path)) fs.unlinkSync(t.path); });

                // Concatenate if multiple segments
                if (segmentFiles.length === 1) {
                    fs.renameSync(segmentFiles[0], finalOutputPath);
                } else {
                    const listPath = path.join(clipsDir, `list_reprocess_${idx}.txt`);
                    // FFmpeg concat requires forward slashes on all platforms
                    fs.writeFileSync(listPath, segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
                    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalOutputPath]);
                    fs.unlinkSync(listPath);
                    segmentFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
                }

                // Update database
                const newRelativePath = path.relative(path.join(__dirname, '..'), finalOutputPath);
                const freshHistory = readDb();
                const projIdx = freshHistory.findIndex(p => p.id === projectId);
                if (projIdx !== -1 && freshHistory[projIdx].clips[idx]) {
                    // Delete old file if different
                    const oldPath = freshHistory[projIdx].clips[idx].url;
                    if (oldPath && oldPath !== newRelativePath) {
                        const oldFullPath = path.join(__dirname, '..', oldPath);
                        if (fs.existsSync(oldFullPath)) fs.unlinkSync(oldFullPath);
                    }

                    freshHistory[projIdx].clips[idx].url = newRelativePath;
                    freshHistory[projIdx].clips[idx].outputFormat = format;
                    freshHistory[projIdx].clips[idx].reprocessedAt = new Date().toISOString();
                    freshHistory[projIdx].clips[idx].reprocessStatus = 'completed';
                    // Track subtitle rendering outcome for user feedback
                    if (styleSettings?.subtitleEnabled && lastSubtitleSkipReason) {
                        freshHistory[projIdx].clips[idx].subtitleSkipReason = lastSubtitleSkipReason;
                    } else {
                        freshHistory[projIdx].clips[idx].subtitleSkipReason = null;
                    }
                    writeDb(freshHistory);
                    console.log(`[REPROCESS] Complete: ${newRelativePath}`);
                }

            } catch (error) {
                console.error(`[REPROCESS] Error:`, error.message);
                // Update DB with friendly error
                try {
                    const freshHistory = readDb();
                    const projIdx = freshHistory.findIndex(p => p.id === projectId);
                    if (projIdx !== -1 && freshHistory[projIdx].clips[idx]) {
                        let friendlyError;
                        if (error.message?.includes('Exit code') || error.message?.includes('ffmpeg')) {
                            friendlyError = parseFFmpegError(error.message, 1);
                        } else if (error.code) {
                            friendlyError = parseFileError(error);
                        } else {
                            friendlyError = `Reprocessing failed: ${error.message}. Try a different format or resolution.`;
                        }
                        freshHistory[projIdx].clips[idx].reprocessError = friendlyError;
                        freshHistory[projIdx].clips[idx].reprocessStatus = 'failed';
                        freshHistory[projIdx].clips[idx].isReprocessing = false;
                        writeDb(freshHistory);
                    }
                } catch (dbErr) {
                    console.error('[REPROCESS] DB update error:', dbErr.message);
                }
            }
        })();

    } catch (error) {
        console.error("Reprocess Error:", error);
        let friendlyError;
        if (error.code) {
            friendlyError = parseFileError(error);
        } else {
            friendlyError = `Failed to start reprocessing: ${error.message}. Please try again.`;
        }
        res.status(500).json({ error: friendlyError });
    }
});

// GET: Check reprocess job status
app.get('/api/video/reprocess-status/:projectId/:clipIdx', (req, res) => {
    const { projectId, clipIdx } = req.params;
    try {
        const history = readDb();
        const project = history.find(p => p.id === projectId);
        if (!project || !project.clips[parseInt(clipIdx)]) {
            return res.status(404).json({ error: "Not found" });
        }
        const clip = project.clips[parseInt(clipIdx)];
        res.json({
            url: clip.url,
            outputFormat: clip.outputFormat,
            reprocessedAt: clip.reprocessedAt,
            reprocessStatus: clip.reprocessStatus || 'idle',
            reprocessStartedAt: clip.reprocessStartedAt,
            reprocessError: clip.reprocessError,
            subtitleSkipReason: clip.subtitleSkipReason || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ASSETS ENDPOINTS ---

// --- ASSET SYNC UTILITY ---
// --- ASSET SYNC UTILITY ---
const syncAssets = () => {
    try {
        let assets = readAssets();
        const initialCount = assets.length;

        // 1. VALIDATE EXISTING ASSETS (Remove deleted, Check transcripts)
        assets = assets.filter(asset => {
            const assetPath = path.join(__dirname, '..', asset.path);
            const exists = fs.existsSync(assetPath);
            if (!exists) console.log(`[ASSET - SYNC] Removed missing asset: ${asset.name} `);
            return exists;
        });

        // Check Transcripts
        assets.forEach(asset => {
            if (asset.transcriptionPath) {
                const transPath = path.join(__dirname, '..', asset.transcriptionPath);
                if (!fs.existsSync(transPath)) {
                    console.log(`[ASSET - SYNC] Transcript missing for ${asset.name}.Resetting flags.`);
                    asset.transcriptionPath = null;
                    asset.hasSubtitle = false;
                    asset.hasAudio = false; // Optional: Reset audio flag if strictly tied to transcript
                } else {
                    asset.hasSubtitle = true; // Ensure consistency
                }
            }
        });

        // 2. SCAN FOR NEW FILES
        const existingPaths = new Set(assets.map(a => a.filename));
        const files = fs.readdirSync(assetsDirRoot);

        let newCount = 0;
        files.forEach(file => {
            if (file === '.DS_Store' || file.startsWith('.') || file.endsWith('.json') || file.endsWith('.py') || file.endsWith('.vtt') || file.endsWith('.txt')) return;

            // Ignore directories
            const fullPath = path.join(assetsDirRoot, file);
            if (fs.lstatSync(fullPath).isDirectory()) return;

            // If file not in DB, add it
            if (!existingPaths.has(file)) {
                const relativePath = `assets / ${file} `;

                // Determine Type
                const ext = path.extname(file).toLowerCase();
                const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
                const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext);

                if (!isVideo && !isImage) return; // Skip unknown types

                const type = isVideo ? 'video' : 'image';

                assets.unshift({
                    id: `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)} `,
                    name: file,
                    type: type,
                    path: relativePath,
                    filename: file,
                    timestamp: new Date().toISOString()
                });
                newCount++;
            }
        });

        // Save if changed (either removed or added or updated)
        if (newCount > 0 || assets.length !== initialCount) {
            writeAssets(assets);
            console.log(`[ASSET - SYNC] Synced.New: ${newCount}, Removed / Updated: ${Math.abs(assets.length - initialCount)} `);
        }
        return assets;
    } catch (err) {
        console.error("[ASSET-SYNC] Error:", err.message);
        return readAssets();
    }
};

// --- ASSETS ENDPOINTS ---

// List Assets (now Auto-Syncs)
app.get('/api/assets', (req, res) => {
    const freshAssets = syncAssets();
    res.json(freshAssets);
});

// Upload Asset
app.post('/api/assets/upload', upload.single('asset'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const relativePath = path.relative(path.join(__dirname, '..'), req.file.path);
    const assetRecord = {
        id: `asset_${Date.now()} `,
        name: req.body.name || req.file.originalname,
        type: req.file.mimetype.startsWith('video') ? 'video' : 'image',
        path: relativePath,
        filename: req.file.filename,
        timestamp: new Date().toISOString()
    };

    try {
        const assets = readAssets();
        assets.unshift(assetRecord);
        writeAssets(assets);
        res.json(assetRecord);
    } catch (err) {
        res.status(500).json({ error: "Failed to save asset record" });
    }
});

// Delete Asset
app.delete('/api/assets/:id', (req, res) => {
    const { id } = req.params;
    try {
        const assets = readAssets();
        const asset = assets.find(a => a.id === id);
        if (!asset) return res.status(404).json({ error: "Asset not found" });

        // Remove from DB
        const newAssets = assets.filter(a => a.id !== id);
        writeAssets(newAssets);

        // Remove from Disk
        const assetPath = path.join(__dirname, '..', asset.path);
        if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);

        // Remove associated transcription files if any
        if (asset.transcriptionPath) {
            const transPath = path.join(__dirname, '..', asset.transcriptionPath);
            if (fs.existsSync(transPath)) fs.unlinkSync(transPath);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- LOGO/STICKER OVERLAY ENDPOINTS ---

// Upload Sticker Image
const stickersDirRoot = path.join(__dirname, '..', 'stickers');
if (!fs.existsSync(stickersDirRoot)) fs.mkdirSync(stickersDirRoot, { recursive: true });

const stickerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, stickersDirRoot),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.png';
        cb(null, `sticker_${Date.now()}${ext}`);
    }
});
const stickerUpload = multer({ storage: stickerStorage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

app.post('/api/upload-sticker', stickerUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const absolutePath = req.file.path;
    console.log(`[STICKER] Uploaded: ${absolutePath}`);
    res.json({ path: absolutePath, filename: req.file.filename });
});

// Upload Logo
app.post('/api/logos/upload', upload.single('logo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const relativePath = path.relative(path.join(__dirname, '..'), req.file.path);
    const logoRecord = {
        id: `logo_${Date.now()}`,
        name: req.body.name || req.file.originalname.replace(/\.[^.]+$/, ''),
        path: relativePath,
        filename: req.file.filename,
        mimetype: req.file.mimetype,
        timestamp: new Date().toISOString()
    };

    try {
        const logos = readLogos();
        logos.unshift(logoRecord);
        writeLogos(logos);
        res.json(logoRecord);
    } catch (err) {
        res.status(500).json({ error: "Failed to save logo record" });
    }
});

// List Logos
app.get('/api/logos', (req, res) => {
    try {
        res.json(readLogos());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Logo
app.delete('/api/logos/:id', (req, res) => {
    const { id } = req.params;
    try {
        const logos = readLogos();
        const logo = logos.find(l => l.id === id);
        if (!logo) return res.status(404).json({ error: "Logo not found" });

        const newLogos = logos.filter(l => l.id !== id);
        writeLogos(newLogos);

        const logoPath = path.join(__dirname, '..', logo.path);
        if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Update Asset Transcript
app.patch('/api/assets/:id/transcript', async (req, res) => {
    const { id } = req.params;
    const { text, segments, language } = req.body;

    try {
        const assets = readAssets();
        const asset = assets.find(a => a.id === id);
        if (!asset) return res.status(404).json({ error: "Asset not found" });

        if (!asset.transcriptionPath) {
            return res.status(400).json({ error: "No existing transcript for this asset" });
        }

        const transPath = path.resolve(__dirname, '..', asset.transcriptionPath);

        // Ensure directory exists (it should)
        const dir = path.dirname(transPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Save to JSON file
        const data = {
            text,
            segments,
            language: language || 'en',
            lastUpdated: new Date().toISOString()
        };

        fs.writeFileSync(transPath, JSON.stringify(data, null, 2));

        res.json({ success: true, message: "Transcript updated" });
    } catch (err) {
        console.error("Failed to update transcript:", err);
        res.status(500).json({ error: err.message });
    }
});

const transcriptionQueue = [];
let isTranscribing = false;

const processTranscriptionQueue = async () => {
    if (isTranscribing || transcriptionQueue.length === 0) return;

    isTranscribing = true;
    const { assetId, jobId } = transcriptionQueue.shift();

    console.log(`[QUEUE] Processing transcription for job ${jobId}`);

    // Update Status to Processing so Frontend continues polling
    if (transcriptionJobs[jobId]) {
        transcriptionJobs[jobId].status = 'processing';
    }

    // --- ACTUAL TRANSCRIPTION LOGIC ---
    try {
        const assets = readAssets();
        const asset = assets.find(a => a.id === assetId);

        if (!asset) {
            if (transcriptionJobs[jobId]) {
                transcriptionJobs[jobId].status = 'failed';
                transcriptionJobs[jobId].logs.push("Asset not found during processing");
            }
            isTranscribing = false;
            processTranscriptionQueue();
            return;
        }

        const assetPath = path.join(__dirname, '..', asset.path);
        const baseName = path.basename(asset.filename, path.extname(asset.filename));

        // Wait 2 seconds for VTT file to be fully written by OS/yt-dlp
        await new Promise(r => setTimeout(r, 2000));

        // --- SECOND VTT CHECK (Race Condition Fix) ---
        // often the download finishes but VTT is written a split second later.
        // We check here again before launching heavy python.
        let potentialVtts = [];
        try {
            if (fs.existsSync(assetsDirRoot)) {
                const allFiles = fs.readdirSync(assetsDirRoot);
                potentialVtts = allFiles.filter(f => f.startsWith(baseName) && f.endsWith('.vtt'));
            }
        } catch (e) { console.warn("Queue VTT scan error:", e); }

        if (potentialVtts.length > 0) {
            // Use pickBestVtt so alphabetical ordering (e.g. ar < id) doesn't
            // accidentally select a wrong-language auto-sub track.
            const chosenVtt = pickBestVtt(potentialVtts, asset.language || null);
            const vttPath = path.join(assetsDirRoot, chosenVtt);
            console.log(`[QUEUE] Selected VTT: ${chosenVtt} (detected lang: ${detectLangFromVttFilename(chosenVtt)})`);
            console.log(`[QUEUE] Found native VTT late: ${chosenVtt}`);

            // ... VTT Parsing Logic ...
            try {
                const vttContent = fs.readFileSync(vttPath, 'utf-8');
                const lines = vttContent.split(/\r?\n/);
                let textParts = [];
                let seenLines = new Set();
                lines.forEach(line => {
                    line = line.trim();
                    if (line === 'WEBVTT' || line === '' || line.includes('-->') || /^\d+$/.test(line) || line.startsWith('NOTE')) return;
                    const cleaned = cleanVttLine(line);
                    if (cleaned && !seenLines.has(cleaned)) { seenLines.add(cleaned); textParts.push(cleaned); }
                });

                const fullText = textParts.join(' ');
                const jsonFilename = `${baseName}_transcript.json`;
                const jsonPath = path.join(transcriptsDir, jsonFilename);
                const detectedLang = detectLangFromVttFilename(chosenVtt);
                fs.writeFileSync(jsonPath, JSON.stringify({ text: fullText, language: detectedLang }, null, 2));

                asset.transcriptionPath = `assets/transcripts/${jsonFilename}`;
                asset.hasAudio = true;
                asset.hasSubtitle = true;
                // Backfill language if not set (e.g. when YouTube metadata didn't return it)
                if (!asset.language && detectedLang && detectedLang !== 'unknown') {
                    asset.language = detectedLang;
                    console.log(`[QUEUE] Backfilled asset language from VTT: ${detectedLang}`);
                }
                const newAssets = readAssets();
                const idx = newAssets.findIndex(a => a.id === assetId);
                if (idx !== -1) newAssets[idx] = asset;
                writeAssets(newAssets);

                if (transcriptionJobs[jobId]) {
                    transcriptionJobs[jobId].status = 'completed';
                    transcriptionJobs[jobId].logs.push(`[SUCCESS] Found Native VTT in queue. Handled (lang: ${detectedLang}).`);
                }
                isTranscribing = false;
                processTranscriptionQueue();
                return;
            } catch (vttErr) {
                console.error("Queue VTT parse error, falling back to Python:", vttErr);
            }
        }

        // START BACKGROUND WORK
        const jsonFilename = `${baseName}_transcript.json`;
        const jsonPath = path.join(transcriptsDir, jsonFilename);

        // Determine Whisper model from request or default to 'base'
        const whisperModel = (req && req.body && req.body.whisperModel) || 'base';
        const pythonScript = `
import sys
import json
import os
import subprocess
import site

def ensure_whisperx():
    try:
        import whisperx
        return whisperx
    except ImportError:
        print(json.dumps({ "status": "installing", "msg": "Installing WhisperX... (first time only, ~2min)" }), flush=True)
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "whisperx"], stdout=subprocess.DEVNULL)
        # Add user site-packages to path so freshly installed package is findable
        site.addsitedir(site.getusersitepackages())
        import whisperx
        return whisperx

def patch_torch_load():
    import torch
    if hasattr(torch, '_original_load'):
        return
    torch._original_load = torch.load
    def _patched_load(*args, **kwargs):
        kwargs['weights_only'] = False
        return torch._original_load(*args, **kwargs)
    torch.load = _patched_load

try:
    import torch
    patch_torch_load()
    whisperx = ensure_whisperx()

    file_path = sys.argv[1]
    output_path = sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 else "base"
    lang_hint = sys.argv[4] if len(sys.argv) > 4 else None
    if lang_hint and lang_hint.lower() in ('', 'null', 'unknown', 'undefined'):
        lang_hint = None
    device = "cpu"
    compute_type = "int8"

    if lang_hint:
        print(json.dumps({ "status": "loading", "msg": f"Loading WhisperX ({model_name}, lang={lang_hint})..." }), flush=True)
        model = whisperx.load_model(model_name, device, compute_type=compute_type, language=lang_hint)
    else:
        print(json.dumps({ "status": "loading", "msg": f"Loading WhisperX ({model_name}, detecting language)..." }), flush=True)
        model = whisperx.load_model(model_name, device, compute_type=compute_type)

    print(json.dumps({ "status": "transcribing", "msg": "Transcribing audio..." }), flush=True)
    audio = whisperx.load_audio(file_path)
    result = model.transcribe(audio)

    # Align for precise word-level timestamps (gracefully skip for unsupported languages)
    lang = result.get("language", "en")
    aligned = None
    try:
        print(json.dumps({ "status": "aligning", "msg": f"Aligning words (lang={lang})..." }), flush=True)
        align_model, metadata = whisperx.load_align_model(language_code=lang, device=device)
        aligned = whisperx.align(result["segments"], align_model, metadata, audio, device)
    except Exception as align_err:
        print(json.dumps({ "status": "warning", "msg": f"Word alignment unavailable for '{lang}' — using segment-level timestamps. ({align_err})" }), flush=True)

    # Use aligned result if available, otherwise fall back to raw transcription segments
    source_segments = aligned["segments"] if aligned else result.get("segments", [])
    full_text = " ".join(s.get("text", "") for s in source_segments)
    output = {
        "text": full_text,
        "language": lang,
        "method": f"whisperx-{model_name}",
        "segments": []
    }

    for seg in source_segments:
        segment_data = {
            "start": seg.get("start", 0),
            "end": seg.get("end", 0),
            "text": seg.get("text", ""),
            "words": []
        }
        for w in seg.get("words", []):
            if "start" in w and "end" in w:
                segment_data["words"].append({
                    "word": w.get("word", "").strip(),
                    "start": w["start"],
                    "end": w["end"],
                    "probability": w.get("score", 0)
                })
        output["segments"].append(segment_data)

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    word_count = sum(len(s["words"]) for s in output["segments"])
    print(json.dumps({ "status": "success", "msg": f"Done! {word_count} words with precise timestamps.", "text_snippet": full_text[:50] }), flush=True)

except Exception as e:
    print(json.dumps({ "status": "error", "message": str(e) }), flush=True)
`;
        const scriptPath = path.join(__dirname, `transcribe_${jobId}.py`);
        fs.writeFileSync(scriptPath, pythonScript);

        // Use pickBestVtt so the WhisperX lang hint matches the actual VTT we chose above
        const langHint = potentialVtts.length > 0 ? detectLangFromVttFilename(pickBestVtt(potentialVtts, asset.language || null)) : '';
        const pythonProcess = spawn(pythonBinaryPath, [scriptPath, assetPath, jsonPath, whisperModel, langHint || '']);

        pythonProcess.stdout.on('data', (data) => {
            const str = data.toString();
            console.log(`[WHISPER] ${str}`);
            try {
                const jsonLog = JSON.parse(str);
                if (transcriptionJobs[jobId]) {
                    transcriptionJobs[jobId].logs.push(jsonLog.msg || str);
                }
            } catch (e) {
                if (transcriptionJobs[jobId]) transcriptionJobs[jobId].logs.push(str);
            }
        });

        pythonProcess.stderr.on('data', (data) => {
            console.error(`[WHISPER-ERR] ${data}`);
            if (transcriptionJobs[jobId]) transcriptionJobs[jobId].logs.push(`ERR: ${data}`);
        });

        pythonProcess.on('close', (code) => {
            fs.unlinkSync(scriptPath);

            if (code === 0 && fs.existsSync(jsonPath)) {
                // Update Asset
                const updatedAssets = readAssets();
                const currentAsset = updatedAssets.find(a => a.id === assetId);
                if (currentAsset) {
                    currentAsset.transcriptionPath = `assets/transcripts/${jsonFilename}`;
                    currentAsset.hasAudio = true;
                    currentAsset.hasSubtitle = true;
                    writeAssets(updatedAssets);
                }

                if (transcriptionJobs[jobId]) {
                    transcriptionJobs[jobId].status = 'completed';
                    transcriptionJobs[jobId].logs.push("Transcription saved.");
                }
            } else {
                if (transcriptionJobs[jobId]) {
                    transcriptionJobs[jobId].status = 'failed';
                    transcriptionJobs[jobId].logs.push("Transcription process failed.");
                }
            }

            // NEXT!
            isTranscribing = false;
            processTranscriptionQueue();

            // Cleanup job after 1 hour
            setTimeout(() => delete transcriptionJobs[jobId], 3600000);
        });

    } catch (err) {
        console.error("Transcription Startup Error:", err);
        if (transcriptionJobs[jobId]) {
            transcriptionJobs[jobId].status = 'failed';
            let friendlyError;
            if (err.message?.includes('python') || err.message?.includes('spawn')) {
                friendlyError = 'Python is not installed or not found. Transcription requires Python 3 with WhisperX. Please install Python from python.org and run: pip install whisperx';
            } else if (err.code) {
                friendlyError = parseFileError(err);
            } else {
                friendlyError = `Transcription failed to start: ${err.message}`;
            }
            transcriptionJobs[jobId].logs.push(friendlyError);
            transcriptionJobs[jobId].error = friendlyError;
        }
        isTranscribing = false;
        processTranscriptionQueue();
    }
};

app.post('/api/transcribe/:id', async (req, res) => {
    const { id } = req.params;
    const assets = readAssets();
    const asset = assets.find(a => a.id === id);
    if (!asset) return res.status(404).json({ error: "Asset not found" });

    const assetPath = path.join(__dirname, '..', asset.path);
    if (!fs.existsSync(assetPath)) return res.status(404).json({ error: "File not found on disk" });

    // --- CHECK FOR NATIVE YOUTUBE CAPTIONS (VTT) ---
    const baseName = path.basename(asset.filename, path.extname(asset.filename));

    // Scan directory for ANY VTT that matches the base filename (start with)
    // Relaxed matching: just needs to start with basename and include 'en' or just exist
    let potentialVtts = [];
    try {
        const allFiles = fs.readdirSync(assetsDirRoot);
        potentialVtts = allFiles.filter(f => f.startsWith(baseName) && f.endsWith('.vtt'));
        console.log(`[DEBUG VTT] Asset=${asset.filename} Base=${baseName} Found=${potentialVtts.length} Files=[${potentialVtts.join(', ')}]`);
    } catch (e) {
        console.warn("Could not scan for VTTs:", e);
    }

    if (potentialVtts.length > 0) {
        // Use pickBestVtt: honour explicit language from request body, then prefer
        // common content languages over accidental ar/hi/ru auto-sub tracks.
        const chosenVtt = pickBestVtt(potentialVtts, req.body.language || null);
        const vttPath = path.join(assetsDirRoot, chosenVtt);
        console.log(`[TRANSCRIPTION] Selected VTT: ${chosenVtt} (detected lang: ${detectLangFromVttFilename(chosenVtt)})`);

        console.log(`[TRANSCRIPTION] Found native VTT: ${chosenVtt}. Parsing...`);

        try {
            const vttContent = fs.readFileSync(vttPath, 'utf-8');
            const lines = vttContent.split(/\r?\n/);
            let segments = [];
            let currentSegment = null;

            // Regex for VTT timestamp: 00:00:00.000 --> 00:00:05.000
            const timeRegex = /(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/;

            lines.forEach(line => {
                line = line.trim();
                const timeMatch = line.match(timeRegex);

                if (timeMatch) {
                    // New segment
                    if (currentSegment) segments.push(currentSegment);
                    currentSegment = {
                        start: timeMatch[1],
                        end: timeMatch[2],
                        text: ''
                    };
                } else if (currentSegment && line !== '' && line !== 'WEBVTT' && !/^\d+$/.test(line) && !line.includes('-->')) {
                    // Append text to current segment
                    const cleanedLine = cleanVttLine(line);
                    if (cleanedLine) {
                        currentSegment.text += (currentSegment.text ? ' ' : '') + cleanedLine;
                    }
                }
            });
            if (currentSegment) segments.push(currentSegment);

            const fullText = segments.map(s => s.text).join(' ');
            const jsonFilename = `${baseName}_transcript.json`;
            const jsonPath = path.join(transcriptsDir, jsonFilename);

            // Save structured data compatible with Whisper result format
            const detectedLang = detectLangFromVttFilename(chosenVtt);
            fs.writeFileSync(jsonPath, JSON.stringify({
                text: fullText,
                segments: segments, // Add structured segments
                language: detectedLang
            }, null, 2));

            // Update Asset
            asset.transcriptionPath = `assets/transcripts/${jsonFilename}`;
            asset.hasAudio = true;
            asset.hasSubtitle = true;
            // Backfill language if not set (e.g. when YouTube metadata didn't return it)
            if (!asset.language && detectedLang && detectedLang !== 'unknown') {
                asset.language = detectedLang;
                console.log(`[TRANSCRIPTION] Backfilled asset language from VTT: ${detectedLang}`);
            }
            const updatedAssets = readAssets();
            const idx = updatedAssets.findIndex(a => a.id === id);
            if (idx !== -1) updatedAssets[idx] = asset;
            writeAssets(updatedAssets);

            // Return "fake" job for completion
            const jobId = `job_native_${Date.now()}`;
            transcriptionJobs[jobId] = {
                id: jobId,
                status: 'completed',
                logs: [
                    `[INFO] Native subtitles found: ${chosenVtt} (lang: ${detectedLang})`,
                    `[SUCCESS] Skipped Whisper. Using native transcript.`
                ],
                progress: 100
            };
            return res.json({ success: true, jobId, message: "Use native transcript" });
        } catch (e) {
            console.error("VTT processing failed, falling back to Whisper:", e);
        }
    }

    // Job Setup
    const jobId = `job_transcribe_${Date.now()}`;
    const jsonFilename = `${baseName}_transcript.json`;
    const jsonPath = path.join(transcriptsDir, jsonFilename);

    transcriptionJobs[jobId] = {
        id: jobId,
        assetId: id,
        status: 'processing',
        logs: [`[INFO] Native subtitles not found for ${baseName}.`],
        progress: 0
    };

    // Return immediately
    res.json({ success: true, jobId, message: "Transcription started in background" });

    console.log(`[TRANSCRIBE] Starting job ${jobId} for: ${asset.name}`);

    // --- BACKGROUND PROCESS WITH WATERFALL ---
    (async () => {
        const updateJob = (status, log, progress = null) => {
            if (transcriptionJobs[jobId]) {
                if (status) transcriptionJobs[jobId].status = status;
                if (log) transcriptionJobs[jobId].logs.push(log);
                if (progress !== null) transcriptionJobs[jobId].progress = progress;
            }
        };

        const saveTranscript = (text, segments = [], method = 'unknown', lang = 'unknown') => {
            fs.writeFileSync(jsonPath, JSON.stringify({
                text,
                segments,
                language: lang,
                method
            }, null, 2));

            // Update Asset
            const updatedAssets = readAssets();
            const currentAsset = updatedAssets.find(a => a.id === id);
            if (currentAsset) {
                currentAsset.transcriptionPath = `assets/transcripts/${jsonFilename}`;
                currentAsset.hasAudio = true;
                currentAsset.hasSubtitle = true;
                writeAssets(updatedAssets);
            }
            updateJob('completed', `[SUCCESS] Transcription saved via ${method}.`, 100);
        };

        // ============================================================
        // STEP 1: Try Gemini Transcription (Reliable, Fast)
        // ============================================================
        // Check for API key in headers (Express lowercases headers)
        const geminiKey = req.headers['x-gemini-key'] || req.get('x-gemini-key') || process.env.GEMINI_API_KEY;
        // Use the same model variant that user selected in settings
        const geminiVariant = req.headers['x-gemini-variant'] || req.get('x-gemini-variant') || 'gemini-2.0-flash';

        console.log(`[TRANSCRIBE] Gemini key present: ${geminiKey ? 'Yes (' + geminiKey.slice(0, 8) + '...)' : 'No'}`);
        console.log(`[TRANSCRIBE] Using Gemini model: ${geminiVariant}`);

        if (geminiKey && geminiKey.length > 10) {
            updateJob(null, `[STEP 1] Trying Gemini AI transcription (${geminiVariant})...`, 10);
            console.log(`[TRANSCRIBE] Attempting Gemini transcription for ${asset.name}`);

            try {
                // Extract audio from video using ffmpeg
                const audioPath = path.join(__dirname, `temp_audio_${jobId}.mp3`);
                updateJob(null, '[GEMINI] Extracting audio from video...', 20);

                await new Promise((resolve, reject) => {
                    const ffmpegProc = spawn(ffmpegBinaryPath, [
                        '-i', assetPath,
                        '-vn',                    // No video
                        '-acodec', 'libmp3lame',  // MP3 codec
                        '-ab', '64k',             // Low bitrate for smaller file
                        '-ar', '16000',           // 16kHz sample rate (good for speech)
                        '-ac', '1',               // Mono
                        '-y',                     // Overwrite
                        audioPath
                    ], { stdio: ['ignore', 'pipe', 'pipe'] });

                    ffmpegProc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit code ${code}`)));
                    ffmpegProc.on('error', reject);
                });

                if (!fs.existsSync(audioPath)) {
                    throw new Error('Audio extraction failed');
                }

                updateJob(null, `[GEMINI] Sending audio to ${geminiVariant}...`, 40);

                // Read audio file as base64
                const audioBuffer = fs.readFileSync(audioPath);
                const audioBase64 = audioBuffer.toString('base64');
                const audioSizeKB = Math.round(audioBuffer.length / 1024);
                console.log(`[TRANSCRIBE] Audio extracted: ${audioSizeKB}KB`);

                // Send to Gemini - use the user's selected model variant
                const { GoogleGenerativeAI } = require('@google/generative-ai');
                const geminiClient = new GoogleGenerativeAI(geminiKey);
                const model = geminiClient.getGenerativeModel({ model: geminiVariant });

                const result = await model.generateContent([
                    {
                        inlineData: {
                            mimeType: 'audio/mp3',
                            data: audioBase64
                        }
                    },
                    {
                        text: `Transcribe this audio accurately. Return ONLY the transcription text, no timestamps or formatting. If the audio is in a non-English language, transcribe it in that language.`
                    }
                ]);

                const transcriptText = result.response.text().trim();

                // Cleanup temp audio
                fs.unlinkSync(audioPath);

                if (transcriptText && transcriptText.length > 10) {
                    updateJob(null, `[GEMINI] Transcription complete! (${transcriptText.length} chars)`, 90);

                    // Create simple segments (no timestamps from Gemini basic transcription)
                    const segments = [{
                        start: '00:00:00.000',
                        end: '00:00:00.000',
                        text: transcriptText
                    }];

                    saveTranscript(transcriptText, segments, 'gemini');
                    console.log(`[TRANSCRIBE] Gemini transcription successful for ${asset.name}`);
                    setTimeout(() => delete transcriptionJobs[jobId], 3600000);
                    return; // SUCCESS - exit waterfall
                } else {
                    throw new Error('Gemini returned empty or too short transcription');
                }

            } catch (geminiErr) {
                // Cleanup temp audio if it exists
                const audioPath = path.join(__dirname, `temp_audio_${jobId}.mp3`);
                try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch (e) { }

                // Simplify error message for user
                let errorMsg = geminiErr.message;
                if (errorMsg.includes('API_KEY_INVALID') || errorMsg.includes('API key not valid')) {
                    errorMsg = 'Invalid API key. Please check your Gemini API key in Settings.';
                } else if (errorMsg.includes('RESOURCE_EXHAUSTED')) {
                    errorMsg = 'Gemini rate limit reached. Please wait a moment.';
                }

                console.error(`[TRANSCRIBE] Gemini failed:`, geminiErr.message);
                updateJob(null, `[GEMINI] ${errorMsg} Trying Whisper...`, 50);
                // Continue to Whisper fallback
            }
        } else {
            updateJob(null, '[SKIP] No Gemini API key. Trying Whisper...', 50);
        }

        // ============================================================
        // STEP 2: Fallback to Whisper (Local Python) with word-level timestamps
        // ============================================================
        const whisperModelFallback = (req.body && req.body.whisperModel) || req.headers['x-whisper-model'] || 'base';
        updateJob(null, `[STEP 2] Starting Whisper AI (${whisperModelFallback} model, word-level timestamps)...`, 55);
        console.log(`[TRANSCRIBE] Falling back to Whisper (${whisperModelFallback}) for ${asset.name}`);

        try {
            const pythonScript = `
import sys
import json
import subprocess
import site

def ensure_whisperx():
    try:
        import whisperx
        return whisperx
    except ImportError:
        print(json.dumps({ "status": "installing", "msg": "Installing WhisperX... (first time only, ~2min)" }), flush=True)
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "whisperx"], stdout=subprocess.DEVNULL)
        site.addsitedir(site.getusersitepackages())
        import whisperx
        return whisperx

def patch_torch_load():
    import torch
    if hasattr(torch, '_original_load'):
        return
    torch._original_load = torch.load
    def _patched_load(*args, **kwargs):
        kwargs['weights_only'] = False
        return torch._original_load(*args, **kwargs)
    torch.load = _patched_load

try:
    import torch
    patch_torch_load()
    whisperx = ensure_whisperx()

    file_path = sys.argv[1]
    output_path = sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 else "base"
    lang_hint = sys.argv[4] if len(sys.argv) > 4 else None
    if lang_hint and lang_hint.lower() in ('', 'null', 'unknown', 'undefined'):
        lang_hint = None
    device = "cpu"
    compute_type = "int8"

    if lang_hint:
        print(json.dumps({ "status": "loading", "msg": f"Loading WhisperX ({model_name}, lang={lang_hint})..." }), flush=True)
        model = whisperx.load_model(model_name, device, compute_type=compute_type, language=lang_hint)
    else:
        print(json.dumps({ "status": "loading", "msg": f"Loading WhisperX ({model_name}, detecting language)..." }), flush=True)
        model = whisperx.load_model(model_name, device, compute_type=compute_type)

    print(json.dumps({ "status": "transcribing", "msg": "Transcribing audio..." }), flush=True)
    audio = whisperx.load_audio(file_path)
    result = model.transcribe(audio)

    lang = result.get("language", "en")
    aligned = None
    try:
        print(json.dumps({ "status": "aligning", "msg": f"Aligning words (lang={lang})..." }), flush=True)
        align_model, metadata = whisperx.load_align_model(language_code=lang, device=device)
        aligned = whisperx.align(result["segments"], align_model, metadata, audio, device)
    except Exception as align_err:
        print(json.dumps({ "status": "warning", "msg": f"Word alignment unavailable for '{lang}' — using segment-level timestamps. ({align_err})" }), flush=True)

    source_segments = aligned["segments"] if aligned else result.get("segments", [])
    full_text = " ".join(s.get("text", "") for s in source_segments)
    output = {
        "text": full_text,
        "language": lang,
        "method": f"whisperx-{model_name}",
        "segments": []
    }

    for seg in source_segments:
        segment_data = {
            "start": seg.get("start", 0),
            "end": seg.get("end", 0),
            "text": seg.get("text", ""),
            "words": []
        }
        for w in seg.get("words", []):
            if "start" in w and "end" in w:
                segment_data["words"].append({
                    "word": w.get("word", "").strip(),
                    "start": w["start"],
                    "end": w["end"],
                    "probability": w.get("score", 0)
                })
        output["segments"].append(segment_data)

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    word_count = sum(len(s["words"]) for s in output["segments"])
    print(json.dumps({ "status": "success", "msg": f"Done! {word_count} words with precise timestamps.", "text_snippet": full_text[:50] }), flush=True)

except Exception as e:
    print(json.dumps({ "status": "error", "message": str(e) }), flush=True)
    sys.exit(1)
`;
            const scriptPath = path.join(__dirname, `transcribe_${jobId}.py`);
            fs.writeFileSync(scriptPath, pythonScript);

            // Language hint: from request body, header, or best VTT (not potentialVtts[0] — alphabetical order can pick wrong language)
            const langHint2 = (req.body && req.body.language) || req.headers['x-language'] || (potentialVtts.length > 0 ? detectLangFromVttFilename(pickBestVtt(potentialVtts, (req.body && req.body.language) || null)) : '') || '';
            const pythonProcess = spawn(pythonBinaryPath, [scriptPath, assetPath, jsonPath, whisperModelFallback, langHint2], {
                timeout: 300000 // 5 minute timeout
            });

            pythonProcess.stdout.on('data', (data) => {
                const str = data.toString().trim();
                console.log(`[WHISPER] ${str}`);
                try {
                    const jsonLog = JSON.parse(str);
                    updateJob(null, jsonLog.msg || str);
                } catch (e) {
                    updateJob(null, str);
                }
            });

            pythonProcess.stderr.on('data', (data) => {
                const str = data.toString().trim();
                console.error(`[WHISPER-ERR] ${str}`);
                // Don't spam logs with Python warnings
                if (!str.includes('FutureWarning') && !str.includes('UserWarning')) {
                    updateJob(null, `[WARN] ${str.slice(0, 100)}`);
                }
            });

            pythonProcess.on('close', (code) => {
                try { fs.unlinkSync(scriptPath); } catch (e) { }

                if (code === 0 && fs.existsSync(jsonPath)) {
                    // Update Asset
                    const updatedAssets = readAssets();
                    const currentAsset = updatedAssets.find(a => a.id === id);
                    if (currentAsset) {
                        currentAsset.transcriptionPath = `assets/transcripts/${jsonFilename}`;
                        currentAsset.hasAudio = true;
                        currentAsset.hasSubtitle = true;
                        writeAssets(updatedAssets);
                    }
                    updateJob('completed', '[SUCCESS] Whisper transcription saved.', 100);
                } else {
                    updateJob('failed', '[FAILED] WhisperX transcription failed. Please ensure Python and whisperx are installed.', 100);
                }

                setTimeout(() => delete transcriptionJobs[jobId], 3600000);
            });

            pythonProcess.on('error', (err) => {
                console.error(`[WHISPER] Process error:`, err);
                updateJob('failed', `[FAILED] Whisper not available: ${err.message}`, 100);
                setTimeout(() => delete transcriptionJobs[jobId], 3600000);
            });

        } catch (err) {
            console.error("Transcription Startup Error:", err);
            updateJob('failed', `[FAILED] Startup Error: ${err.message}`, 100);
            setTimeout(() => delete transcriptionJobs[jobId], 3600000);
        }
    })();
});

// Transcription Status
app.get('/api/transcribe/status/:id', (req, res) => {
    const job = transcriptionJobs[req.params.id];
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
});


// ==========================================
// WHISPER TRANSCRIPTION FOR YOUTUBE VIDEOS
// Runs Whisper on downloaded YouTube video for accurate word-level captions
// ==========================================
app.post('/api/youtube/transcribe', async (req, res) => {
    const { videoPath, whisperModel = 'base', language = '' } = req.body;

    if (!videoPath) {
        return res.status(400).json({ error: 'videoPath is required' });
    }

    // Resolve the full path
    const fullVideoPath = path.isAbsolute(videoPath) ? videoPath : path.join(__dirname, '..', videoPath);

    if (!fs.existsSync(fullVideoPath)) {
        return res.status(404).json({ error: `Video file not found: ${videoPath}` });
    }

    const baseName = path.basename(fullVideoPath, path.extname(fullVideoPath));
    const jobId = `job_yt_whisper_${Date.now()}`;
    const transcriptsDir = path.join(__dirname, '..', 'assets', 'transcripts');
    if (!fs.existsSync(transcriptsDir)) {
        fs.mkdirSync(transcriptsDir, { recursive: true });
    }
    const jsonFilename = `${baseName}_whisper_transcript.json`;
    const jsonPath = path.join(transcriptsDir, jsonFilename);

    // Check if Whisper transcript already exists and has word-level data
    if (fs.existsSync(jsonPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            const hasWords = existing.segments && existing.segments.some(s => s.words && s.words.length > 0);
            if (hasWords) {
                console.log(`[YT-WHISPER] Found existing word-level transcript: ${jsonPath}`);
                transcriptionJobs[jobId] = {
                    id: jobId,
                    status: 'completed',
                    logs: ['[CACHED] Using existing Whisper transcript with word-level timestamps.'],
                    progress: 100,
                    transcriptPath: jsonPath,
                    method: 'whisper-cached'
                };
                return res.json({ success: true, jobId, cached: true, transcriptPath: jsonPath });
            }
        } catch (e) {
            // Existing file is invalid, proceed with new transcription
        }
    }

    transcriptionJobs[jobId] = {
        id: jobId,
        status: 'processing',
        logs: [`[INFO] Starting Whisper (${whisperModel}) transcription for YouTube video...`],
        progress: 0,
        transcriptPath: null,
        method: `whisper-${whisperModel}`
    };

    res.json({ success: true, jobId, message: `Whisper transcription started (${whisperModel} model)` });

    // Background processing
    (async () => {
        const updateJob = (status, log, progress = null) => {
            if (transcriptionJobs[jobId]) {
                if (status) transcriptionJobs[jobId].status = status;
                if (log) transcriptionJobs[jobId].logs.push(log);
                if (progress !== null) transcriptionJobs[jobId].progress = progress;
            }
        };

        try {
            // Step 1: Extract audio from video for faster Whisper processing
            const audioPath = path.join(__dirname, `temp_yt_audio_${jobId}.mp3`);
            updateJob(null, '[STEP 1] Extracting audio from video...', 10);

            await new Promise((resolve, reject) => {
                const ffmpegProc = spawn(ffmpegBinaryPath, [
                    '-i', fullVideoPath,
                    '-vn',                    // No video
                    '-acodec', 'libmp3lame',
                    '-ab', '64k',             // 64kbps (sufficient for speech recognition)
                    '-ar', '16000',           // 16kHz (optimal for Whisper)
                    '-ac', '1',               // Mono
                    '-y',
                    audioPath
                ], { stdio: ['ignore', 'pipe', 'pipe'] });

                ffmpegProc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit code ${code}`)));
                ffmpegProc.on('error', reject);
            });

            if (!fs.existsSync(audioPath)) {
                throw new Error('Audio extraction failed');
            }

            const audioSizeKB = Math.round(fs.statSync(audioPath).size / 1024);
            updateJob(null, `[STEP 1] Audio extracted (${audioSizeKB}KB). Starting Whisper...`, 25);

            // Step 2: Run Whisper with word_timestamps=True
            const pythonScript = `
import sys
import json
import subprocess
import site

def ensure_whisperx():
    try:
        import whisperx
        return whisperx
    except ImportError:
        print(json.dumps({ "status": "installing", "msg": "Installing WhisperX... (first time only, ~2min)" }), flush=True)
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "whisperx"], stdout=subprocess.DEVNULL)
        site.addsitedir(site.getusersitepackages())
        import whisperx
        return whisperx

def patch_torch_load():
    import torch
    if hasattr(torch, '_original_load'):
        return
    torch._original_load = torch.load
    def _patched_load(*args, **kwargs):
        kwargs['weights_only'] = False
        return torch._original_load(*args, **kwargs)
    torch.load = _patched_load

try:
    import torch
    patch_torch_load()
    whisperx = ensure_whisperx()

    file_path = sys.argv[1]
    output_path = sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 else "base"
    lang_hint = sys.argv[4] if len(sys.argv) > 4 else None
    if lang_hint and lang_hint.lower() in ('', 'null', 'unknown', 'undefined'):
        lang_hint = None
    device = "cpu"
    compute_type = "int8"

    if lang_hint:
        print(json.dumps({ "status": "loading", "msg": f"Loading WhisperX ({model_name}, lang={lang_hint})..." }), flush=True)
        model = whisperx.load_model(model_name, device, compute_type=compute_type, language=lang_hint)
    else:
        print(json.dumps({ "status": "loading", "msg": f"Loading WhisperX ({model_name}, detecting language)..." }), flush=True)
        model = whisperx.load_model(model_name, device, compute_type=compute_type)

    print(json.dumps({ "status": "transcribing", "msg": "Transcribing audio..." }), flush=True)
    audio = whisperx.load_audio(file_path)
    result = model.transcribe(audio)

    lang = result.get("language", "en")
    aligned = None
    try:
        print(json.dumps({ "status": "aligning", "msg": f"Aligning words (lang={lang})..." }), flush=True)
        align_model, metadata = whisperx.load_align_model(language_code=lang, device=device)
        aligned = whisperx.align(result["segments"], align_model, metadata, audio, device)
    except Exception as align_err:
        print(json.dumps({ "status": "warning", "msg": f"Word alignment unavailable for '{lang}' — using segment-level timestamps. ({align_err})" }), flush=True)

    source_segments = aligned["segments"] if aligned else result.get("segments", [])
    full_text = " ".join(s.get("text", "") for s in source_segments)
    output = {
        "text": full_text,
        "language": lang,
        "method": f"whisperx-{model_name}",
        "segments": []
    }

    for seg in source_segments:
        segment_data = {
            "start": seg.get("start", 0),
            "end": seg.get("end", 0),
            "text": seg.get("text", ""),
            "words": []
        }
        for w in seg.get("words", []):
            if "start" in w and "end" in w:
                segment_data["words"].append({
                    "word": w.get("word", "").strip(),
                    "start": w["start"],
                    "end": w["end"],
                    "probability": w.get("score", 0)
                })
        output["segments"].append(segment_data)

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    word_count = sum(len(s["words"]) for s in output["segments"])
    seg_count = len(output["segments"])
    print(json.dumps({ "status": "success", "msg": f"Done! {word_count} words in {seg_count} segments (precise alignment)." }), flush=True)

except Exception as e:
    print(json.dumps({ "status": "error", "message": str(e) }), flush=True)
    sys.exit(1)
`;

            const scriptPath = path.join(__dirname, `yt_whisper_${jobId}.py`);
            fs.writeFileSync(scriptPath, pythonScript);

            // Language hint from frontend (YouTube metadata has language field)
            const langHint3 = (req.body && req.body.language) || '';
            const pythonProcess = spawn(pythonBinaryPath, [scriptPath, audioPath, jsonPath, whisperModel, langHint3], {
                timeout: 600000 // 10 minute timeout for longer YouTube videos
            });

            pythonProcess.stdout.on('data', (data) => {
                const str = data.toString().trim();
                console.log(`[YT-WHISPER] ${str}`);
                try {
                    const jsonLog = JSON.parse(str);
                    updateJob(null, jsonLog.msg || str, jsonLog.status === 'transcribing' ? 50 : null);
                } catch (e) {
                    updateJob(null, str);
                }
            });

            pythonProcess.stderr.on('data', (data) => {
                const str = data.toString().trim();
                if (!str.includes('FutureWarning') && !str.includes('UserWarning') && !str.includes('%|')) {
                    console.error(`[YT-WHISPER-ERR] ${str}`);
                }
            });

            pythonProcess.on('close', (code) => {
                // Cleanup temp files
                try { fs.unlinkSync(scriptPath); } catch (e) { }
                try { fs.unlinkSync(audioPath); } catch (e) { }

                if (code === 0 && fs.existsSync(jsonPath)) {
                    transcriptionJobs[jobId].transcriptPath = jsonPath;
                    updateJob('completed', `[SUCCESS] Whisper transcription saved with word-level timestamps.`, 100);
                    console.log(`[YT-WHISPER] Transcription complete: ${jsonPath}`);
                } else {
                    updateJob('failed', '[FAILED] WhisperX transcription failed. Ensure Python and whisperx are installed.', 100);
                }

                setTimeout(() => delete transcriptionJobs[jobId], 3600000);
            });

            pythonProcess.on('error', (err) => {
                // Cleanup
                try { fs.unlinkSync(scriptPath); } catch (e) { }
                try { fs.unlinkSync(audioPath); } catch (e) { }

                console.error(`[YT-WHISPER] Process error:`, err);
                updateJob('failed', `[FAILED] WhisperX not available: ${err.message}. Install with: pip install whisperx`, 100);
                setTimeout(() => delete transcriptionJobs[jobId], 3600000);
            });

        } catch (err) {
            console.error('[YT-WHISPER] Error:', err);
            updateJob('failed', `[FAILED] ${err.message}`, 100);
            setTimeout(() => delete transcriptionJobs[jobId], 3600000);
        }
    })();
});

app.post('/api/system/check-gemini', async (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ success: false, message: 'API Key missing' });

    // Use REST API to list models (Robust Validation)
    try {
        const response = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );

        if (response.status === 200 && response.data && response.data.models) {
            res.json({ success: true, modelCount: response.data.models.length });
        } else {
            throw new Error("Invalid response from Gemini API");
        }
    } catch (error) {
        console.error("Gemini Check Failed:", error.message);
        const msg = error.response?.data?.error?.message || error.message || 'API Key Invalid';
        res.status(400).json({ success: false, message: msg });
    }
});

// ==========================================
// CAPTION BLOCKS API (Opus-style captions)
// ==========================================
const { parseVttFile, findAndParseVttForVideo, addWordTimings, findAndParseWhisperForVideo } = require('./lib/parseVttToBlocks');

// Get caption blocks for an asset - prefers Whisper word-level data over VTT
app.get('/api/captions/:assetId', (req, res) => {
    const { assetId } = req.params;
    const preset = req.query.preset || 'karaoke';
    const preferWhisper = req.query.preferWhisper !== 'false'; // Default: prefer Whisper

    const assets = readAssets();
    const asset = assets.find(a => a.id === assetId);

    if (!asset) {
        return res.status(404).json({ error: 'Asset not found' });
    }

    const assetPath = path.join(assetsDirRoot, asset.filename);
    const appDir = path.join(__dirname, '..');

    // Try Whisper transcript first (has real word-level timestamps)
    if (preferWhisper) {
        const whisperResult = findAndParseWhisperForVideo(assetPath, appDir);
        if (whisperResult && whisperResult.blocks && whisperResult.blocks.length > 0) {
            const blocksWithPreset = whisperResult.blocks.map(block => ({ ...block, preset }));
            return res.json({
                blocks: blocksWithPreset,
                hasVtt: true,
                source: whisperResult.source,
                hasWordTimestamps: whisperResult.hasWordTimestamps,
                totalBlocks: blocksWithPreset.length
            });
        }
    }

    // Fallback to VTT (interpolated word timing)
    const result = findAndParseVttForVideo(assetPath);

    if (!result || !result.blocks) {
        return res.json({
            blocks: [],
            hasVtt: false,
            source: 'none',
            message: 'No VTT file found for this asset'
        });
    }

    // Add word-level timing (interpolated) and apply preset
    const blocksWithTiming = result.blocks.map(block => ({
        ...addWordTimings(block),
        preset
    }));

    res.json({
        blocks: blocksWithTiming,
        hasVtt: true,
        source: 'vtt',
        hasWordTimestamps: false,
        vttPath: result.vttPath,
        totalBlocks: blocksWithTiming.length
    });
});

// Get caption blocks for a clip (uses parent asset's VTT with time offset)
app.get('/api/captions/clip/:clipFilename', (req, res) => {
    const { clipFilename } = req.params;
    const preset = req.query.preset || 'karaoke';
    const startOffset = parseFloat(req.query.startTime) || 0;
    const endOffset = parseFloat(req.query.endTime) || Infinity;

    // Find the clip in history to get parent asset info
    const history = readHistory();
    let clip = null;
    let parentAsset = null;

    for (const project of history) {
        const found = project.clips?.find(c => c.localPath?.includes(clipFilename));
        if (found) {
            clip = found;
            parentAsset = project;
            break;
        }
    }

    if (!clip) {
        return res.status(404).json({ error: 'Clip not found' });
    }

    // Try to find VTT from the parent asset
    const baseName = path.basename(parentAsset.filename || '', path.extname(parentAsset.filename || ''));
    let vttPath = null;

    try {
        const allFiles = fs.readdirSync(assetsDirRoot);
        const vttFile = allFiles.find(f => f.startsWith(baseName) && f.endsWith('.vtt'));
        if (vttFile) {
            vttPath = path.join(assetsDirRoot, vttFile);
        }
    } catch (e) {
        console.warn('[CAPTIONS] Could not scan for VTT:', e.message);
    }

    if (!vttPath || !fs.existsSync(vttPath)) {
        return res.json({
            blocks: [],
            hasVtt: false,
            message: 'No VTT found for parent asset'
        });
    }

    const blocks = parseVttFile(vttPath);

    if (!blocks) {
        return res.json({ blocks: [], hasVtt: false });
    }

    // Filter blocks to clip time range and adjust timing
    const clipBlocks = blocks
        .filter(b => b.endTime > startOffset && b.startTime < endOffset)
        .map(block => ({
            ...addWordTimings({
                ...block,
                startTime: Math.max(0, block.startTime - startOffset),
                endTime: Math.min(endOffset - startOffset, block.endTime - startOffset)
            }),
            preset
        }));

    res.json({
        blocks: clipBlocks,
        hasVtt: true,
        totalBlocks: clipBlocks.length
    });
});

// ==========================================
// VERSION ENDPOINT
// ==========================================
app.get('/version', (req, res) => {
    res.json({
        version: APP_VERSION,
        name: 'Qlipper AI',
        releaseDate: '2026-02-22',
        changelog: [
            'v1.8 - React crash fixes (DOM mutation → React state)',
            'v1.8 - Settings modal scrollable on small screens',
            'v1.7 - YouTube 1080p H.264 download fix (removed VP9/WebM preference)',
            'v1.6.15 - Logo overlay, face-tracking, WhisperX word-level transcription (internal)',
        ],
    });
});

app.get('/api/version', (req, res) => {
    res.json({ version: APP_VERSION, name: 'Qlipper AI' });
});

// Free tier usage status
app.get('/api/free-usage', (req, res) => {
    res.json({
        limit: FREE_DAILY_LIMIT,
        remaining: getRemainingFreeUses(),
        hasFreeTier: !!getFreeApiKey()
    });
});

// SPA fallback - serve index.html for any non-API routes
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Frontend not built. Run: cd frontend && npm run build');
    }
});

// ============================================================
// SERVER STARTUP WITH PORT-IN-USE PREVENTION
// ============================================================
const MAX_PORT_RETRIES = 10;
let actualPort = port;
let server = null;

const showServerBanner = (usedPort) => {
    const os = require('os');
    let networkUrl = '';
    let interfaces = {};

    try {
        interfaces = os.networkInterfaces();
    } catch (error) {
        console.warn('[Network] Unable to read interfaces:', error.message);
    }

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                networkUrl = `http://${iface.address}:${usedPort}`;
                break;
            }
        }
        if (networkUrl) break;
    }

    console.log(``);
    console.log(`========================================`);
    console.log(`  Qlipper AI Server v${APP_VERSION}`);
    console.log(`========================================`);
    console.log(`  > Local:   http://localhost:${usedPort}`);
    if (networkUrl) {
        console.log(`  > Network: ${networkUrl}`);
    }
    if (usedPort !== port) {
        console.log(`  > Note: Port ${port} was busy, using ${usedPort}`);
    }
    console.log(`========================================`);
    console.log(``);
};

const tryStartServer = (portToTry) => {
    return new Promise((resolve, reject) => {
        const testServer = app.listen(portToTry, '0.0.0.0');

        testServer.on('listening', () => {
            resolve(testServer);
        });

        testServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject({ code: 'EADDRINUSE', port: portToTry });
            } else {
                reject(err);
            }
        });
    });
};

const startServerWithRetry = async () => {
    for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
        const tryPort = port + attempt;
        try {
            if (attempt > 0) {
                console.log(`[STARTUP] Port ${port + attempt - 1} in use, trying port ${tryPort}...`);
            }
            server = await tryStartServer(tryPort);
            actualPort = tryPort;
            showServerBanner(actualPort);
            server.timeout = 300000; // 5 minutes
            return;
        } catch (err) {
            if (err.code !== 'EADDRINUSE' || attempt === MAX_PORT_RETRIES - 1) {
                // Final attempt failed or non-port error
                console.error(``);
                console.error(`========================================`);
                console.error(`  ERROR: Could not start server`);
                console.error(`========================================`);
                if (err.code === 'EADDRINUSE') {
                    console.error(`  Ports ${port}-${port + MAX_PORT_RETRIES - 1} are all in use.`);
                    console.error(``);
                    console.error(`  How to fix:`);
                    console.error(`  1. Close other Qlipper AI instances`);
                    console.error(`  2. Close apps using these ports`);
                    if (process.platform === 'win32') {
                        console.error(`  3. Run: netstat -ano | findstr :${port}`);
                    } else {
                        console.error(`  3. Run: lsof -ti:${port} | xargs kill -9`);
                    }
                } else {
                    console.error(`  Error: ${err.message}`);
                }
                console.error(`========================================`);
                console.error(``);
                process.exit(1);
            }
            // Continue to next port
        }
    }
};

// Start the server (skip when imported for testing)
if (require.main === module) {
    startServerWithRetry();
}

// Export for testing with supertest
module.exports = app;

process.on('uncaughtException', (err) => {
    // Don't log EADDRINUSE here - it's handled above
    if (err.code !== 'EADDRINUSE') {
        console.error('SYSTEM_CRASH: Uncaught Exception:', err);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('SYSTEM_CRASH: Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown - close Puppeteer browser
process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Received SIGINT, cleaning up...');
    try {
        await closeBrowser();
    } catch (e) {
        console.error('[SHUTDOWN] Error closing browser:', e.message);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n[SHUTDOWN] Received SIGTERM, cleaning up...');
    try {
        await closeBrowser();
    } catch (e) {
        console.error('[SHUTDOWN] Error closing browser:', e.message);
    }
    process.exit(0);
});
