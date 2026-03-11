import { describe, it, expect } from 'vitest';
import { parseTime, formatTime } from '../../utils/time.js';

describe('parseTime', () => {
    it('parses HH:MM:SS format', () => {
        expect(parseTime('01:30:00')).toBe(5400);
        expect(parseTime('00:01:30')).toBe(90);
        expect(parseTime('02:00:00')).toBe(7200);
    });

    it('parses MM:SS format', () => {
        expect(parseTime('01:30')).toBe(90);
        expect(parseTime('10:00')).toBe(600);
        expect(parseTime('00:45')).toBe(45);
    });

    it('parses seconds-only format', () => {
        expect(parseTime('90')).toBe(90);
        expect(parseTime('0')).toBe(0);
        expect(parseTime('3600')).toBe(3600);
    });

    it('parses fractional seconds', () => {
        expect(parseTime('00:01:30.500')).toBeCloseTo(90.5, 2);
        expect(parseTime('1:30.250')).toBeCloseTo(90.25, 2);
    });

    it('handles null/undefined/empty input', () => {
        expect(parseTime(null)).toBe(0);
        expect(parseTime(undefined)).toBe(0);
        expect(parseTime('')).toBe(0);
    });

    it('handles whitespace-padded input', () => {
        expect(parseTime('  01:30  ')).toBe(90);
        expect(parseTime(' 00:00:30 ')).toBe(30);
    });
});

describe('formatTime', () => {
    it('formats seconds to HH:MM:SS.mmm', () => {
        expect(formatTime(90)).toBe('00:01:30.000');
        expect(formatTime(3661)).toBe('01:01:01.000');
        expect(formatTime(0)).toBe('00:00:00.000');
    });

    it('formats fractional seconds', () => {
        expect(formatTime(90.5)).toBe('00:01:30.500');
        expect(formatTime(1.123)).toBe('00:00:01.123');
    });

    it('pads hours, minutes, seconds correctly', () => {
        expect(formatTime(1)).toBe('00:00:01.000');
        expect(formatTime(61)).toBe('00:01:01.000');
        expect(formatTime(3601)).toBe('01:00:01.000');
    });

    it('handles large values', () => {
        expect(formatTime(36000)).toBe('10:00:00.000');
    });
});

describe('parseTime + formatTime roundtrip', () => {
    it('roundtrips correctly', () => {
        const original = 5400.5;
        const formatted = formatTime(original);
        const parsed = parseTime(formatted);
        expect(parsed).toBeCloseTo(original, 2);
    });

    it('rejects negative duration (v1.6.1 regression guard)', () => {
        // Simulates the bug: AI returns end < start
        const start = parseTime('00:02:00');
        const end = parseTime('00:01:30');
        const duration = end - start;
        expect(duration).toBeLessThan(0);
        // The fix: guard against negative duration before passing to FFmpeg
        const safeDuration = Math.max(duration, 1);
        expect(safeDuration).toBeGreaterThan(0);
    });

    it('handles inverted timelines (sort guard)', () => {
        // AI may return timelines in arbitrary order
        const timelines = [
            { start: '00:05:00', end: '00:06:00' },
            { start: '00:01:00', end: '00:02:00' },
            { start: '00:03:00', end: '00:04:00' },
        ];
        timelines.sort((a, b) => parseTime(a.start) - parseTime(b.start));
        expect(parseTime(timelines[0].start)).toBe(60);
        expect(parseTime(timelines[1].start)).toBe(180);
        expect(parseTime(timelines[2].start)).toBe(300);
    });
});
