const path = require('path');
const fs = require('fs');

/**
 * Resolve a video/media path portably — handles stale absolute paths
 * from when user moves the app folder to a new location.
 *
 * @param {string} appRoot - Absolute path to app root (path.resolve(__dirname, '..') from server.js)
 * @param {string} mediaPath - Path from DB (may be absolute or relative)
 * @returns {{ resolved: string|null, error: string|null }}
 */
const resolveMediaPath = (appRoot, mediaPath) => {
    if (!mediaPath) return { resolved: null, error: 'No media path provided.' };

    if (path.isAbsolute(mediaPath)) {
        if (fs.existsSync(mediaPath)) return { resolved: mediaPath, error: null };

        // Try extracting relative portion from stale absolute path
        const knownDirs = ['assets', 'downloads', 'downloaded', 'clips'];
        const normalizedPath = mediaPath.replace(/\\/g, '/');
        for (const dir of knownDirs) {
            const idx = normalizedPath.lastIndexOf(`/${dir}/`);
            if (idx !== -1) {
                const relativePart = normalizedPath.substring(idx + 1);
                const candidate = path.join(appRoot, relativePart);
                if (fs.existsSync(candidate)) {
                    console.log(`[PATH-FIX] Stale absolute path resolved: ${mediaPath} → ${candidate}`);
                    return { resolved: candidate, error: null };
                }
            }
        }
        return { resolved: null, error: 'Source video not found. The app may have been moved. Please re-download the video.' };
    }

    // Relative path — resolve from app root
    const resolved = path.resolve(appRoot, mediaPath);
    if (fs.existsSync(resolved)) return { resolved, error: null };
    return { resolved: null, error: 'Source video not found. The file may have been moved or deleted.' };
};

module.exports = { resolveMediaPath };
