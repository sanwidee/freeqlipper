/**
 * Resolution and bitrate configuration for video output.
 * Extracted from server.js for testability.
 */

const RESOLUTION_CONFIG = {
    '360p': { '9:16': { w: 360, h: 640 }, '3:4': { w: 360, h: 480 }, '1:1': { w: 360, h: 360 }, '16:9': { w: 640, h: 360 } },
    '480p': { '9:16': { w: 480, h: 854 }, '3:4': { w: 480, h: 640 }, '1:1': { w: 480, h: 480 }, '16:9': { w: 854, h: 480 } },
    '720p': { '9:16': { w: 720, h: 1280 }, '3:4': { w: 720, h: 960 }, '1:1': { w: 720, h: 720 }, '16:9': { w: 1280, h: 720 } },
    '1080p': { '9:16': { w: 1080, h: 1920 }, '3:4': { w: 1080, h: 1440 }, '1:1': { w: 1080, h: 1080 }, '16:9': { w: 1920, h: 1080 } },
    '1440p': { '9:16': { w: 1440, h: 2560 }, '3:4': { w: 1440, h: 1920 }, '1:1': { w: 1440, h: 1440 }, '16:9': { w: 2560, h: 1440 } },
    '4k': { '9:16': { w: 2160, h: 3840 }, '3:4': { w: 2160, h: 2880 }, '1:1': { w: 2160, h: 2160 }, '16:9': { w: 3840, h: 2160 } }
};

const BITRATE_CONFIG = {
    '360p': '1000k',
    '480p': '1500k',
    '720p': '2500k',
    '1080p': '5000k',
    '1440p': '8000k',
    '4k': '15000k'
};

const getBitrate = (resolution = '720p') => BITRATE_CONFIG[resolution] || BITRATE_CONFIG['720p'];

/**
 * Get output dimensions based on resolution and format
 * @param {string} resolution - Resolution ID (360p, 480p, 720p, 1080p, 1440p, 4k)
 * @param {string} outputFormat - Format ID to determine aspect ratio
 * @returns {{ w: number, h: number, aspectRatio: string }} Width, height, and aspect ratio
 */
const getResolutionDimensions = (resolution = '720p', outputFormat = 'stacked-blur') => {
    const res = RESOLUTION_CONFIG[resolution] || RESOLUTION_CONFIG['720p'];

    // Determine aspect ratio from format
    if (['raw-cuts', 'landscape-16-9', 'face-track-zoom-landscape'].includes(outputFormat)) {
        return { ...res['16:9'], aspectRatio: '16:9' };
    } else if (['square-blur', 'square-blur-motion', 'square-zoom', 'face-track-zoom-square'].includes(outputFormat)) {
        return { ...res['1:1'], aspectRatio: '1:1' };
    } else if (['ig-post-blur', 'ig-post-blur-motion', 'ig-post-crop', 'ig-post', 'ig-post-motion', 'portrait-3-4', 'portrait-3-4-motion', 'portrait-3-4-crop', 'face-track-zoom-3-4'].includes(outputFormat)) {
        // 3:4 for Instagram posts/feed
        return { ...res['3:4'], aspectRatio: '3:4' };
    } else {
        // 9:16 formats: stacked-blur, stacked-blur-motion, center-crop, portrait-square, split-speaker, etc.
        return { ...res['9:16'], aspectRatio: '9:16' };
    }
};

module.exports = { RESOLUTION_CONFIG, BITRATE_CONFIG, getBitrate, getResolutionDimensions };
