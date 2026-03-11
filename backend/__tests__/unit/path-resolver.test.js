import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Import the utility (CJS module, Vitest handles interop)
import { resolveMediaPath } from '../../utils/path-resolver.js';

// Create a temp directory structure for testing
let tmpRoot;

beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qlipper-path-test-'));
    // Create fake app structure
    fs.mkdirSync(path.join(tmpRoot, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'clips'), { recursive: true });
    // Create a dummy video file
    fs.writeFileSync(path.join(tmpRoot, 'assets', 'test_video.mp4'), 'fake');
    fs.writeFileSync(path.join(tmpRoot, 'downloads', 'other.mp4'), 'fake');
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveMediaPath', () => {
    it('resolves a relative path against appRoot', () => {
        const { resolved, error } = resolveMediaPath(tmpRoot, 'assets/test_video.mp4');
        expect(error).toBeNull();
        expect(resolved).toBe(path.resolve(tmpRoot, 'assets/test_video.mp4'));
    });

    it('returns an existing absolute path as-is', () => {
        const absPath = path.join(tmpRoot, 'assets', 'test_video.mp4');
        const { resolved, error } = resolveMediaPath(tmpRoot, absPath);
        expect(error).toBeNull();
        expect(resolved).toBe(absPath);
    });

    it('recovers a stale absolute path by extracting relative portion', () => {
        // Simulate: old install was at /OLD/PATH, file was at /OLD/PATH/assets/test_video.mp4
        // Now app is at tmpRoot, file is at tmpRoot/assets/test_video.mp4
        const stalePath = '/OLD/INSTALL/PATH/assets/test_video.mp4';
        const { resolved, error } = resolveMediaPath(tmpRoot, stalePath);
        expect(error).toBeNull();
        expect(resolved).toBe(path.join(tmpRoot, 'assets', 'test_video.mp4'));
    });

    it('recovers a stale Windows backslash absolute path', () => {
        const stalePath = 'E:\\TOLS KLIPER\\QLIPPER\\App\\assets\\test_video.mp4';
        const { resolved, error } = resolveMediaPath(tmpRoot, stalePath);
        // On macOS/Linux path.isAbsolute('E:\\...') is false, so it falls to relative resolution
        // But the normalizedPath.replace(/\\/g, '/') handles the backslash extraction
        // Either way, the file should resolve if extractable
        if (path.isAbsolute(stalePath)) {
            // On Windows: should recover via stale path extraction
            expect(error).toBeNull();
            expect(resolved).toContain('test_video.mp4');
        } else {
            // On macOS/Linux: E:\\ is treated as relative, won't find file
            // This is expected — Windows paths only fully work on Windows
            expect(error).not.toBeNull();
        }
    });

    it('returns error for truly missing file (relative)', () => {
        const { resolved, error } = resolveMediaPath(tmpRoot, 'assets/nonexistent.mp4');
        expect(resolved).toBeNull();
        expect(error).toContain('not found');
    });

    it('returns error for truly missing file (absolute)', () => {
        const { resolved, error } = resolveMediaPath(tmpRoot, '/totally/fake/path/video.mp4');
        expect(resolved).toBeNull();
        expect(error).toContain('not found');
    });

    it('returns error for null input', () => {
        const { resolved, error } = resolveMediaPath(tmpRoot, null);
        expect(resolved).toBeNull();
        expect(error).toContain('No media path');
    });

    it('returns error for empty string input', () => {
        const { resolved, error } = resolveMediaPath(tmpRoot, '');
        expect(resolved).toBeNull();
        expect(error).toContain('No media path');
    });

    it('resolves from downloads directory', () => {
        const stalePath = '/some/old/path/downloads/other.mp4';
        const { resolved, error } = resolveMediaPath(tmpRoot, stalePath);
        expect(error).toBeNull();
        expect(resolved).toBe(path.join(tmpRoot, 'downloads', 'other.mp4'));
    });
});
