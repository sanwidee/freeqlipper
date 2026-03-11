import { describe, it, expect } from 'vitest';
import { RESOLUTION_CONFIG, BITRATE_CONFIG, getBitrate, getResolutionDimensions } from '../../utils/resolution.js';

describe('RESOLUTION_CONFIG', () => {
    it('has all expected resolution tiers', () => {
        expect(Object.keys(RESOLUTION_CONFIG)).toEqual(
            expect.arrayContaining(['360p', '480p', '720p', '1080p', '1440p', '4k'])
        );
    });

    it('each resolution has all 4 aspect ratios', () => {
        for (const [res, aspects] of Object.entries(RESOLUTION_CONFIG)) {
            expect(Object.keys(aspects)).toEqual(
                expect.arrayContaining(['9:16', '3:4', '1:1', '16:9'])
            );
            // Each aspect ratio must have w and h
            for (const [ar, dims] of Object.entries(aspects)) {
                expect(dims).toHaveProperty('w');
                expect(dims).toHaveProperty('h');
                expect(dims.w).toBeGreaterThan(0);
                expect(dims.h).toBeGreaterThan(0);
            }
        }
    });

    it('720p 9:16 is 720x1280', () => {
        expect(RESOLUTION_CONFIG['720p']['9:16']).toEqual({ w: 720, h: 1280 });
    });

    it('1080p 16:9 is 1920x1080', () => {
        expect(RESOLUTION_CONFIG['1080p']['16:9']).toEqual({ w: 1920, h: 1080 });
    });
});

describe('BITRATE_CONFIG', () => {
    it('has bitrate for every resolution', () => {
        for (const res of Object.keys(RESOLUTION_CONFIG)) {
            expect(BITRATE_CONFIG).toHaveProperty(res);
        }
    });
});

describe('getBitrate', () => {
    it('returns correct bitrate for known resolutions', () => {
        expect(getBitrate('720p')).toBe('2500k');
        expect(getBitrate('1080p')).toBe('5000k');
        expect(getBitrate('4k')).toBe('15000k');
    });

    it('defaults to 720p for unknown resolution', () => {
        expect(getBitrate('unknown')).toBe('2500k');
        expect(getBitrate()).toBe('2500k');
    });
});

describe('getResolutionDimensions', () => {
    it('returns 16:9 for raw-cuts format', () => {
        const dims = getResolutionDimensions('720p', 'raw-cuts');
        expect(dims).toEqual({ w: 1280, h: 720, aspectRatio: '16:9' });
    });

    it('returns 16:9 for landscape-16-9 format', () => {
        const dims = getResolutionDimensions('1080p', 'landscape-16-9');
        expect(dims).toEqual({ w: 1920, h: 1080, aspectRatio: '16:9' });
    });

    it('returns 1:1 for square formats', () => {
        for (const fmt of ['square-blur', 'square-blur-motion', 'square-zoom']) {
            const dims = getResolutionDimensions('720p', fmt);
            expect(dims.aspectRatio).toBe('1:1');
            expect(dims.w).toBe(720);
            expect(dims.h).toBe(720);
        }
    });

    it('returns 3:4 for Instagram post formats', () => {
        const igFormats = ['ig-post-blur', 'ig-post-blur-motion', 'ig-post-crop', 'ig-post', 'ig-post-motion', 'portrait-3-4', 'portrait-3-4-motion', 'portrait-3-4-crop'];
        for (const fmt of igFormats) {
            const dims = getResolutionDimensions('720p', fmt);
            expect(dims.aspectRatio).toBe('3:4');
            expect(dims.w).toBe(720);
            expect(dims.h).toBe(960);
        }
    });

    it('returns 9:16 for stacked/portrait formats (default)', () => {
        for (const fmt of ['stacked-blur', 'stacked-blur-motion', 'center-crop', 'portrait-square']) {
            const dims = getResolutionDimensions('720p', fmt);
            expect(dims.aspectRatio).toBe('9:16');
            expect(dims.w).toBe(720);
            expect(dims.h).toBe(1280);
        }
    });

    it('defaults to 720p when unknown resolution given', () => {
        const dims = getResolutionDimensions('unknown', 'stacked-blur');
        expect(dims.w).toBe(720);
        expect(dims.h).toBe(1280);
    });

    it('defaults to 9:16 stacked-blur when no format given', () => {
        const dims = getResolutionDimensions('720p');
        expect(dims.aspectRatio).toBe('9:16');
    });

    it('defaults to 720p 9:16 when no args given', () => {
        const dims = getResolutionDimensions();
        expect(dims).toEqual({ w: 720, h: 1280, aspectRatio: '9:16' });
    });
});
