/**
 * test-yt.js
 * Canonical test for yt-dlp using bin-resolver with raw spawn.
 * No youtube-dl-exec dependency.
 */

const { spawn } = require('child_process');
const { getYtDlpPath, getFfmpegPath } = require('./bin-resolver');

const ytdlp = getYtDlpPath();
const ffmpeg = getFfmpegPath();

if (!ytdlp) {
    console.error('ERROR: yt-dlp not found. Place yt-dlp.exe in backend/bin/ or install system-wide.');
    process.exit(1);
}

const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const args = [
    url,
    '--dump-single-json',
    '--no-check-certificates',
    '--no-warnings'
];

// Add ffmpeg location if available
if (ffmpeg) {
    args.push('--ffmpeg-location', ffmpeg);
}

console.log(`[TEST] Running: ${ytdlp}`);
console.log(`[TEST] Args: ${args.join(' ')}`);

const proc = spawn(ytdlp, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
});

let stdout = '';
let stderr = '';

proc.stdout.on('data', (data) => {
    stdout += data.toString();
});

proc.stderr.on('data', (data) => {
    stderr += data.toString();
});

proc.on('close', (code) => {
    if (code === 0) {
        try {
            const metadata = JSON.parse(stdout);
            console.log('SUCCESS!');
            console.log('TITLE:', metadata.title);
            console.log('DURATION:', metadata.duration_string);
            console.log('UPLOADER:', metadata.uploader);
        } catch (e) {
            console.error('JSON Parse Error:', e.message);
            console.error('Raw output:', stdout.substring(0, 500));
        }
    } else {
        console.error('FAILED with code:', code);
        console.error('STDERR:', stderr);
    }
    process.exit(code);
});

proc.on('error', (err) => {
    console.error('Spawn Error:', err.message);
    process.exit(1);
});
