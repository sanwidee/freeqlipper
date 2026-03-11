import { describe, it, expect } from 'vitest';
import fs from 'fs';
import binResolver from '../../bin-resolver.js';

describe('bin-resolver exports', () => {
    it('exports getYtDlpPath function', () => {
        expect(typeof binResolver.getYtDlpPath).toBe('function');
    });

    it('exports getFfmpegPath function', () => {
        expect(typeof binResolver.getFfmpegPath).toBe('function');
    });

    it('exports findBinary function', () => {
        expect(typeof binResolver.findBinary).toBe('function');
    });

    it('exports platform detection flags', () => {
        expect(typeof binResolver.isWindows).toBe('boolean');
        expect(typeof binResolver.isMac).toBe('boolean');
    });

    it('platform flags are consistent with process.platform', () => {
        expect(binResolver.isWindows).toBe(process.platform === 'win32');
        expect(binResolver.isMac).toBe(process.platform === 'darwin');
    });
});

describe('getYtDlpPath', () => {
    it('returns string or null', () => {
        const result = binResolver.getYtDlpPath();
        expect(result === null || typeof result === 'string').toBe(true);
    });

    it('if found, path exists on disk', () => {
        const result = binResolver.getYtDlpPath();
        if (result) {
            expect(fs.existsSync(result)).toBe(true);
        }
    });
});

describe('getFfmpegPath', () => {
    it('returns string or null', () => {
        const result = binResolver.getFfmpegPath();
        expect(result === null || typeof result === 'string').toBe(true);
    });

    it('if found, path exists on disk', () => {
        const result = binResolver.getFfmpegPath();
        if (result) {
            expect(fs.existsSync(result)).toBe(true);
        }
    });
});

describe('findBinary', () => {
    it('returns null for nonexistent binary', () => {
        const result = binResolver.findBinary('definitely-not-a-real-binary-xyz123');
        expect(result).toBeNull();
    });
});
