/**
 * Text escaping utilities for FFmpeg filters.
 * Extracted from server.js and overlayRenderer.js for testability.
 */

/**
 * Escape text for FFmpeg drawtext filter.
 * Handles special characters that would break filter parsing.
 * @param {string} text - Raw text
 * @returns {string} Escaped text safe for drawtext filter
 */
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

/**
 * Escape a file path for use inside FFmpeg filter arguments.
 * Normalizes to forward slashes and escapes special filter chars.
 * @param {string} filePath - Raw file path
 * @returns {string} Escaped path safe for FFmpeg filter arguments
 */
const escapePathForFFmpegFilter = (filePath) => {
    // First normalize to forward slashes (works on both Windows and Unix)
    const normalized = filePath.replace(/\\/g, '/');

    // Then escape special FFmpeg filter characters
    // but be careful not to escape Windows drive letters more than necessary
    return normalized
        .replace(/'/g, "'\\''")    // escape single quotes first
        .replace(/:/g, '\\:')      // escape colons (including in Windows paths)
        .replace(/\[/g, '\\[')     // escape brackets
        .replace(/\]/g, '\\]');    // escape brackets
};

module.exports = { escapeForFFmpegDrawtext, escapePathForFFmpegFilter };
