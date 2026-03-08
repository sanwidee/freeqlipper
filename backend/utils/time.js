/**
 * Time utility functions for timestamp parsing and formatting.
 * Extracted from server.js for testability.
 */

/**
 * Parse a time string (HH:MM:SS, MM:SS, or SS) into total seconds.
 * @param {string} t - Time string
 * @returns {number} Total seconds
 */
const parseTime = (t) => {
    if (!t) return 0;
    t = t.trim();
    const parts = t.split(':').map(Number);
    let totalSeconds = 0;
    if (parts.length === 3) totalSeconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    else if (parts.length === 2) totalSeconds = (parts[0] * 60) + parts[1];
    else totalSeconds = parts[0];
    return totalSeconds;
};

/**
 * Format seconds into HH:MM:SS.mmm string for FFmpeg.
 * @param {number} s - Seconds (can be fractional)
 * @returns {string} Formatted time string
 */
const formatTime = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(6, '0')}`;
};

module.exports = { parseTime, formatTime };
