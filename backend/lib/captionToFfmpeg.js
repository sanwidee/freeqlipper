/**
 * Caption Blocks to FFmpeg Filter Converter
 * Converts CaptionBlocks to FFmpeg drawtext filter chains
 * for video export with matching visual appearance
 */

const path = require('path');
const fs = require('fs');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * Resolve a system font path for FFmpeg drawtext filter.
 * Falls back to common fonts per platform.
 */
function resolveFont() {
    if (isWindows) {
        // Windows font directory
        const candidates = [
            'C:\\Windows\\Fonts\\arial.ttf',
            'C:\\Windows\\Fonts\\segoeui.ttf',
            'C:\\Windows\\Fonts\\calibri.ttf',
        ];
        for (const f of candidates) {
            if (fs.existsSync(f)) return f.replace(/\\/g, '/'); // FFmpeg needs forward slashes
        }
        return 'C:/Windows/Fonts/arial.ttf'; // best guess
    } else if (isMac) {
        const candidates = [
            '/System/Library/Fonts/Helvetica.ttc',
            '/System/Library/Fonts/SFNS.ttf',
            '/Library/Fonts/Arial.ttf',
        ];
        for (const f of candidates) {
            if (fs.existsSync(f)) return f;
        }
        return '/System/Library/Fonts/Helvetica.ttc';
    } else {
        // Linux
        const candidates = [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        ];
        for (const f of candidates) {
            if (fs.existsSync(f)) return f;
        }
        return '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    }
}

const SYSTEM_FONT = resolveFont();

/**
 * Caption preset definitions (mirrored from frontend)
 * These must match frontend/src/lib/captionPresets.js
 */
const PRESETS = {
    karaoke: {
        font: 'Inter',
        weight: 700,
        fontSize: 48,
        textColor: 'white',
        highlightColor: '0x00FF66',
        strokeColor: 'black',
        strokeWidth: 3
    },
    beasty: {
        font: 'Anton',
        weight: 800,
        fontSize: 56,
        textColor: 'white',
        highlightColor: '0xFFB800',
        strokeColor: 'black',
        strokeWidth: 4
    },
    simple: {
        font: 'Inter',
        weight: 400,
        fontSize: 32,
        textColor: 'white',
        highlightColor: 'white',
        strokeColor: 'transparent',
        strokeWidth: 0,
        bgColor: '0x000000@0.6'
    }
};

/**
 * Convert hex color to FFmpeg format
 * @param {string} hex - Hex color like "#FFFFFF"
 * @returns {string} - FFmpeg color like "white" or "0xFFFFFF"
 */
function hexToFFmpeg(hex) {
    if (!hex) return 'white';
    if (hex === 'transparent') return 'black@0';
    if (hex.startsWith('#')) {
        return '0x' + hex.slice(1).toUpperCase();
    }
    return hex;
}

/**
 * Escape text for FFmpeg drawtext
 * @param {string} text 
 * @returns {string}
 */
function escapeForDrawtext(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\''")
        .replace(/:/g, '\\:')
        .replace(/%/g, '\\%');
}

/**
 * Generate FFmpeg drawtext filter for a single caption block
 * @param {Object} block - CaptionBlock with word timings
 * @param {Object} preset - Preset configuration
 * @param {number} videoWidth - Video width in pixels
 * @param {number} videoHeight - Video height in pixels
 * @returns {string} - FFmpeg filter string
 */
function blockToDrawtext(block, preset, videoWidth = 1080, videoHeight = 1920) {
    const filters = [];

    // Calculate position
    const xPos = Math.round((block.position.x / 100) * videoWidth);
    const yPos = Math.round((block.position.y / 100) * videoHeight);

    // For word-by-word highlighting (karaoke style)
    if (preset.wordByWord !== false && block.words) {
        // First, draw all words in base color
        const fullText = block.words.map(w => w.text).join(' ');
        const escapedText = escapeForDrawtext(fullText);

        const baseFilter = `drawtext=text='${escapedText}'` +
            `:fontfile=${SYSTEM_FONT}` +
            `:fontsize=${preset.fontSize}` +
            `:fontcolor=${hexToFFmpeg(preset.textColor)}` +
            `:borderw=${preset.strokeWidth || 2}` +
            `:bordercolor=${hexToFFmpeg(preset.strokeColor)}` +
            `:x=${xPos}-(tw/2)` +
            `:y=${yPos}-(th/2)` +
            `:enable='between(t,${block.startTime},${block.endTime})'`;

        filters.push(baseFilter);

        // Then overlay highlighted word at correct position
        // This is a simplified version - full implementation would need
        // text measurement which is complex in ffmpeg
    } else {
        // Simple phrase-level caption
        const fullText = block.words.map(w => w.text).join(' ');
        const escapedText = escapeForDrawtext(fullText);

        const filter = `drawtext=text='${escapedText}'` +
            `:fontfile=${SYSTEM_FONT}` +
            `:fontsize=${preset.fontSize || 40}` +
            `:fontcolor=${hexToFFmpeg(preset.textColor || 'white')}` +
            `:borderw=${preset.strokeWidth || 2}` +
            `:bordercolor=${hexToFFmpeg(preset.strokeColor || 'black')}` +
            `:x=${xPos}-(tw/2)` +
            `:y=${yPos}-(th/2)` +
            `:enable='between(t,${block.startTime.toFixed(3)},${block.endTime.toFixed(3)})'`;

        filters.push(filter);
    }

    return filters;
}

/**
 * Generate complete FFmpeg filter_complex string for all caption blocks
 * @param {Array} blocks - Array of CaptionBlocks
 * @param {string} presetId - Preset ID
 * @param {number} videoWidth 
 * @param {number} videoHeight 
 * @returns {string} - Complete filter_complex string segment
 */
function blocksToFilterComplex(blocks, presetId = 'karaoke', videoWidth = 1080, videoHeight = 1920) {
    const preset = PRESETS[presetId] || PRESETS.karaoke;

    if (!blocks || blocks.length === 0) {
        return null;
    }

    // Generate drawtext filters for all blocks
    const allFilters = [];

    for (const block of blocks) {
        const filters = blockToDrawtext(block, preset, videoWidth, videoHeight);
        allFilters.push(...filters);
    }

    // Chain them together
    // Each drawtext filter is applied sequentially
    return allFilters.join(',');
}

/**
 * Generate FFmpeg arguments for burning captions
 * @param {Array} blocks 
 * @param {string} inputLabel - Current filter chain label (e.g., '[v0]')
 * @param {string} outputLabel - Output label (e.g., '[v_captions]')
 * @param {string} presetId 
 * @param {number} videoWidth 
 * @param {number} videoHeight 
 * @returns {Object} - { filterString, outputLabel }
 */
function generateCaptionFilter(blocks, inputLabel, outputLabel, presetId, videoWidth, videoHeight) {
    const filters = blocksToFilterComplex(blocks, presetId, videoWidth, videoHeight);

    if (!filters) {
        return { filterString: null, outputLabel: inputLabel };
    }

    return {
        filterString: `${inputLabel}${filters}${outputLabel}`,
        outputLabel
    };
}

module.exports = {
    hexToFFmpeg,
    escapeForDrawtext,
    blockToDrawtext,
    blocksToFilterComplex,
    generateCaptionFilter,
    PRESETS
};
