/**
 * preflight.js
 * Startup validator for Qlipper AI backend.
 * - Auto-downloads yt-dlp if not found
 * - Verifies ffmpeg exists (bundled or system PATH)
 * - Creates required directories
 * Exits non-zero with human-readable errors on failure.
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');

const BACKEND_DIR = __dirname;
const APP_DIR = path.join(BACKEND_DIR, '..');
const BIN_DIR = path.join(BACKEND_DIR, 'bin');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Required directories (relative to app/)
const REQUIRED_DIRS = [
    'clips',
    'downloads',
    'assets',
    'assets/transcripts',
    'backend/db'
];

// yt-dlp download URLs (latest release)
const YTDLP_URLS = {
    win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
    linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
};

// ffmpeg static binary download URLs (gzipped single binaries from ffmpeg-static GitHub releases)
// These are direct binary downloads that just need gunzip -- no archive extraction
const FFMPEG_URLS = (() => {
    const base = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
    if (isWindows) return `${base}/ffmpeg-win32-x64.gz`;
    if (isMac) return `${base}/ffmpeg-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.gz`;
    return `${base}/ffmpeg-linux-x64.gz`;
})();

const zlib = require('zlib');

/**
 * Download a gzipped file and decompress to destination.
 * Used for ffmpeg-static GitHub releases which are .gz single binaries.
 */
