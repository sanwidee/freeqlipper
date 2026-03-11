/**
 * bin-resolver.js
 * Single source of truth for yt-dlp and ffmpeg binary paths.
 * 
 * RESOLUTION ORDER:
 * 1. Vendored binaries in backend/bin/ (highest priority)
 * 2. macOS/Linux: System PATH as fallback (dev convenience)
 * 3. Windows: NO PATH fallback (must use vendored)
 * 
 * FALLBACK BEHAVIOR:
 * - If vendored binary doesn't work, try system PATH on Mac/Linux
 * - Logs warnings for debugging
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const BIN_DIR = path.join(__dirname, 'bin');

/**
 * Test if a binary is executable and works
 */
function testBinary(binPath, testArg = '--version') {
    try {
        // Increased timeout to 30s - macOS Gatekeeper can take 15+ seconds on first run
        execSync(`"${binPath}" ${testArg}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Try to get ffmpeg path from the ffmpeg-static npm package.
 * This is the most reliable source on macOS because npm downloads
 * don't get com.apple.quarantine, avoiding Gatekeeper blocks entirely.
 * @returns {string|null}
 */
function getFfmpegFromNpm() {
    try {
        const ffmpegStaticPath = require('ffmpeg-static');
        if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
            // Make executable on Unix
            if (!isWindows) {
                try { fs.chmodSync(ffmpegStaticPath, 0o755); } catch {}
            }
            return ffmpegStaticPath;
        }
    } catch {
        // ffmpeg-static not installed
    }
    return null;
}

/**
 * Find a binary by name with platform-specific rules and fallback.
 * @param {string} name - Binary name without extension (e.g., 'ffmpeg')
 * @returns {string|null} - Absolute path or null if not found
 * 
 * RESOLUTION ORDER:
 *  1. Vendored binary in backend/bin/ (user-provided, highest priority)
 *  2. ffmpeg-static npm package (for ffmpeg only - quarantine-free)
 *  3. macOS/Linux: System PATH
 *  4. macOS: Common install locations
 */
function findBinary(name) {
    const binaryName = isWindows ? `${name}.exe` : name;
    const testArg = name === 'ffmpeg' ? '-version' : '--version';

    // 1. Check vendored bin/ directory (ALL PLATFORMS - highest priority)
    const vendoredPath = path.join(BIN_DIR, binaryName);
    if (fs.existsSync(vendoredPath)) {
        // Make executable on Unix if needed
        if (!isWindows) {
            try {
                fs.chmodSync(vendoredPath, 0o755);
            } catch (e) {
                // Ignore chmod errors
            }
        }
        
        // Test if it actually works
        if (testBinary(vendoredPath, testArg)) {
            return vendoredPath;
        } else {
            console.warn(`[BIN-RESOLVER] Warning: Vendored ${name} exists but failed to execute (macOS Gatekeeper?)`);
            // Don't return - fall through to npm/system fallbacks
        }
    }

    // 2. For ffmpeg: Try ffmpeg-static npm package (quarantine-free on macOS)
    if (name === 'ffmpeg') {
        const npmPath = getFfmpegFromNpm();
        if (npmPath && testBinary(npmPath, testArg)) {
            console.log(`[BIN-RESOLVER] Using ffmpeg from ffmpeg-static npm package`);
            return npmPath;
        }
    }

    // 3. Windows: check system PATH via 'where'
    if (isWindows) {
        try {
            const systemPath = execSync(`where ${name}`, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim().split(/\r?\n/)[0];
            if (systemPath && fs.existsSync(systemPath) && testBinary(systemPath, testArg)) {
                return systemPath;
            }
        } catch {}
        return null;
    }

    // 4. macOS/Linux: PATH fallback (dev convenience and recovery)
    try {
        const systemPath = execSync(`which ${name}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        if (systemPath && fs.existsSync(systemPath)) {
            // Test if system binary works
            if (testBinary(systemPath, testArg)) {
                return systemPath;
            }
        }
    } catch {
        // Binary not in PATH
    }

    // 5. macOS: Additional common locations
    if (isMac) {
        const commonPaths = [
            `/usr/local/bin/${name}`,
            `/opt/homebrew/bin/${name}`,
            `/usr/bin/${name}`
        ];
        
        for (const p of commonPaths) {
            if (fs.existsSync(p) && testBinary(p, testArg)) {
                return p;
            }
        }
    }

    return null;
}

// Resolve once at module load
const _ytdlp = findBinary('yt-dlp');
const _ffmpeg = findBinary('ffmpeg');

// Log resolved paths on first import
const platform = isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux';
console.log(`[BIN-RESOLVER] Platform: ${platform}`);
console.log(`[BIN-RESOLVER] yt-dlp: ${_ytdlp || 'NOT FOUND'}`);
console.log(`[BIN-RESOLVER] ffmpeg: ${_ffmpeg || 'NOT FOUND'}`);

/**
 * Get yt-dlp binary path
 * @returns {string|null}
 */
function getYtDlpPath() {
    return _ytdlp;
}

/**
 * Get ffmpeg binary path
 * @returns {string|null}
 */
function getFfmpegPath() {
    return _ffmpeg;
}

module.exports = {
    getYtDlpPath,
    getFfmpegPath,
    ytdlp: _ytdlp,
    ffmpeg: _ffmpeg,
    isWindows,
    isMac,
    findBinary
};
