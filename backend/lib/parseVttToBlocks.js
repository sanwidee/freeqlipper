/**
 * VTT to CaptionBlocks Parser
 * Converts VTT subtitle files into CaptionBlock format for the caption engine.
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse VTT timestamp to seconds
 * @param {string} timestamp - Format: "00:00:01.234" or "00:01.234"
 * @returns {number} - Time in seconds
 */
function parseTimestamp(timestamp) {
    const parts = timestamp.trim().split(':');

    if (parts.length === 3) {
        // HH:MM:SS.mmm
        const [hours, minutes, seconds] = parts;
        return parseFloat(hours) * 3600 + parseFloat(minutes) * 60 + parseFloat(seconds);
    } else if (parts.length === 2) {
        // MM:SS.mmm
        const [minutes, seconds] = parts;
        return parseFloat(minutes) * 60 + parseFloat(seconds);
    }

    return 0;
}

/**
 * Parse VTT content into caption blocks
 * @param {string} vttContent - Raw VTT file content
 * @returns {Array<{id: string, startTime: number, endTime: number, words: Array<{text: string, emphasis: boolean}>}>}
 */
function parseVttToBlocks(vttContent) {
    const lines = vttContent.split(/\r?\n/);
    const blocks = [];

    let currentBlock = null;
    let blockIndex = 0;

    // Regex for VTT timestamp line: "00:00:01.000 --> 00:00:05.000"
    const timestampRegex = /(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/;

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip WEBVTT header, NOTE lines, and empty lines
        if (trimmedLine === 'WEBVTT' ||
            trimmedLine.startsWith('NOTE') ||
            trimmedLine.startsWith('STYLE') ||
            trimmedLine === '' ||
            /^\d+$/.test(trimmedLine)) { // Skip numeric cue identifiers
            continue;
        }

        // Check for timestamp line
        const timestampMatch = trimmedLine.match(timestampRegex);

        if (timestampMatch) {
            // Save previous block if exists
            if (currentBlock && currentBlock.words.length > 0) {
                blocks.push(currentBlock);
            }

            // Start new block
            const startTime = parseTimestamp(timestampMatch[1].replace(',', '.'));
            const endTime = parseTimestamp(timestampMatch[2].replace(',', '.'));

            currentBlock = {
                id: `block_${blockIndex++}`,
                startTime,
                endTime,
                words: [],
                preset: 'karaoke',
                position: { x: 50, y: 85 }
            };
        } else if (currentBlock && trimmedLine !== '') {
            // This is caption text - parse into words
            // Remove HTML tags like <c>, </c>, &nbsp;, etc.
            const cleanText = trimmedLine
                .replace(/<[^>]*>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .trim();

            if (cleanText) {
                const words = cleanText.split(/\s+/).filter(w => w.trim());
                for (const word of words) {
                    currentBlock.words.push({
                        text: word,
                        emphasis: false
                    });
                }
            }
        }
    }

    // Don't forget the last block
    if (currentBlock && currentBlock.words.length > 0) {
        blocks.push(currentBlock);
    }

    return blocks;
}

/**
 * Parse VTT file and return caption blocks
 * @param {string} vttPath - Path to VTT file
 * @returns {Array|null} - Caption blocks or null if file doesn't exist
 */
function parseVttFile(vttPath) {
    if (!fs.existsSync(vttPath)) {
        console.warn(`[VTT-PARSER] File not found: ${vttPath}`);
        return null;
    }

    try {
        const content = fs.readFileSync(vttPath, 'utf-8');
        return parseVttToBlocks(content);
    } catch (err) {
        console.error(`[VTT-PARSER] Error reading file: ${err.message}`);
        return null;
    }
}

/**
 * Find and parse VTT file for a given video
 * Searches multiple locations: video directory, assets/transcripts, etc.
 * @param {string} videoPath - Path to video file
 * @param {string} appDir - App directory (for finding assets/transcripts)
 * @returns {Object|null} - { blocks, vttPath } or null
 */
function findAndParseVttForVideo(videoPath, appDir = null) {
    const dir = path.dirname(videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));
    
    // List of directories to search for VTT
    const searchDirs = [dir];
    
    // Add assets/transcripts if appDir is provided
    if (appDir) {
        searchDirs.push(path.join(appDir, 'assets', 'transcripts'));
        searchDirs.push(path.join(appDir, 'assets'));
    }
    
    // Also try parent directories
    const parentDir = path.dirname(dir);
    if (parentDir !== dir) {
        searchDirs.push(parentDir);
        searchDirs.push(path.join(parentDir, 'assets', 'transcripts'));
    }

    // Search each directory
    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;
        
        try {
            const files = fs.readdirSync(searchDir);
            
            // Try exact match first
            let vttFile = files.find(f => f.startsWith(baseName) && f.endsWith('.vtt'));
            
            // Try with any language code (not limited to en/id)
            if (!vttFile) {
                vttFile = files.find(f =>
                    f.startsWith(baseName) &&
                    /\.[a-z]{2}(-[a-zA-Z]+)?\.\w*vtt$/i.test(f)
                );
            }
            
            // Try fuzzy match (video name might be slightly different)
            if (!vttFile) {
                // Normalize the base name for comparison
                const normalizedBase = baseName.toLowerCase().replace(/[^a-z0-9]/g, '');
                vttFile = files.find(f => {
                    if (!f.endsWith('.vtt')) return false;
                    const normalizedVtt = f.toLowerCase().replace(/[^a-z0-9]/g, '');
                    return normalizedVtt.includes(normalizedBase) || normalizedBase.includes(normalizedVtt.replace('vtt', ''));
                });
            }
            
            if (vttFile) {
                const vttPath = path.join(searchDir, vttFile);
                console.log(`[VTT-PARSER] Found VTT file: ${vttPath}`);
                return {
                    blocks: parseVttFile(vttPath),
                    vttPath
                };
            }
        } catch (err) {
            console.warn(`[VTT-PARSER] Error searching ${searchDir}: ${err.message}`);
        }
    }

    console.warn(`[VTT-PARSER] No VTT file found for: ${baseName}`);
    return null;
}

