import { describe, it, expect } from 'vitest';
import { parseVttToBlocks, parseTimestamp } from '../../lib/parseVttToBlocks.js';

// Sample VTT content for testing
const SAMPLE_VTT = `WEBVTT

00:00:01.000 --> 00:00:05.000
Hello world this is a test

00:00:05.500 --> 00:00:10.000
Second block of text here

00:00:10.500 --> 00:00:15.000
Third and final block
`;

const VTT_WITH_HTML_TAGS = `WEBVTT

00:00:01.000 --> 00:00:03.000
<c>Hello</c> <c>world</c>

00:00:03.500 --> 00:00:06.000
Testing &amp; escaping &lt;tags&gt;
`;

const VTT_WITH_NUMERIC_IDS = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
First cue

2
00:00:04.000 --> 00:00:06.000
Second cue
`;

const VTT_MM_SS_FORMAT = `WEBVTT

00:01.000 --> 00:05.000
Short format timestamps
`;

const EMPTY_VTT = `WEBVTT
`;

describe('parseTimestamp', () => {
    it('parses HH:MM:SS.mmm format', () => {
        expect(parseTimestamp('00:01:30.500')).toBeCloseTo(90.5, 2);
        expect(parseTimestamp('01:00:00.000')).toBe(3600);
    });

    it('parses MM:SS.mmm format', () => {
        expect(parseTimestamp('01:30.500')).toBeCloseTo(90.5, 2);
        expect(parseTimestamp('00:05.000')).toBe(5);
    });

    it('handles whitespace', () => {
        expect(parseTimestamp('  00:01:00.000  ')).toBe(60);
    });
});

describe('parseVttToBlocks', () => {
    it('parses basic VTT into blocks', () => {
        const blocks = parseVttToBlocks(SAMPLE_VTT);
        expect(blocks).toHaveLength(3);
    });

    it('extracts correct timestamps', () => {
        const blocks = parseVttToBlocks(SAMPLE_VTT);
        expect(blocks[0].startTime).toBeCloseTo(1.0, 2);
        expect(blocks[0].endTime).toBeCloseTo(5.0, 2);
        expect(blocks[1].startTime).toBeCloseTo(5.5, 2);
        expect(blocks[1].endTime).toBeCloseTo(10.0, 2);
    });

    it('extracts words from text', () => {
        const blocks = parseVttToBlocks(SAMPLE_VTT);
        expect(blocks[0].words).toHaveLength(6); // "Hello world this is a test"
        expect(blocks[0].words[0].text).toBe('Hello');
        expect(blocks[0].words[1].text).toBe('world');
    });

    it('strips HTML/VTT tags from text', () => {
        const blocks = parseVttToBlocks(VTT_WITH_HTML_TAGS);
        expect(blocks[0].words.map(w => w.text)).toEqual(['Hello', 'world']);
    });

    it('decodes HTML entities', () => {
        const blocks = parseVttToBlocks(VTT_WITH_HTML_TAGS);
        const text = blocks[1].words.map(w => w.text).join(' ');
        expect(text).toContain('&');
        expect(text).toContain('<tags>');
    });

    it('skips numeric cue identifiers', () => {
        const blocks = parseVttToBlocks(VTT_WITH_NUMERIC_IDS);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].words[0].text).toBe('First');
    });

    it('handles MM:SS.mmm timestamp format', () => {
        const blocks = parseVttToBlocks(VTT_MM_SS_FORMAT);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].startTime).toBeCloseTo(1.0, 2);
        expect(blocks[0].endTime).toBeCloseTo(5.0, 2);
    });

    it('handles empty VTT', () => {
        const blocks = parseVttToBlocks(EMPTY_VTT);
        expect(blocks).toHaveLength(0);
    });

    it('assigns sequential block IDs', () => {
        const blocks = parseVttToBlocks(SAMPLE_VTT);
        expect(blocks[0].id).toBe('block_0');
        expect(blocks[1].id).toBe('block_1');
        expect(blocks[2].id).toBe('block_2');
    });

    it('each block has required properties', () => {
        const blocks = parseVttToBlocks(SAMPLE_VTT);
        for (const block of blocks) {
            expect(block).toHaveProperty('id');
            expect(block).toHaveProperty('startTime');
            expect(block).toHaveProperty('endTime');
            expect(block).toHaveProperty('words');
            expect(block.startTime).toBeLessThan(block.endTime);
            expect(block.words.length).toBeGreaterThan(0);
        }
    });
});
