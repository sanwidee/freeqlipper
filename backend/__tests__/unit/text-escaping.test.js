import { describe, it, expect } from 'vitest';
import { escapeForFFmpegDrawtext, escapePathForFFmpegFilter } from '../../utils/text-escaping.js';

describe('escapeForFFmpegDrawtext', () => {
    it('escapes backslashes', () => {
        expect(escapeForFFmpegDrawtext('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('escapes colons', () => {
        expect(escapeForFFmpegDrawtext('time: 12:30')).toBe('time\\: 12\\:30');
    });

    it('escapes single quotes', () => {
        expect(escapeForFFmpegDrawtext("it's a test")).toBe("it\\'s a test");
    });

    it('escapes brackets (v1.6.4 regression guard)', () => {
        expect(escapeForFFmpegDrawtext('[Topic 1]')).toBe('\\[Topic 1\\]');
    });

    it('escapes commas', () => {
        expect(escapeForFFmpegDrawtext('hello, world')).toBe('hello\\, world');
    });

    it('escapes semicolons (filter separator)', () => {
        expect(escapeForFFmpegDrawtext('part1; part2')).toBe('part1\\; part2');
    });

    it('handles text with multiple special characters', () => {
        const input = "[Topic]: it's a 'test'; value=1,2";
        const result = escapeForFFmpegDrawtext(input);
        // All special chars should be escaped with backslash
        expect(result).toContain('\\[');
        expect(result).toContain('\\]');
        expect(result).toContain('\\:');
        expect(result).toContain('\\;');
        expect(result).toContain('\\,');
    });

    it('handles empty string', () => {
        expect(escapeForFFmpegDrawtext('')).toBe('');
    });

    it('passes through safe text unchanged', () => {
        expect(escapeForFFmpegDrawtext('Hello World 123')).toBe('Hello World 123');
    });
});

describe('escapePathForFFmpegFilter', () => {
    it('normalizes backslashes to forward slashes', () => {
        const result = escapePathForFFmpegFilter('C:\\Users\\test\\file.ass');
        expect(result).toContain('/');
        // Original backslash path separators should be converted to forward slashes
        expect(result).toContain('/Users/test/file.ass');
    });

    it('escapes colons in paths', () => {
        const result = escapePathForFFmpegFilter('C:/Users/test/file.ass');
        expect(result).toContain('\\:');
    });

    it('escapes single quotes in paths', () => {
        const result = escapePathForFFmpegFilter("/Users/it's me/file.ass");
        expect(result).toContain("'\\''");
    });

    it('escapes brackets in paths', () => {
        const result = escapePathForFFmpegFilter('/Users/test/[project]/file.ass');
        expect(result).toContain('\\[');
        expect(result).toContain('\\]');
    });

    it('handles Unix paths without special chars', () => {
        const result = escapePathForFFmpegFilter('/Users/test/project/file.ass');
        expect(result).toBe('/Users/test/project/file.ass');
    });

    it('handles Windows paths with drive letter', () => {
        const result = escapePathForFFmpegFilter('C:\\Users\\test\\file.ass');
        // Should normalize slashes and escape the colon
        expect(result).toContain('C\\:');
        expect(result).toContain('/Users/test/file.ass');
    });
});