/**
 * Distribute word-level timing within a block
 * Evenly distributes time across words for karaoke effect
 * @param {Object} block - Caption block
 * @returns {Object} - Block with word timings added
 */
function addWordTimings(block) {
    if (!block.words || block.words.length === 0) return block;

    const duration = block.endTime - block.startTime;

    // Weight timing by character length - longer words get more time.
    // Minimum 2 chars for very short words like "I", "a" to avoid micro-durations.
    const effectiveLengths = block.words.map(w => Math.max(2, w.text.length));
    const totalChars = effectiveLengths.reduce((sum, len) => sum + len, 0);

    let currentTime = block.startTime;
    const timedWords = block.words.map((word, idx) => {
        const wordDuration = (effectiveLengths[idx] / totalChars) * duration;
        const start = currentTime;
        const end = currentTime + wordDuration;
        currentTime = end;
        return {
            ...word,
            startTime: start,
            endTime: end
        };
    });

    return {
        ...block,
        words: timedWords
    };
}

/**
 * Deduplicate VTT blocks that use "progressive reveal" pattern.
 * YouTube auto-captions often repeat earlier words in later blocks:
 *   Block 1: "capek terus"
 *   Block 2: "capek terus kadang-kadang"
 *   Block 3: "capek terus kadang-kadang kita"
 *
 * This function keeps only the NEW words from each block, preventing
 * the same text from being rendered multiple times on screen.
 * It also enforces a minimum word display duration for readability.
 *
 * @param {Array} blocks - Parsed VTT blocks (already with word timings)
 * @param {number} minWordDurationSec - Minimum seconds per word (default 0.3)
 * @returns {Array} - Deduplicated blocks with only new words
 */
