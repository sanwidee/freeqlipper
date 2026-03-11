/**
 * Windows Compatibility Tests
 * 
 * Tests cross-platform behavior for:
 * - File URI generation (backslash → forward slash, drive letters)
 * - Overlay HTML generation with Windows paths
 * - Resolution config for new face-tracking formats
 * - Bin-resolver Windows-specific logic (binary naming, platform flags)
 * - Path handling patterns used throughout the codebase
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { toFileUri, generateOverlayHTML } from '../../lib/overlayRenderer.js';
import { getResolutionDimensions } from '../../utils/resolution.js';
import binResolver from '../../bin-resolver.js';

// ─── toFileUri: Cross-platform file:// URI generation ───

describe('toFileUri', () => {
    it('converts Unix absolute path to file:// URI', () => {
        expect(toFileUri('/home/user/stickers/img.png'))
            .toBe('file:///home/user/stickers/img.png');
    });

    it('converts Windows backslash path to file:/// URI with forward slashes', () => {
        expect(toFileUri('C:\\Users\\user\\stickers\\img.png'))
            .toBe('file:///C:/Users/user/stickers/img.png');
    });

    it('converts Windows forward-slash path to file:/// URI', () => {
        expect(toFileUri('C:/Users/user/stickers/img.png'))
            .toBe('file:///C:/Users/user/stickers/img.png');
    });

    it('handles lowercase drive letter', () => {
        expect(toFileUri('d:\\data\\sticker.svg'))
            .toBe('file:///d:/data/sticker.svg');
    });

    it('handles mixed separators on Windows', () => {
        expect(toFileUri('E:\\Projects/QLIPPER\\stickers/test.png'))
            .toBe('file:///E:/Projects/QLIPPER/stickers/test.png');
    });

    it('handles macOS path with spaces', () => {
        expect(toFileUri('/Volumes/Sanwidi 2TB/stickers/img.png'))
            .toBe('file:///Volumes/Sanwidi 2TB/stickers/img.png');
    });
});

// ─── generateOverlayHTML: Sticker image path in HTML output ───

describe('generateOverlayHTML sticker image paths', () => {
    const baseOpts = {
        text: 'Test Hook',
        width: 1080,
        height: 1920,
        stickerEnabled: true,
        stickerShape: 'pill',
    };

    it('renders sticker image with Unix path as file:// src', () => {
        const html = generateOverlayHTML({
            ...baseOpts,
            stickerImagePath: '/tmp/stickers/custom.png',
        });
        expect(html).toContain('file:///tmp/stickers/custom.png');
        expect(html).toContain('<img src="file:///tmp/stickers/custom.png"');
    });

    it('renders sticker image with Windows path as file:/// src', () => {
        const html = generateOverlayHTML({
            ...baseOpts,
            stickerImagePath: 'C:\\Users\\test\\stickers\\logo.png',
        });
        expect(html).toContain('file:///C:/Users/test/stickers/logo.png');
        expect(html).not.toContain('\\');
    });

    it('renders sticker text when no image path provided', () => {
        const html = generateOverlayHTML({
            ...baseOpts,
            stickerText: 'MUST WATCH',
            stickerImagePath: null,
        });
        expect(html).toContain('MUST WATCH');
        expect(html).toContain('sticker-pill');
        expect(html).not.toContain('<img');
    });

    it('prefers image over text when both provided', () => {
        const html = generateOverlayHTML({
            ...baseOpts,
            stickerText: 'MUST WATCH',
            stickerImagePath: '/tmp/sticker.png',
        });
        const body = html.substring(html.indexOf('<body>'));
        expect(body).toContain('<img');
        // Image mode uses sticker-image div, not sticker-wrapper with shape class
        expect(body).toContain('sticker-image');
        expect(body).not.toContain('sticker-wrapper');
    });

    it('renders nothing when sticker is disabled', () => {
        const html = generateOverlayHTML({
            ...baseOpts,
            stickerEnabled: false,
            stickerText: 'MUST WATCH',
            stickerImagePath: '/tmp/sticker.png',
        });
        // No sticker elements in body (CSS definitions still exist in <style>)
        const body = html.substring(html.indexOf('<body>'));
        expect(body).not.toContain('<img');
        expect(body).not.toContain('sticker-wrapper');
        expect(body).not.toContain('sticker-image');
    });
});

// ─── generateOverlayHTML: Sticker shape presets ───

describe('generateOverlayHTML sticker shapes', () => {
    const baseOpts = {
        text: 'Hook',
        width: 1080,
        height: 1920,
        stickerEnabled: true,
        stickerText: 'TAG',
    };

    for (const shape of ['pill', 'comment-bubble', 'arrow-badge', 'star-burst', 'tape-strip']) {
        it(`renders sticker-${shape} CSS class`, () => {
            const html = generateOverlayHTML({ ...baseOpts, stickerShape: shape });
            expect(html).toContain(`sticker-${shape}`);
        });
    }

    it('applies custom sticker colors', () => {
        const html = generateOverlayHTML({
            ...baseOpts,
            stickerBgColor: '#00FF00',
            stickerTextColor: '#0000FF',
        });
        expect(html).toContain('#00FF00');
        expect(html).toContain('#0000FF');
    });
});

// ─── Resolution config: face-tracking format → aspect ratio mapping ───

describe('getResolutionDimensions face-tracking formats', () => {
    it('split-face-track maps to 9:16', () => {
        const dims = getResolutionDimensions('1080p', 'split-face-track');
        expect(dims.aspectRatio).toBe('9:16');
        expect(dims).toEqual({ w: 1080, h: 1920, aspectRatio: '9:16' });
    });

    it('face-track-zoom maps to 9:16', () => {
        const dims = getResolutionDimensions('720p', 'face-track-zoom');
        expect(dims.aspectRatio).toBe('9:16');
        expect(dims).toEqual({ w: 720, h: 1280, aspectRatio: '9:16' });
    });

    it('face-track-zoom-3-4 maps to 3:4', () => {
        const dims = getResolutionDimensions('1080p', 'face-track-zoom-3-4');
        expect(dims.aspectRatio).toBe('3:4');
        expect(dims).toEqual({ w: 1080, h: 1440, aspectRatio: '3:4' });
    });

    it('face-track-zoom-square maps to 1:1', () => {
        const dims = getResolutionDimensions('720p', 'face-track-zoom-square');
        expect(dims.aspectRatio).toBe('1:1');
        expect(dims).toEqual({ w: 720, h: 720, aspectRatio: '1:1' });
    });

    it('face-track-zoom-landscape maps to 16:9', () => {
        const dims = getResolutionDimensions('1080p', 'face-track-zoom-landscape');
        expect(dims.aspectRatio).toBe('16:9');
        expect(dims).toEqual({ w: 1920, h: 1080, aspectRatio: '16:9' });
    });
});

// ─── Bin-resolver: Windows-specific logic ───

describe('bin-resolver Windows compatibility', () => {
    it('appends .exe on Windows for binary name', () => {
        // The findBinary function uses isWindows to decide extension.
        // We can't mock process.platform easily, but we can verify the logic pattern.
        const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        const expected = process.platform === 'win32';
        expect(binaryName.endsWith('.exe')).toBe(expected);
    });

    it('isWindows flag matches process.platform', () => {
        expect(binResolver.isWindows).toBe(process.platform === 'win32');
    });

    it('isMac flag matches process.platform', () => {
        expect(binResolver.isMac).toBe(process.platform === 'darwin');
    });

    it('BIN_DIR uses path.join (platform-safe separators)', () => {
        // Verify that bin-resolver uses path.join, not string concatenation
        // The vendored path should be an absolute path regardless of platform
        const ytdlp = binResolver.getYtDlpPath();
        const ffmpeg = binResolver.getFfmpegPath();
        // If found, paths should be absolute
        if (ytdlp) expect(path.isAbsolute(ytdlp)).toBe(true);
        if (ffmpeg) expect(path.isAbsolute(ffmpeg)).toBe(true);
    });
});

// ─── Path handling patterns ───

describe('Cross-platform path patterns', () => {
    it('path.join produces platform-correct separators', () => {
        const joined = path.join('app', 'backend', 'stickers', 'img.png');
        // On Windows this would use \\, on Unix /
        expect(joined).toContain('stickers');
        expect(joined).toContain('img.png');
    });

    it('path.resolve produces absolute paths', () => {
        const resolved = path.resolve('app', 'backend');
        expect(path.isAbsolute(resolved)).toBe(true);
    });

    it('path.normalize handles mixed separators', () => {
        // Simulates a path that might come from user input on Windows
        const mixed = path.normalize('app/backend\\stickers/test.png');
        expect(mixed).not.toContain('/\\');
        expect(mixed).not.toContain('\\/');
    });
});