function downloadAndGunzip(url, destPath) {
    return new Promise((resolve, reject) => {
        const followRedirect = (currentUrl, redirectCount = 0) => {
            if (redirectCount > 5) {
                reject(new Error('Too many redirects'));
                return;
            }
            const protocol = currentUrl.startsWith('https') ? https : http;
            const req = protocol.get(currentUrl, {
                headers: { 'User-Agent': 'Qlipper-AI/1.6' },
                timeout: 120000
            }, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    followRedirect(response.headers.location, redirectCount + 1);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }
                const gunzip = zlib.createGunzip();
                const file = fs.createWriteStream(destPath);
                response.pipe(gunzip).pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                gunzip.on('error', (err) => {
                    fs.unlink(destPath, () => {});
                    reject(new Error(`Decompression failed: ${err.message}`));
                });
                file.on('error', (err) => {
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
        };
        followRedirect(url);
    });
}

let hasErrors = false;
let hasWarnings = false;

// Read version from package.json dynamically
const pkgVersion = (() => {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf-8'));
        return pkg.version || 'unknown';
    } catch { return 'unknown'; }
})();

console.log('');
console.log('========================================');
console.log(`  Qlipper AI Preflight Check v${pkgVersion}`);
console.log('========================================');
console.log('');

/**
 * Download a file from URL with redirect support and retry
 */
function downloadFileSingle(url, destPath) {
    return new Promise((resolve, reject) => {
        const followRedirect = (currentUrl, redirectCount = 0) => {
            if (redirectCount > 5) {
                reject(new Error('Too many redirects'));
                return;
            }

            const protocol = currentUrl.startsWith('https') ? https : http;
            const req = protocol.get(currentUrl, {
                headers: { 'User-Agent': 'Qlipper-AI/1.6' },
                timeout: 60000
            }, (response) => {
                // Handle redirects
                if (response.statusCode === 301 || response.statusCode === 302) {
                    followRedirect(response.headers.location, redirectCount + 1);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }

                const file = fs.createWriteStream(destPath);
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                file.on('error', (err) => {
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            });
            req.on('error', (err) => {
                reject(err);
            });
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Download timed out'));
            });
        };

        followRedirect(url);
    });
}

/**
 * Download a file with automatic retry (exponential backoff)
 * @param {string} url - Download URL
 * @param {string} destPath - Destination file path
 * @param {number} maxRetries - Max retry attempts (default: 3)
 */
async function downloadFile(url, destPath, maxRetries = 3) {
    console.log(`  ↓ Downloading from ${url.substring(0, 60)}...`);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await downloadFileSingle(url, destPath);
            return; // Success
        } catch (err) {
            // Clean up partial file
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
            
            const isRetryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up|timed out/i.test(err.message);
            
            if (isRetryable && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                console.log(`  ⚠ Download attempt ${attempt} failed: ${err.message}. Retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
}

/**
 * Try to update yt-dlp using its built-in --update command
 * @param {string} ytdlpPath - Path to yt-dlp binary
 * @returns {Promise<string|null>} - New version string or null if update failed
 */
function tryYtdlpSelfUpdate(ytdlpPath) {
    return new Promise((resolve) => {
        console.log('  ↓ Trying yt-dlp self-update (--update)...');
        const proc = spawn(ytdlpPath, ['--update'], {
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
                console.log(`  ✓ yt-dlp self-update succeeded`);
                resolve('ok');
            } else {
                console.log(`  ⚠ yt-dlp self-update unavailable: ${output.trim().substring(0, 100)}`);
                resolve(null); // Fall through to manual download
            }
        });
        proc.on('error', () => resolve(null));
    });
}

/**
 * Check if a binary exists and is executable
 */
function binaryExists(binPath) {
    if (!fs.existsSync(binPath)) return false;
    try {
        fs.accessSync(binPath, fs.constants.X_OK);
        return true;
    } catch {
        // Try to make it executable on Unix
        if (!isWindows) {
            try {
                fs.chmodSync(binPath, 0o755);
                return true;
            } catch {
                return false;
            }
        }
        return true; // Windows doesn't need executable bit
    }
}

/**
 * Find binary: vendored first, then system PATH (Mac/Linux only)
 */
function findBinary(name) {
    const binaryName = isWindows ? `${name}.exe` : name;
    
    // 1. Check vendored bin/ directory
    const vendoredPath = path.join(BIN_DIR, binaryName);
    if (binaryExists(vendoredPath)) {
        return { path: vendoredPath, source: 'vendored' };
    }
    
    // 2. Windows: check system PATH via 'where'
    if (isWindows) {
        try {
            const systemPath = execSync(`where ${name}`, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim().split(/\r?\n/)[0];
            if (systemPath && fs.existsSync(systemPath)) {
                return { path: systemPath, source: 'system' };
            }
        } catch {
            // Not in PATH
        }
        return null;
    }
    
    // 3. Mac/Linux: Check system PATH as fallback
    try {
        const systemPath = execSync(`which ${name}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        
        if (systemPath && fs.existsSync(systemPath)) {
            return { path: systemPath, source: 'system' };
        }
    } catch {
        // Not in PATH
    }
    
    return null;
}

/**
 * Test if yt-dlp works by running --version
 */
function testYtDlp(binPath) {
    try {
        // Increased timeout to 30s - macOS Gatekeeper can take 15+ seconds on first run
        const result = execSync(`"${binPath}" --version`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000
        }).trim();
        return result;
    } catch (err) {
        // On macOS, try removing quarantine and retry
        if (isMac) {
            clearQuarantine(binPath);
            try {
                const result = execSync(`"${binPath}" --version`, {
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                    timeout: 30000
                }).trim();
                return result;
            } catch {
                return null;
            }
        }
        return null;
    }
}

/**
 * Parse yt-dlp version date (format: YYYY.MM.DD)
 * @returns {Date|null}
 */
function parseYtdlpVersionDate(version) {
    if (!version) return null;
    // Version format: 2024.01.15 or 2024.1.15
    const match = version.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    if (!match) return null;
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
}

/**
 * Check if yt-dlp version is older than specified days
 */
function isYtdlpOutdated(version, maxAgeDays = 14) {
    const versionDate = parseYtdlpVersionDate(version);
    if (!versionDate) return false; // Can't determine, assume it's fine
    
    const now = new Date();
    const ageDays = Math.floor((now - versionDate) / (1000 * 60 * 60 * 24));
    return ageDays > maxAgeDays;
}

/**
 * Remove macOS quarantine + ad-hoc codesign a binary.
 * On macOS Ventura+ (darwin 22+), removing the quarantine xattr alone
 * is NOT enough -- Gatekeeper also checks code signatures.
 * Unsigned binaries extracted from a ZIP need an ad-hoc signature.
 */
function clearQuarantine(binPath) {
    if (!isMac) return;
    // Step 1: Remove ALL extended attributes (including quarantine)
    try {
        execSync(`xattr -cr "${binPath}" 2>/dev/null`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000
        });
    } catch {
        // xattr not available or no attributes - fine
    }
    // Step 2: Ad-hoc codesign -- this is the key fix for modern macOS
    try {
        execSync(`codesign --force --deep -s - "${binPath}" 2>/dev/null`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 15000
        });
        console.log(`  ✓ Signed & cleared quarantine: ${path.basename(binPath)}`);
    } catch {
        // codesign failed - still try to proceed, testFfmpeg will catch it
    }
}