function deduplicateBlocks(blocks, minWordDurationSec = 0.3) {
    if (!blocks || blocks.length === 0) return blocks;

    const result = [];
    const seenWords = []; // Track recently shown word texts + their end times
    let lastBlockEndTime = 0;  // Track end of previous block to prevent overlap

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block.words || block.words.length === 0) continue;

        // Find words in this block that are genuinely NEW
        // Compare against the running list of recently seen words
        const blockWordTexts = block.words.map(w => w.text.toLowerCase().replace(/[^a-z0-9]/g, ''));

        // Check if this block's words start with a prefix of already-seen words
        let newStartIdx = 0;
        if (seenWords.length > 0) {
            // Find how many leading words in this block match the tail of seenWords
            for (let j = 0; j < blockWordTexts.length && j < seenWords.length; j++) {
                // Look for this block's word[j] in seenWords
                const matchIdx = seenWords.findIndex((sw, si) =>
                    si >= seenWords.length - blockWordTexts.length &&
                    sw.text === blockWordTexts[j]
                );
                if (matchIdx !== -1) {
                    newStartIdx = j + 1;
                } else {
                    break;
                }
            }
        }

        // Extract only the new words
        const newWords = block.words.slice(newStartIdx);
        if (newWords.length === 0) continue;

        // Recalculate timing for the new words.
        // Ensure this block doesn't start before the previous block ended (prevents
        // two ASS dialogue lines from overlapping and showing at the same position).
        const rawBlockStart = newWords[0].startTime;
        const newBlockStart = Math.max(rawBlockStart, lastBlockEndTime);
        const newBlockEnd = Math.max(block.endTime, newBlockStart + 0.1); // at least 100ms
        const newDuration = newBlockEnd - newBlockStart;

        // Enforce minimum word display duration
        const effectiveLengths = newWords.map(w => Math.max(2, w.text.length));
        const totalChars = effectiveLengths.reduce((sum, len) => sum + len, 0);

        let currentTime = newBlockStart;
        const timedNewWords = newWords.map((word, idx) => {
            const rawDuration = (effectiveLengths[idx] / totalChars) * newDuration;
            const wordDuration = Math.max(rawDuration, minWordDurationSec);
            const start = currentTime;
            const end = Math.min(start + wordDuration, newBlockEnd);
            currentTime = end;
            return {
                ...word,
                startTime: start,
                endTime: end
            };
        });

        // Add the new words to seen list
        for (const w of timedNewWords) {
            seenWords.push({ text: w.text.toLowerCase().replace(/[^a-z0-9]/g, ''), endTime: w.endTime });
        }

        // Evict old seen words that are more than 10 seconds old
        const cutoffTime = block.startTime - 10;
        while (seenWords.length > 0 && seenWords[0].endTime < cutoffTime) {
            seenWords.shift();
        }

        const blockEnd = timedNewWords[timedNewWords.length - 1].endTime;
        lastBlockEndTime = blockEnd;

        result.push({
            ...block,
            startTime: timedNewWords[0].startTime,
            endTime: blockEnd,
            words: timedNewWords
        });
    }

    return result;
}

/**
 * Convert Whisper word-level transcript to CaptionBlocks.
 * Unlike VTT parsing, Whisper provides real start/end times per word,
 * so NO interpolation is needed — each word has its actual timestamp.
 *
 * @param {Object} whisperResult - Whisper JSON output with word_timestamps=True
 *   Expected shape: { text, language, segments: [{ start, end, text, words: [{ word, start, end, probability }] }] }
 * @param {Object} options - Optional configuration
 * @param {number} options.maxWordsPerBlock - Max words per caption block (default 6)
 * @param {number} options.maxBlockDuration - Max seconds per block (default 4)
 * @param {number} options.minWordGapForSplit - If gap between words exceeds this, force new block (default 0.8)
 * @returns {Array} - CaptionBlock[] with real word-level timestamps
 */
function whisperToCaptionBlocks(whisperResult, options = {}) {
    const {
        maxWordsPerBlock = 6,
        maxBlockDuration = 4,
        minWordGapForSplit = 0.8
    } = options;

    if (!whisperResult || !whisperResult.segments) return [];

    // Helper: convert timestamp to seconds (handles both numeric seconds and VTT strings like "00:02:59.000")
    const toSeconds = (val) => {
        if (typeof val === 'number') return val;
        if (typeof val === 'string' && val.includes(':')) return parseTimestamp(val);
        return parseFloat(val) || 0;
    };

    // Flatten all words from all segments into a single array with real timestamps
    const allWords = [];
    for (const segment of whisperResult.segments) {
        const segStart = toSeconds(segment.start);
        const segEnd = toSeconds(segment.end);

        if (!segment.words || segment.words.length === 0) {
            // Fallback: if segment has no word-level data, split text and interpolate
            if (segment.text) {
                const words = segment.text.trim().split(/\s+/).filter(w => w);
                const segDuration = segEnd - segStart;
                const wordDuration = Math.max(0.3, segDuration / Math.max(1, words.length));
                words.forEach((word, idx) => {
                    allWords.push({
                        text: word,
                        startTime: segStart + idx * wordDuration,
                        endTime: segStart + (idx + 1) * wordDuration,
                        hasRealTimestamp: false,
                        probability: 0
                    });
                });
            }
            continue;
        }

        for (const w of segment.words) {
            const wordText = (w.word || '').trim();
            if (!wordText) continue;

            allWords.push({
                text: wordText,
                startTime: toSeconds(w.start),
                endTime: toSeconds(w.end),
                hasRealTimestamp: true,
                probability: w.probability || 0,
                emphasis: false
            });
        }
    }

    if (allWords.length === 0) return [];

    // Group words into blocks based on natural breaks and limits
    const blocks = [];
    let currentBlockWords = [];
    let blockStartTime = allWords[0].startTime;

    const flushBlock = () => {
        if (currentBlockWords.length === 0) return;
        const blockEnd = currentBlockWords[currentBlockWords.length - 1].endTime;
        blocks.push({
            id: `whisper_block_${blocks.length}`,
            startTime: currentBlockWords[0].startTime,
            endTime: blockEnd,
            words: currentBlockWords.map(w => ({
                text: w.text,
                startTime: w.startTime,
                endTime: w.endTime,
                emphasis: false,
                hasRealTimestamp: w.hasRealTimestamp
            })),
            preset: 'karaoke',
            position: { x: 50, y: 85 },
            source: 'whisper'
        });
        currentBlockWords = [];
    };

    for (let i = 0; i < allWords.length; i++) {
        const word = allWords[i];

        // Check if we should start a new block
        if (currentBlockWords.length > 0) {
            const blockDuration = word.endTime - blockStartTime;
            const prevWord = currentBlockWords[currentBlockWords.length - 1];
            const gap = word.startTime - prevWord.endTime;

            const shouldSplit =
                currentBlockWords.length >= maxWordsPerBlock ||
                blockDuration > maxBlockDuration ||
                gap > minWordGapForSplit;

            if (shouldSplit) {
                flushBlock();
                blockStartTime = word.startTime;
            }
        } else {
            blockStartTime = word.startTime;
        }

        currentBlockWords.push(word);
    }

    // Flush remaining words
    flushBlock();

    return blocks;
}

/**
 * Read and parse a Whisper JSON transcript file into CaptionBlocks.
 * Checks if the file has word-level timestamps (from word_timestamps=True).
 * Falls back to segment-level interpolation if word data is missing.
 *
 * @param {string} jsonPath - Path to Whisper JSON output
 * @param {Object} options - Options for whisperToCaptionBlocks
 * @returns {Object|null} - { blocks, source: 'whisper'|'whisper-segment', hasWordTimestamps }
 */
function parseWhisperTranscript(jsonPath, options = {}) {
    if (!fs.existsSync(jsonPath)) {
        console.warn(`[WHISPER-PARSER] File not found: ${jsonPath}`);
        return null;
    }

    try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);

        if (!data.segments || data.segments.length === 0) {
            console.warn(`[WHISPER-PARSER] No segments in transcript: ${jsonPath}`);
            return null;
        }

        // Check if word-level timestamps exist
        const hasWordTimestamps = data.segments.some(s => s.words && s.words.length > 0);

        const blocks = whisperToCaptionBlocks(data, options);

        console.log(`[WHISPER-PARSER] Parsed ${blocks.length} blocks from ${jsonPath} (word-level: ${hasWordTimestamps})`);

        return {
            blocks,
            source: hasWordTimestamps ? 'whisper' : 'whisper-segment',
            hasWordTimestamps,
            language: data.language || 'unknown'
        };
    } catch (err) {
        console.error(`[WHISPER-PARSER] Error parsing transcript: ${err.message}`);
        return null;
    }
}

/**
 * Find and parse a Whisper transcript JSON file for a given video.
 * Searches in assets/transcripts/ directory.
 *
 * @param {string} videoPath - Path to video file
 * @param {string} appDir - App directory root
 * @param {Object} options - Options for whisperToCaptionBlocks
 * @returns {Object|null} - { blocks, source, hasWordTimestamps, transcriptPath }
 */
function findAndParseWhisperForVideo(videoPath, appDir = null, options = {}) {
    const baseName = path.basename(videoPath, path.extname(videoPath));

    const searchDirs = [];
    if (appDir) {
        searchDirs.push(path.join(appDir, 'assets', 'transcripts'));
        searchDirs.push(path.join(appDir, 'assets'));
    }
    const dir = path.dirname(videoPath);
    searchDirs.push(dir);

    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;

        try {
            const files = fs.readdirSync(searchDir);

            // Look for JSON transcript matching the video name
            const jsonFile = files.find(f =>
                f.endsWith('_transcript.json') &&
                f.startsWith(baseName.substring(0, Math.min(baseName.length, 30)))
            ) || files.find(f =>
                f.endsWith('.json') &&
                f.toLowerCase().includes(baseName.toLowerCase().substring(0, 20))
            );

            if (jsonFile) {
                const jsonPath = path.join(searchDir, jsonFile);
                const result = parseWhisperTranscript(jsonPath, options);
                if (result && result.blocks && result.blocks.length > 0) {
                    return {
                        ...result,
                        transcriptPath: jsonPath
                    };
                }
            }
        } catch (err) {
            console.warn(`[WHISPER-PARSER] Error searching ${searchDir}: ${err.message}`);
        }
    }

    return null;
}

module.exports = {
    parseTimestamp,
    parseVttToBlocks,
    parseVttFile,
    findAndParseVttForVideo,
    addWordTimings,
    deduplicateBlocks,
    whisperToCaptionBlocks,
    parseWhisperTranscript,
    findAndParseWhisperForVideo
};