/**
 * Test if ffmpeg works by running -version
 */
function testFfmpeg(binPath) {
    try {
        // Increased timeout to 30s - macOS Gatekeeper can take time on first run
        const result = execSync(`"${binPath}" -version`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000
        });
        // Extract version from first line
        const firstLine = result.split(/\r?\n/)[0];
        return firstLine;
    } catch (err) {
        // On macOS, try removing quarantine and retry
        if (isMac) {
            clearQuarantine(binPath);
            try {
                const result = execSync(`"${binPath}" -version`, {
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                    timeout: 30000
                });
                const firstLine = result.split(/\r?\n/)[0];
                return firstLine;
            } catch {
                return null;
            }
        }
        return null;
    }
}

async function main() {
    // Ensure bin directory exists
    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    // Pre-step: Clear macOS quarantine + ad-hoc codesign all vendored binaries
    // On macOS Ventura+ removing quarantine xattr alone is NOT enough.
    // Gatekeeper also checks code signatures. We need to ad-hoc sign.
    if (isMac && fs.existsSync(BIN_DIR)) {
        try {
            execSync(`xattr -cr "${BIN_DIR}" 2>/dev/null`, {
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 5000
            });
        } catch {}
        // Ad-hoc sign each binary individually
        try {
            const binFiles = fs.readdirSync(BIN_DIR);
            for (const file of binFiles) {
                const filePath = path.join(BIN_DIR, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isFile()) {
                        execSync(`codesign --force --deep -s - "${filePath}" 2>/dev/null`, {
                            stdio: ['pipe', 'pipe', 'pipe'],
                            timeout: 15000
                        });
                    }
                } catch {
                    // Individual file sign failed - clearQuarantine will retry later
                }
            }
        } catch {}
    }

    // 1. Check yt-dlp
    console.log('[1/3] Checking yt-dlp...');
    
    let ytdlpInfo = findBinary('yt-dlp');
    
    if (!ytdlpInfo) {
        // Auto-download yt-dlp
        console.log('  ⚠ yt-dlp not found, downloading...');
        
        const ytdlpPath = path.join(BIN_DIR, isWindows ? 'yt-dlp.exe' : 'yt-dlp');
        const downloadUrl = YTDLP_URLS[process.platform] || YTDLP_URLS.linux;
        
        try {
            await downloadFile(downloadUrl, ytdlpPath);
            
            // Make executable on Unix
            if (!isWindows) {
                fs.chmodSync(ytdlpPath, 0o755);
            }
            
            ytdlpInfo = { path: ytdlpPath, source: 'downloaded' };
            console.log('  ✓ yt-dlp downloaded successfully');
        } catch (err) {
            console.error(`  ❌ Failed to download yt-dlp: ${err.message}`);
            console.error('     → Manual install: https://github.com/yt-dlp/yt-dlp#installation');
            hasErrors = true;
        }
    }
    
    if (ytdlpInfo) {
        // Test yt-dlp
        let version = testYtDlp(ytdlpInfo.path);
        if (version) {
            console.log(`  ✓ yt-dlp ${version} (${ytdlpInfo.source})`);
            
            // Check if version is outdated (older than 7 days)
            // YouTube changes their API frequently, so yt-dlp needs regular updates
            if (isYtdlpOutdated(version, 7)) {
                const versionDate = parseYtdlpVersionDate(version);
                const ageDays = Math.floor((new Date() - versionDate) / (1000 * 60 * 60 * 24));
                console.log(`  ⚠ yt-dlp is ${ageDays} days old - auto-updating for better compatibility...`);
                
                const ytdlpPath = ytdlpInfo.path;
                
                try {
                    // Strategy 1: Try yt-dlp's built-in self-update first
                    const selfUpdateResult = await tryYtdlpSelfUpdate(ytdlpPath);
                    
                    if (selfUpdateResult) {
                        const newVersion = testYtDlp(ytdlpPath);
                        if (newVersion && newVersion !== version) {
                            console.log(`  ✓ yt-dlp self-updated: ${version} → ${newVersion}`);
                        } else {
                            console.log(`  ✓ yt-dlp ${newVersion || version} is already latest`);
                        }
                    } else {
                        // Strategy 2: Fall back to manual download (with retry)
                        console.log('  ↓ Self-update unavailable, downloading latest binary...');
                        const downloadUrl = YTDLP_URLS[process.platform] || YTDLP_URLS.linux;
                        
                        // Backup old version
                        const backupPath = ytdlpPath + '.backup';
                        if (fs.existsSync(ytdlpPath)) {
                            fs.copyFileSync(ytdlpPath, backupPath);
                        }
                        
                        await downloadFile(downloadUrl, ytdlpPath);
                        if (!isWindows) fs.chmodSync(ytdlpPath, 0o755);
                        
                        const newVersion = testYtDlp(ytdlpPath);
                        if (newVersion && newVersion !== version) {
                            console.log(`  ✓ yt-dlp updated: ${version} → ${newVersion}`);
                            if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
                        } else if (newVersion) {
                            console.log(`  ✓ yt-dlp ${newVersion} is already latest`);
                            if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
                        } else {
                            // New version doesn't work, restore backup
                            console.warn('  ⚠ Update failed, restoring previous version');
                            if (fs.existsSync(backupPath)) {
                                fs.copyFileSync(backupPath, ytdlpPath);
                                if (!isWindows) fs.chmodSync(ytdlpPath, 0o755);
                                fs.unlinkSync(backupPath);
                            }
                            hasWarnings = true;
                        }
                    }
                } catch (err) {
                    console.warn(`  ⚠ Auto-update failed: ${err.message}`);
                    console.log('     → You can manually update in Settings later');
                    hasWarnings = true;
                }
            }
        } else {
            console.error(`  ❌ yt-dlp exists but failed to run`);
            console.error(`     Path: ${ytdlpInfo.path}`);
            
            // Try to re-download if it's corrupted
            if (ytdlpInfo.source === 'vendored' || ytdlpInfo.source === 'downloaded') {
                console.log('     → Attempting re-download...');
                const ytdlpPath = ytdlpInfo.path;
                const downloadUrl = YTDLP_URLS[process.platform] || YTDLP_URLS.linux;
                
                try {
                    fs.unlinkSync(ytdlpPath);
                    await downloadFile(downloadUrl, ytdlpPath);
                    if (!isWindows) fs.chmodSync(ytdlpPath, 0o755);
                    
                    const retestVersion = testYtDlp(ytdlpPath);
                    if (retestVersion) {
                        console.log(`  ✓ yt-dlp ${retestVersion} (re-downloaded)`);
                    } else {
                        hasErrors = true;
                    }
                } catch (err) {
                    console.error(`     Re-download failed: ${err.message}`);
                    hasErrors = true;
                }
            } else {
                hasErrors = true;
            }
        }
    }
    
    console.log('');

    // 2. Check ffmpeg
    console.log('[2/3] Checking ffmpeg...');
    
    let ffmpegInfo = findBinary('ffmpeg');
    let ffmpegVersion = null;
    
    if (ffmpegInfo) {
        ffmpegVersion = testFfmpeg(ffmpegInfo.path);
    }
    
    // If vendored ffmpeg failed (Gatekeeper), try ffmpeg-static npm package
    if (!ffmpegVersion) {
        try {
            const ffmpegStaticPath = require('ffmpeg-static');
            if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
                if (!isWindows) {
                    try { fs.chmodSync(ffmpegStaticPath, 0o755); } catch {}
                }
                const npmVersion = testFfmpeg(ffmpegStaticPath);
                if (npmVersion) {
                    ffmpegInfo = { path: ffmpegStaticPath, source: 'npm (ffmpeg-static)' };
                    ffmpegVersion = npmVersion;
                }
            }
        } catch {
            // ffmpeg-static not installed yet - npm install might not have run
        }
    }
    
    // Last resort: auto-download ffmpeg (same pattern as yt-dlp)
    if (!ffmpegVersion) {
        console.log('  ⚠ ffmpeg not available, attempting auto-download...');
        const ffmpegDest = path.join(BIN_DIR, isWindows ? 'ffmpeg.exe' : 'ffmpeg');
        try {
            await downloadAndGunzip(FFMPEG_URLS, ffmpegDest);
            if (!isWindows) {
                try { fs.chmodSync(ffmpegDest, 0o755); } catch {}
            }
            const dlVersion = testFfmpeg(ffmpegDest);
            if (dlVersion) {
                ffmpegInfo = { path: ffmpegDest, source: 'auto-downloaded' };
                ffmpegVersion = dlVersion;
                console.log(`  ✓ ${dlVersion.substring(0, 50)}... (auto-downloaded)`);
            } else {
                console.error('  ❌ Downloaded ffmpeg but it failed to run');
                try { fs.unlinkSync(ffmpegDest); } catch {}
            }
        } catch (dlErr) {
            console.error(`  ❌ ffmpeg auto-download failed: ${dlErr.message}`);
        }
    }

    if (!ffmpegVersion) {
        console.error('  ❌ ffmpeg NOT FOUND (all strategies exhausted)');
        if (isWindows) {
            console.error('     → Install via: winget install ffmpeg');
            console.error('     → Or place ffmpeg.exe in backend\\bin\\');
        } else {
            console.error('     → Install via: brew install ffmpeg');
            console.error('     → Or place ffmpeg binary in backend/bin/');
        }
        console.error('     → Or run: npm install (in backend/) to retry ffmpeg-static');
        hasErrors = true;
    } else if (ffmpegInfo.source !== 'auto-downloaded') {
        // Print success only if not already printed by auto-download block
        console.log(`  ✓ ${ffmpegVersion.substring(0, 50)}... (${ffmpegInfo.source})`);
    }
    
    console.log('');

    // 3. Create/verify directories
    console.log('[3/3] Verifying directories...');
    
    for (const dir of REQUIRED_DIRS) {
        const fullPath = path.join(APP_DIR, dir);
        if (!fs.existsSync(fullPath)) {
            try {
                fs.mkdirSync(fullPath, { recursive: true });
                console.log(`  ✓ Created: ${dir}/`);
            } catch (err) {
                console.error(`  ❌ Failed to create: ${dir}/`);
                console.error(`     → ${err.message}`);
                hasErrors = true;
            }
        } else {
            console.log(`  ✓ Exists: ${dir}/`);
        }
    }
    
    // Summary
    console.log('');
    console.log('========================================');
    
    if (hasErrors) {
        console.error('  PREFLIGHT FAILED - Fix errors above');
        console.log('========================================');
        console.log('');
        process.exit(1);
    } else if (hasWarnings) {
        console.log('  PREFLIGHT PASSED (with warnings)');
        console.log('========================================');
        console.log('');
        process.exit(0);
    } else {
        console.log('  PREFLIGHT PASSED - All checks OK');
        console.log('========================================');
        console.log('');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Preflight error:', err.message);
    process.exit(1);
});
