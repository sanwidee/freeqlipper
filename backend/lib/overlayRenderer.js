/**
 * Overlay Renderer - Renders text overlays to transparent PNG using Puppeteer
 * This creates pixel-perfect overlays that match the frontend preview exactly.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Font family mapping
const FONT_FAMILY_MAP = {
    'Sans-Bold': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'Poppins-Black': '"Poppins", sans-serif',
    'Arial-Bold': 'Arial, sans-serif',
    'Helvetica-Bold': 'Helvetica, sans-serif',
    'Impact': 'Impact, sans-serif',
    'Roboto-Bold': '"Roboto", sans-serif',
    'Komika-Axis': '"Komika Axis", sans-serif',
    'The-Bold-Font': '"The Bold Font", sans-serif',
};

// Custom font directory for bundled fonts
const CUSTOM_FONTS_DIR = path.join(__dirname, '..', 'fonts');

// Load Komika Axis font as base64 for Puppeteer embedding
let komikaAxisBase64 = null;
try {
    const fontPath = path.join(CUSTOM_FONTS_DIR, 'KOMIKAX_.ttf');
    if (fs.existsSync(fontPath)) {
        komikaAxisBase64 = fs.readFileSync(fontPath).toString('base64');
    }
} catch (e) {
    console.warn('[OVERLAY] Could not load Komika Axis font:', e.message);
}

// Load The Bold Font as base64 for Puppeteer embedding
let theBoldFontBase64 = null;
try {
    const fontPath = path.join(CUSTOM_FONTS_DIR, 'THEBOLDFONT-FREEVERSION.ttf');
    if (fs.existsSync(fontPath)) {
        theBoldFontBase64 = fs.readFileSync(fontPath).toString('base64');
    }
} catch (e) {
    console.warn('[OVERLAY] Could not load The Bold Font:', e.message);
}

/**
 * Generate HTML for text overlay
 */
function generateOverlayHTML(options) {
    const {
        text = 'Hook Text',
        textColor = '#00FF00',
        backgroundColor = 'transparent',
        bgEnabled = false,
        outlineEnabled = true, // Allow disabling outline
        shadowEnabled = true,  // Allow disabling shadow
        borderColor = '#000000',
        borderWidth = 8,
        fontFamily = 'Sans-Bold',
        fontSize = 72,
        alignment = 'center',
        verticalPosition = 75,
        width = 1080,
        height = 1920,
        // Sticker options
        stickerEnabled = false,
        stickerText = '',
        stickerShape = 'pill',        // pill, comment-bubble, arrow-badge, star-burst, tape-strip
        stickerBgColor = '#FF3B30',
        stickerTextColor = '#FFFFFF',
        stickerImagePath = null,       // Custom image path (overrides shape)
    } = options;

    // Determine which font to use and if we need Google Fonts
    const isPoppins = fontFamily.toLowerCase().includes('poppins');
    const isRoboto = fontFamily.toLowerCase().includes('roboto');
    const isKomika = fontFamily.toLowerCase().includes('komika');
    const isBoldFont = fontFamily.toLowerCase().includes('bold-font');
    const needsGoogleFonts = isPoppins || isRoboto;

    // CSS font family string
    let cssFont;
    if (isPoppins) {
        cssFont = '"Poppins", sans-serif';
    } else if (isRoboto) {
        cssFont = '"Roboto", sans-serif';
    } else if (isKomika) {
        cssFont = '"Komika Axis", sans-serif';
    } else if (isBoldFont) {
        cssFont = '"The Bold Font", sans-serif';
    } else {
        cssFont = FONT_FAMILY_MAP[fontFamily] || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    }

    const justifyContent = alignment === 'left' ? 'flex-start' : alignment === 'right' ? 'flex-end' : 'center';

    // Scale font size and stroke width based on resolution
    const scaledFontSize = Math.round((fontSize / 1080) * width);
    const scaledStrokeWidth = Math.round((borderWidth / 1080) * width);

    // Use -webkit-text-stroke for smooth outlines (much better than text-shadow)
    // Only use stroke if: outline is enabled, background is disabled, and borderWidth > 0
    const useStroke = outlineEnabled && !bgEnabled && borderWidth > 0;
    const strokeStyle = useStroke ? `-webkit-text-stroke: ${scaledStrokeWidth}px ${borderColor};` : '';

    // Add subtle drop shadow for depth (only if shadow is enabled and not using background)
    const dropShadow = (shadowEnabled && !bgEnabled) ? '4px 4px 8px rgba(0,0,0,0.5)' : 'none';

    // Google Fonts link tag (more reliable than @import)
    const googleFontsLink = needsGoogleFonts
        ? '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@700;800;900&family=Roboto:wght@700;900&display=block" rel="stylesheet">'
        : '';

    // Embedded @font-face for custom bundled fonts
    const customFontFace = (isKomika && komikaAxisBase64)
        ? `@font-face { font-family: 'Komika Axis'; src: url(data:font/truetype;base64,${komikaAxisBase64}) format('truetype'); font-weight: normal; font-style: normal; }`
        : (isBoldFont && theBoldFontBase64)
            ? `@font-face { font-family: 'The Bold Font'; src: url(data:font/truetype;base64,${theBoldFontBase64}) format('truetype'); font-weight: normal; font-style: normal; }`
            : '';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    ${googleFontsLink}
    <style>
        ${customFontFace}
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            width: ${width}px;
            height: ${height}px;
            background: transparent;
            overflow: hidden;
        }
        
        .container {
            position: absolute;
            top: ${verticalPosition}%;
            left: 0;
            right: 0;
            transform: translateY(-50%);
            display: flex;
            justify-content: ${justifyContent};
            padding: 0 40px;
        }
        
        .text {
            color: ${textColor};
            font-family: ${cssFont};
            font-size: ${scaledFontSize}px;
            font-weight: 900;
            text-align: ${alignment};
            line-height: 1.15;
            /* Smooth stroke using paint-order trick for filled text with stroke */
            ${strokeStyle}
            paint-order: stroke fill;
            text-shadow: ${dropShadow};
            background-color: ${bgEnabled && backgroundColor !== 'transparent' ? backgroundColor : 'transparent'};
            padding: ${bgEnabled ? '15px 30px' : '0'};
            border-radius: ${bgEnabled ? '12px' : '0'};
            box-shadow: ${bgEnabled ? '4px 4px 12px rgba(0,0,0,0.4)' : 'none'};
            max-width: 90%;
            word-wrap: break-word;
            /* Improve text rendering for smoother edges */
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        
        .sticker-wrapper {
            display: flex;
            justify-content: ${justifyContent};
            margin-top: ${Math.round(scaledFontSize * 0.3)}px;
        }
        
        .sticker {
            display: inline-flex;
            align-items: center;
            gap: ${Math.round(scaledFontSize * 0.15)}px;
            font-family: ${cssFont};
            font-size: ${Math.round(scaledFontSize * 0.35)}px;
            font-weight: 800;
            color: ${stickerTextColor};
            background-color: ${stickerBgColor};
            padding: ${Math.round(scaledFontSize * 0.12)}px ${Math.round(scaledFontSize * 0.3)}px;
            box-shadow: 2px 2px 8px rgba(0,0,0,0.3);
            -webkit-font-smoothing: antialiased;
        }
        
        /* Shape presets */
        .sticker-pill { border-radius: 999px; }
        .sticker-comment-bubble {
            border-radius: ${Math.round(scaledFontSize * 0.15)}px;
            position: relative;
        }
        .sticker-comment-bubble::after {
            content: '';
            position: absolute;
            bottom: -${Math.round(scaledFontSize * 0.12)}px;
            left: ${Math.round(scaledFontSize * 0.3)}px;
            width: 0; height: 0;
            border-left: ${Math.round(scaledFontSize * 0.12)}px solid transparent;
            border-right: ${Math.round(scaledFontSize * 0.12)}px solid transparent;
            border-top: ${Math.round(scaledFontSize * 0.15)}px solid ${stickerBgColor};
        }
        .sticker-arrow-badge {
            border-radius: ${Math.round(scaledFontSize * 0.08)}px;
            clip-path: polygon(0% 0%, 90% 0%, 100% 50%, 90% 100%, 0% 100%, 10% 50%);
            padding-left: ${Math.round(scaledFontSize * 0.4)}px;
            padding-right: ${Math.round(scaledFontSize * 0.4)}px;
        }
        .sticker-star-burst {
            border-radius: ${Math.round(scaledFontSize * 0.08)}px;
            box-shadow: 2px 2px 8px rgba(0,0,0,0.3), 0 0 0 ${Math.round(scaledFontSize * 0.04)}px ${stickerBgColor}, 0 0 0 ${Math.round(scaledFontSize * 0.06)}px rgba(255,255,255,0.3);
        }
        .sticker-tape-strip {
            border-radius: 0;
            transform: rotate(-2deg);
            background: repeating-linear-gradient(
                45deg,
                ${stickerBgColor},
                ${stickerBgColor} 10px,
                ${stickerBgColor}dd 10px,
                ${stickerBgColor}dd 20px
            );
        }
        
        .sticker-image {
            display: flex;
            justify-content: ${justifyContent};
            margin-top: ${Math.round(scaledFontSize * 0.3)}px;
        }
        .sticker-image img {
            max-width: ${Math.round(width * 0.4)}px;
            max-height: ${Math.round(scaledFontSize * 1.5)}px;
            object-fit: contain;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="text">${escapeHtml(text)}</div>
        ${stickerEnabled && stickerImagePath ? `
        <div class="sticker-image">
            <img src="${toFileUri(stickerImagePath)}" alt="sticker" />
        </div>
        ` : stickerEnabled && stickerText ? `
        <div class="sticker-wrapper">
            <div class="sticker sticker-${stickerShape}">${escapeHtml(stickerText)}</div>
        </div>
        ` : ''}
    </div>
</body>
</html>
`;
}

/**
 * Convert an absolute file path to a proper file:// URI.
 * Handles Windows backslash paths (C:\foo\bar → file:///C:/foo/bar)
 * and Unix paths (/foo/bar → file:///foo/bar).
 */
function toFileUri(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    // Windows drive letter (e.g. C:/) needs triple slash
    if (/^[A-Za-z]:/.test(normalized)) {
        return 'file:///' + normalized;
    }
    return 'file://' + normalized;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Browser instance cache for performance
let browserInstance = null;

/**
 * Find a system-installed Chromium-based browser.
 * Used because .puppeteerrc.cjs sets skipDownload: true — Puppeteer will not
 * bundle its own Chromium. On Windows, Edge is always present (system component).
 * Priority: bundled Chromium (if previously downloaded) → Edge → Chrome → Chromium
 */
function findSystemBrowser() {
    // 1. Check if puppeteer's bundled Chrome exists (e.g. from a prior install)
    try {
        const bundledPath = puppeteer.executablePath();
        if (bundledPath && fs.existsSync(bundledPath)) {
            return bundledPath;
        }
    } catch {}

    if (process.platform === 'win32') {
        const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const localAppData = process.env['LOCALAPPDATA'] || '';
        const candidates = [
            // Edge — always present on Windows 10/11 (system component, cannot be uninstalled)
            path.join(progFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
            path.join(progFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
            // Chrome
            path.join(progFiles, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(progFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
    } else if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
    }

    return null;
}

/**
 * Get or create browser instance
 */
async function getBrowser() {
    if (!browserInstance || !browserInstance.isConnected()) {
        console.log('[OVERLAY] Launching Puppeteer browser...');

        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
            timeout: 60000,  // 60s timeout for first launch (Gatekeeper scan on macOS)
        };

        const execPath = findSystemBrowser();
        if (execPath) {
            launchOptions.executablePath = execPath;
            console.log(`[OVERLAY] Using browser: ${execPath}`);
        } else {
            console.warn('[OVERLAY] No system browser found — Puppeteer will attempt its default path');
        }

        browserInstance = await puppeteer.launch(launchOptions);
    }
    return browserInstance;
}

/**
 * Render text overlay to transparent PNG
 * 
 * @param {Object} options - Overlay options
 * @param {string} options.text - Text to display
 * @param {string} options.textColor - Text color (hex)
 * @param {string} options.backgroundColor - Background color (hex or 'transparent')
 * @param {boolean} options.bgEnabled - Whether background is enabled
 * @param {string} options.borderColor - Outline/border color (hex)
 * @param {number} options.borderWidth - Outline width in pixels
 * @param {string} options.fontFamily - Font family name
 * @param {number} options.fontSize - Font size in pixels
 * @param {string} options.alignment - Text alignment (left, center, right)
 * @param {number} options.verticalPosition - Vertical position (0-100%)
 * @param {number} options.width - Output width in pixels
 * @param {number} options.height - Output height in pixels
 * @param {string} outputPath - Path to save the PNG
 * 
 * @returns {Promise<string>} - Path to the generated PNG
 */
async function renderOverlayToPNG(options, outputPath) {
    const startTime = Date.now();
    console.log('[OVERLAY] Rendering text overlay to PNG...');
    console.log('[OVERLAY] Options:', JSON.stringify({
        text: options.text?.substring(0, 30) + '...',
        textColor: options.textColor,
        bgEnabled: options.bgEnabled,
        backgroundColor: options.backgroundColor,
        borderWidth: options.borderWidth,
        fontFamily: options.fontFamily,
        fontSize: options.fontSize,
        dimensions: `${options.width}x${options.height}`,
    }));

    try {
        const browser = await getBrowser();
        const page = await browser.newPage();

        // Set viewport to exact dimensions
        await page.setViewport({
            width: options.width || 1080,
            height: options.height || 1920,
            deviceScaleFactor: 1,
        });

        // Generate and load HTML
        const html = generateOverlayHTML(options);
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

        // Determine if we need to wait for custom/Google Fonts
        const fontFamily = options.fontFamily || 'Sans-Bold';
        const isPoppins = fontFamily.toLowerCase().includes('poppins');
        const isRoboto = fontFamily.toLowerCase().includes('roboto');
        const isKomika = fontFamily.toLowerCase().includes('komika');
        const isBoldFont = fontFamily.toLowerCase().includes('bold-font');
        const needsGoogleFonts = isPoppins || isRoboto;

        if (isKomika) {
            console.log(`[OVERLAY] Waiting for embedded font: Komika Axis`);
            await page.evaluate(async () => {
                await document.fonts.ready;
                try {
                    await document.fonts.load('900 72px "Komika Axis"');
                } catch (e) {
                    console.warn('Font load warning:', e);
                }
                await new Promise(resolve => setTimeout(resolve, 300));
            });
            console.log(`[OVERLAY] Font loaded: Komika Axis`);
        } else if (isBoldFont) {
            console.log(`[OVERLAY] Waiting for embedded font: The Bold Font`);
            await page.evaluate(async () => {
                await document.fonts.ready;
                try {
                    await document.fonts.load('900 72px "The Bold Font"');
                } catch (e) {
                    console.warn('Font load warning:', e);
                }
                await new Promise(resolve => setTimeout(resolve, 300));
            });
            console.log(`[OVERLAY] Font loaded: The Bold Font`);
        } else if (needsGoogleFonts) {
            console.log(`[OVERLAY] Waiting for Google Font: ${fontFamily}`);

            // Wait for fonts to load with explicit check
            await page.evaluate(async (targetFont) => {
                // Wait for document.fonts.ready first
                await document.fonts.ready;

                // Then explicitly check if the font is loaded
                const fontToCheck = targetFont.includes('Poppins') ? 'Poppins' : 'Roboto';

                // Try to load the font explicitly
                try {
                    await document.fonts.load(`900 72px "${fontToCheck}"`);
                } catch (e) {
                    console.warn('Font load warning:', e);
                }

                // Wait a bit more to ensure font is rendered
                await new Promise(resolve => setTimeout(resolve, 500));

                return true;
            }, fontFamily);

            console.log(`[OVERLAY] Font loaded: ${fontFamily}`);
        } else {
            // Just wait for basic font loading
            await page.evaluate(() => document.fonts.ready);
        }

        // Small delay to ensure render is complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Take screenshot with transparency
        await page.screenshot({
            path: outputPath,
            type: 'png',
            omitBackground: true, // Transparent background
        });

        await page.close();

        const elapsed = Date.now() - startTime;
        console.log(`[OVERLAY] PNG rendered in ${elapsed}ms: ${outputPath}`);

        return outputPath;
    } catch (error) {
        console.error('[OVERLAY] Error rendering overlay:', error.message);
        throw error;
    }
}

/**
 * Close browser instance (call on server shutdown)
 */
async function closeBrowser() {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
        console.log('[OVERLAY] Browser closed');
    }
}

/**
 * Get dimensions for aspect ratio
 */
function getDimensionsForFormat(format, resolution = '1080p') {
    const resolutionMap = {
        '360p': { base: 360 },
        '480p': { base: 480 },
        '720p': { base: 720 },
        '1080p': { base: 1080 },
        '1440p': { base: 1440 },
        '4k': { base: 2160 },
    };

    const base = resolutionMap[resolution]?.base || 1080;

    // Determine aspect ratio from format
    if (format.includes('9-16') || format.includes('portrait') || format.includes('stacked')) {
        // 9:16 Portrait
        return { width: base, height: Math.round(base * (16 / 9)) };
    } else if (format.includes('1-1') || format.includes('square')) {
        // 1:1 Square
        return { width: base, height: base };
    } else if (format.includes('3-4') || format.includes('ig-post')) {
        // 3:4 Instagram Post
        return { width: base, height: Math.round(base * (4 / 3)) };
    } else if (format.includes('16-9') || format.includes('landscape')) {
        // 16:9 Landscape
        return { width: Math.round(base * (16 / 9)), height: base };
    }

    // Default to 9:16
    return { width: base, height: Math.round(base * (16 / 9)) };
}

/**
 * Generate HTML for subtitle overlay (word-by-word or full line)
 */
function generateSubtitleHTML(options) {
    const {
        words = [],           // Array of { text, isHighlighted }
        textColor = '#FFFFFF',
        highlightColor = '#00FF66',
        backgroundColor = 'transparent',
        bgEnabled = false,
        outlineColor = '#000000',
        outlineWidth = 3,
        fontFamily = 'Sans-Bold',
        fontSize = 48,
        alignment = 'center',
        verticalPosition = 85,
        width = 1080,
        height = 1920,
        shadowEnabled = true,
        glowEffect = true,
        scaleEffect = false,
        highlightScale = 115,
        wordByWord = true,
    } = options;

    // Determine which font to use
    const isPoppins = fontFamily.toLowerCase().includes('poppins');
    const isRoboto = fontFamily.toLowerCase().includes('roboto');
    const isBoldFont = fontFamily.toLowerCase().includes('bold-font');
    const needsGoogleFonts = isPoppins || isRoboto;

    let cssFont;
    if (isPoppins) {
        cssFont = '"Poppins", sans-serif';
    } else if (isRoboto) {
        cssFont = '"Roboto", sans-serif';
    } else if (isBoldFont) {
        cssFont = '"The Bold Font", sans-serif';
    } else {
        cssFont = FONT_FAMILY_MAP[fontFamily] || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    }

    const justifyContent = alignment === 'left' ? 'flex-start' : alignment === 'right' ? 'flex-end' : 'center';

    // Scale font size and stroke width based on resolution
    const scaledFontSize = Math.round((fontSize / 1080) * width);
    const scaledStrokeWidth = Math.round((outlineWidth / 1080) * width);
    const scaleMultiplier = (scaleEffect && highlightScale > 100) ? highlightScale / 100 : 1;
    const scaledHighlightSize = Math.round(scaledFontSize * scaleMultiplier);

    // Google Fonts link
    const googleFontsLink = needsGoogleFonts
        ? '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@700;800;900&family=Roboto:wght@700;900&display=block" rel="stylesheet">'
        : '';

    // Build word spans with highlighting
    const wordSpans = words.map((word, idx) => {
        const isHighlighted = word.isHighlighted;
        const color = isHighlighted ? highlightColor : textColor;
        const size = isHighlighted && scaleEffect ? scaledHighlightSize : scaledFontSize;
        const glow = isHighlighted && glowEffect ? `0 0 20px ${highlightColor}, 0 0 40px ${highlightColor}40` : '';
        const shadow = shadowEnabled ? '3px 3px 6px rgba(0,0,0,0.6)' : '';
        const textShadow = [glow, shadow].filter(Boolean).join(', ') || 'none';

        return `<span class="word ${isHighlighted ? 'highlighted' : ''}" style="color: ${color}; font-size: ${size}px; text-shadow: ${textShadow};">${escapeHtml(word.text)}</span>`;
    }).join(' ');

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    ${googleFontsLink}
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            width: ${width}px;
            height: ${height}px;
            background: transparent;
            overflow: hidden;
        }
        
        .container {
            position: absolute;
            top: ${verticalPosition}%;
            left: 0;
            right: 0;
            transform: translateY(-50%);
            display: flex;
            justify-content: ${justifyContent};
            padding: 0 40px;
        }
        
        .subtitle-box {
            font-family: ${cssFont};
            font-weight: 900;
            text-align: ${alignment};
            line-height: 1.3;
            -webkit-text-stroke: ${scaledStrokeWidth}px ${outlineColor};
            paint-order: stroke fill;
            background-color: ${bgEnabled && backgroundColor !== 'transparent' ? backgroundColor : 'transparent'};
            padding: ${bgEnabled ? '15px 30px' : '0'};
            border-radius: ${bgEnabled ? '12px' : '0'};
            max-width: 95%;
            word-wrap: break-word;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        
        .word {
            display: inline;
            transition: all 0.1s ease;
        }
        
        .word.highlighted {
            display: inline-block;
            transform: ${scaleEffect && highlightScale > 100 ? `scale(${(highlightScale / 100).toFixed(2)})` : 'none'};
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="subtitle-box">${wordSpans}</div>
    </div>
</body>
</html>
`;
}

// Reusable page instance for subtitle rendering (much faster than creating new pages)
let subtitlePage = null;
let subtitlePageWidth = 0;
let subtitlePageHeight = 0;

/**
 * Get or create a reusable page for subtitle rendering
 */
async function getSubtitlePage(width, height) {
    const browser = await getBrowser();

    // Reuse page if dimensions match
    if (subtitlePage && subtitlePageWidth === width && subtitlePageHeight === height) {
        return subtitlePage;
    }

    // Close old page if exists
    if (subtitlePage) {
        try { await subtitlePage.close(); } catch (e) { }
    }

    // Create new page
    subtitlePage = await browser.newPage();
    subtitlePageWidth = width;
    subtitlePageHeight = height;

    await subtitlePage.setViewport({
        width: width,
        height: height,
        deviceScaleFactor: 1,
    });

    return subtitlePage;
}

/**
 * Render subtitle overlay to PNG using Puppeteer
 * Supports word-by-word highlighting with glow/scale effects
 * Uses page reuse for faster batch rendering
 * 
 * @param {Object} options - Subtitle options
 * @param {Array} options.words - Array of { text, isHighlighted }
 * @param {string} options.textColor - Normal text color
 * @param {string} options.highlightColor - Highlighted word color
 * @param {number} options.width - Output width
 * @param {number} options.height - Output height
 * @param {string} outputPath - Path to save PNG
 * @returns {Promise<string>} - Path to generated PNG
 */
async function renderSubtitleToPNG(options, outputPath) {
    const startTime = Date.now();

    try {
        const width = options.width || 1080;
        const height = options.height || 1920;
        const page = await getSubtitlePage(width, height);

        const html = generateSubtitleHTML(options);

        // Use faster wait strategy - domcontentloaded is sufficient for inline CSS
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });

        // Quick font wait - only if using Google Fonts or custom embedded fonts
        const fontFamily = options.fontFamily || 'Sans-Bold';
        const needsGoogleFonts = fontFamily.toLowerCase().includes('poppins') || fontFamily.toLowerCase().includes('roboto');
        const isCustomFont = fontFamily.toLowerCase().includes('komika') || fontFamily.toLowerCase().includes('bold-font');

        if (needsGoogleFonts) {
            // Brief wait for Google Fonts - don't block too long
            await page.evaluate(async (targetFont) => {
                await document.fonts.ready;
                const fontToCheck = targetFont.includes('Poppins') ? 'Poppins' : 'Roboto';
                try {
                    await document.fonts.load(`900 48px "${fontToCheck}"`);
                } catch (e) { }
                await new Promise(resolve => setTimeout(resolve, 100));
            }, fontFamily);
        } else if (isCustomFont) {
            // Wait for custom embedded fonts
            await page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise(resolve => setTimeout(resolve, 200));
            });
        } else {
            await page.evaluate(() => document.fonts.ready);
        }

        // Take screenshot
        await page.screenshot({
            path: outputPath,
            type: 'png',
            omitBackground: true,
        });

        return outputPath;
    } catch (error) {
        console.error('[SUBTITLE] Error rendering subtitle:', error.message);
        // Reset page on error
        if (subtitlePage) {
            try { await subtitlePage.close(); } catch (e) { }
            subtitlePage = null;
        }
        throw error;
    }
}

/**
 * Close subtitle page (call when done with batch)
 */
async function closeSubtitlePage() {
    if (subtitlePage) {
        try { await subtitlePage.close(); } catch (e) { }
        subtitlePage = null;
        subtitlePageWidth = 0;
        subtitlePageHeight = 0;
    }
}

// ============================================================
// ASS SUBTITLE GENERATOR (native FFmpeg subtitle burning)
// Replaces PNG-per-word overlay approach for massive performance gain.
// One ASS file → one FFmpeg filter → zero extra inputs.
// ============================================================

/**
 * Convert HTML hex color (#RRGGBB) to ASS color format (&H00BBGGRR)
 */
function htmlColorToASS(hex) {
    if (!hex || hex === 'transparent') return '&H00FFFFFF';
    const clean = hex.replace('#', '');
    const r = clean.substring(0, 2);
    const g = clean.substring(2, 4);
    const b = clean.substring(4, 6);
    return `&H00${b}${g}${r}`.toUpperCase();
}

/**
 * Format seconds to ASS timestamp: H:MM:SS.CC
 */
function formatASSTime(seconds) {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.min(99, Math.round((seconds % 1) * 100));
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Escape text for ASS dialogue lines
 */
function escapeASSText(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\n/g, '\\N');
}

/**
 * Generate ASS subtitle file content for FFmpeg subtitle burning.
 * Uses native ASS override tags for word-by-word karaoke highlighting.
 * 
 * Benefits over PNG overlay approach:
 * - ZERO extra FFmpeg inputs (was: 1 input per word = 200+ inputs)
 * - ONE filter in the graph (was: 200+ chained overlay filters)
 * - Handles unlimited words without FFmpeg crash
 * - 10-100x faster than Puppeteer PNG rendering
 * 
 * @param {Object} options
 * @param {Array} options.blocks - Timed caption blocks with words
 * @param {string} options.textColor - Normal text color (#RRGGBB)
 * @param {string} options.highlightColor - Highlighted word color (#RRGGBB)
 * @param {string} options.outlineColor - Outline color (#RRGGBB)
 * @param {number} options.outlineWidth - Outline width in pixels
 * @param {string} options.bgColor - Background color
 * @param {boolean} options.bgEnabled - Whether background box is enabled
 * @param {string} options.fontFamily - Font family name
 * @param {number} options.fontSize - Font size (at 1080p base)
 * @param {number} options.position - Vertical position (% from top)
 * @param {string} options.alignment - Text alignment (left/center/right)
 * @param {number} options.width - Video width
 * @param {number} options.height - Video height
 * @param {boolean} options.shadowEnabled - Enable drop shadow
 * @param {boolean} options.glowEffect - Enable glow on highlighted word
 * @param {boolean} options.scaleEffect - Enable scale-up on highlighted word
 * @param {boolean} options.wordByWord - Word-by-word karaoke mode
 * @param {boolean} options.uppercase - Force uppercase text
 * @param {number} options.maxWordsPerLine - Max words per display line
 * @returns {string} - Complete ASS file content
 */
function generateSubtitleASS(options) {
    const {
        blocks = [],
        textColor = '#FFFFFF',
        highlightColor = '#00FF66',
        outlineColor = '#000000',
        outlineWidth = 3,
        bgColor = 'transparent',
        bgEnabled = false,
        fontFamily = 'Sans-Bold',
        fontSize = 48,
        position = 85,
        alignment = 'center',
        width = 1080,
        height = 1920,
        shadowEnabled = true,
        glowEffect = true,
        scaleEffect = false,
        highlightScale = 115,
        wordByWord = true,
        uppercase = true,
        maxWordsPerLine = 4,
        lineSpacing = 1.2,
        minDisplaySec = 0.8,
    } = options;

    // Map font family to system font name
    const fontMap = {
        'Sans-Bold': 'Arial',
        'Poppins-Black': 'Poppins',
        'Arial-Bold': 'Arial',
        'Helvetica-Bold': 'Helvetica',
        'Impact': 'Impact',
        'Roboto-Bold': 'Roboto',
        'Komika-Axis': 'Komika Axis',
        'The-Bold-Font': 'The Bold Font',
    };
    const assFont = fontMap[fontFamily] || 'Arial';

    // Scale font size for resolution (base 1080p)
    const scaledFontSize = Math.round((fontSize / 1080) * width);

    // Position: convert % from top to MarginV pixels
    // For bottom-anchored (position > 50%): MarginV = distance from bottom
    // For top-anchored (position <= 50%): MarginV = distance from top
    const isBottom = position > 50;
    const marginV = isBottom
        ? Math.round(height * ((100 - position) / 100))
        : Math.round(height * (position / 100));

    // ASS alignment (numpad layout):
    // Bottom: 1=left, 2=center, 3=right
    // Top:    7=left, 8=center, 9=right
    const alignMap = {
        bottom: { left: 1, center: 2, right: 3 },
        top:    { left: 7, center: 8, right: 9 },
    };
    const side = isBottom ? 'bottom' : 'top';
    const align = alignment === 'left' ? 'left' : alignment === 'right' ? 'right' : 'center';
    const assAlignment = alignMap[side][align];

    // Colors in ASS format
    const textASS = htmlColorToASS(textColor);
    const hlASS = htmlColorToASS(highlightColor);
    const outlineASS = htmlColorToASS(outlineColor);
    const shadowASS = '&H80000000'; // semi-transparent black

    // Shadow and border style
    const shadowDepth = shadowEnabled ? 2 : 0;
    const borderStyle = bgEnabled ? 3 : 1; // 3 = opaque box, 1 = outline + shadow
    const bgASS = bgEnabled && bgColor !== 'transparent' ? htmlColorToASS(bgColor) : shadowASS;

    // Scale spacing and margins based on lineSpacing value
    // lineSpacing is typically 1.1-1.4, so we scale base values proportionally
    const baseSpacing = 2;
    const baseMarginV = 10;
    const scaledSpacing = Math.max(1, Math.round(baseSpacing * lineSpacing));

    // Build ASS file
    let ass = `[Script Info]
Title: Qlipper AI Subtitles
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${assFont},${scaledFontSize},${textASS},${hlASS},${outlineASS},${bgASS},1,0,0,0,100,100,${scaledSpacing},0,${borderStyle},${outlineWidth},${shadowDepth},${assAlignment},10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Generate dialogue lines
    // NOTE: Word timestamps come from either:
    //  - Whisper (hasRealTimestamp=true): precise per-word timing from audio analysis
    //  - VTT + addWordTimings(): interpolated timing (character-length weighted)
    // Both set startTime/endTime on each word — this function uses them directly.
    for (const block of blocks) {
        if (!block.words || block.words.length === 0) continue;

        // Split into line groups of maxWordsPerLine
        const allWords = block.words;
        const lines = [];
        for (let wi = 0; wi < allWords.length; wi += maxWordsPerLine) {
            lines.push(allWords.slice(wi, wi + maxWordsPerLine));
        }

        for (const lineWords of lines) {
            const lineStart = lineWords[0].startTime;
            const lineEnd = lineWords[lineWords.length - 1].endTime;

            if (wordByWord) {
                // WORD-BY-WORD: One dialogue line per word-highlight-state.
                // Each line shows all words in the group, with the current word
                // highlighted (different color, optional glow/scale).
                // Lines have non-overlapping time ranges so only one shows at a time.

                // Enforce minimum per-word display duration for readability.
                // minDisplaySec is the total chunk display time — divide by word count
                // to get per-word minimum, but floor at 0.4s absolute minimum.
                const minWordSec = Math.max(0.4, minDisplaySec / lineWords.length);

                for (let wi = 0; wi < lineWords.length; wi++) {
                    const word = lineWords[wi];

                    // Compute effective display time for this word
                    let wordStart = word.startTime;
                    let wordEnd = word.endTime;
                    const naturalDuration = wordEnd - wordStart;

                    if (naturalDuration < minWordSec) {
                        // Extend end time, but don't exceed next word's start
                        const nextStart = (wi + 1 < lineWords.length)
                            ? lineWords[wi + 1].startTime
                            : lineEnd;
                        wordEnd = Math.min(wordStart + minWordSec, nextStart);
                    }

                    let text = `{\\an${assAlignment}}`;

                    for (let j = 0; j < lineWords.length; j++) {
                        let wText = uppercase ? lineWords[j].text.toUpperCase() : lineWords[j].text;
                        wText = escapeASSText(wText);

                        if (j === wi) {
                            // Highlighted word: color + optional glow + optional scale
                            let tags = `\\c${hlASS}`;
                            if (glowEffect) tags += '\\blur3';
                            if (scaleEffect && highlightScale > 100) tags += `\\fscx${highlightScale}\\fscy${highlightScale}`;
                            text += `{${tags}}${wText}`;
                        } else {
                            // Normal word: base color, reset effects
                            text += `{\\c${textASS}\\blur0\\fscx100\\fscy100}${wText}`;
                        }

                        // Add space between words (except after last)
                        if (j < lineWords.length - 1) text += ' ';
                    }

                    ass += `Dialogue: 0,${formatASSTime(wordStart)},${formatASSTime(wordEnd)},Default,,0,0,0,,${text}\n`;
                }
            } else {
                // FULL LINE: One dialogue line per line group, no highlighting.
                let text = `{\\an${assAlignment}}`;
                const lineText = lineWords
                    .map(w => escapeASSText(uppercase ? w.text.toUpperCase() : w.text))
                    .join(' ');
                text += lineText;

                ass += `Dialogue: 0,${formatASSTime(lineStart)},${formatASSTime(lineEnd)},Default,,0,0,0,,${text}\n`;
            }
        }
    }

    return ass;
}

/**
 * Escape a file path for use inside an FFmpeg filter graph string.
 * Handles Windows drive letters, backslashes, and special characters.
 * Note: Windows drive letters like "C:" need special handling since single
 * colon is acceptable in paths but we still escape it for safety.
 */
function escapePathForFFmpegFilter(filePath) {
    // First normalize to forward slashes (works on both Windows and Unix)
    const normalized = filePath.replace(/\\/g, '/');

    // Then escape special FFmpeg filter characters
    // but be careful not to escape Windows drive letters more than necessary
    return normalized
        .replace(/'/g, "'\\''")    // escape single quotes first
        .replace(/:/g, '\\:')      // escape colons (including in Windows paths)
        .replace(/\[/g, '\\[')     // escape brackets
        .replace(/\]/g, '\\]');    // escape brackets
}

/**
 * Subtitle Smoothing Algorithm
 *
 * Transforms raw word-level timestamps into comfortable reading chunks.
 * Eliminates jittery single-word flashes by grouping words, enforcing
 * minimum display time, closing micro-gaps, and adding punctuation pauses.
 *
 * @param {Array} blocks - Caption blocks with .words[] arrays (local time)
 * @param {Object} options
 * @param {number} options.maxWordsPerChunk  - Max words per chunk (default 3)
 * @param {number} options.maxCharsPerChunk  - Max characters per chunk (default 20)
 * @param {number} options.minDisplaySec     - Min time a chunk stays on screen (default 0.4s)
 * @param {number} options.maxGapSec         - Gaps smaller than this are closed (default 0.05s)
 * @param {number} options.punctuationHoldSec - Extra hold for ,/./!/? endings (default 0.15s)
 * @returns {Array} Smoothed blocks ready for generateSubtitleASS()
 */
function smoothSubtitleBlocks(blocks, options = {}) {
    const {
        maxWordsPerChunk = 3,
        maxCharsPerChunk = 20,
        minDisplaySec = 0.8,
        maxGapSec = 0.05,
        punctuationHoldSec = 0.25,
    } = options;

    // 1. Flatten all words from all blocks into a single ordered stream
    const allWords = [];
    for (const block of blocks) {
        if (!block.words || block.words.length === 0) continue;
        for (const word of block.words) {
            if (word.text && word.startTime != null && word.endTime != null) {
                allWords.push({ ...word });
            }
        }
    }

    if (allWords.length === 0) return blocks;

    // 2. Group words into chunks (max N words OR M characters, whichever comes first)
    const chunks = [];
    let chunk = [];
    let charCount = 0;

    for (const word of allWords) {
        const wordLen = word.text.length;
        const spaceLen = chunk.length > 0 ? 1 : 0;

        // Start a new chunk if adding this word would exceed limits
        if (chunk.length > 0 && (chunk.length >= maxWordsPerChunk || charCount + spaceLen + wordLen > maxCharsPerChunk)) {
            chunks.push(chunk);
            chunk = [];
            charCount = 0;
        }

        chunk.push(word);
        charCount += wordLen + (chunk.length > 1 ? 1 : 0);
    }
    if (chunk.length > 0) chunks.push(chunk);

    // 3. Build timed chunks with minimum display + punctuation hold
    const timed = chunks.map(words => {
        let start = words[0].startTime;
        let end = words[words.length - 1].endTime;

        // Enforce minimum display time
        if (end - start < minDisplaySec) {
            end = start + minDisplaySec;
        }

        // Punctuation pause: extra hold for natural breathing
        const lastChar = words[words.length - 1].text.slice(-1);
        if (/[,.\?!]/.test(lastChar)) {
            end += punctuationHoldSec;
        }

        return { start, end, words };
    });

    // 4. Forward pass: close micro-gaps and prevent overlaps
    for (let i = 0; i < timed.length - 1; i++) {
        const nextStart = timed[i + 1].start;
        const gap = nextStart - timed[i].end;

        if (gap > 0 && gap < maxGapSec) {
            // Small gap → extend to next chunk for seamless flow
            timed[i].end = nextStart;
        } else if (gap < 0) {
            // Overlap → clip current end to next start (never eat into next chunk)
            timed[i].end = nextStart;
        }
    }

    // 5. Convert back to block format compatible with generateSubtitleASS()
    return timed.map(t => ({
        text: t.words.map(w => w.text).join(' '),
        startTime: t.start,
        endTime: t.end,
        words: t.words,
    }));
}

module.exports = {
    renderOverlayToPNG,
    renderSubtitleToPNG,
    closeSubtitlePage,
    closeBrowser,
    getDimensionsForFormat,
    generateOverlayHTML,
    generateSubtitleHTML,
    generateSubtitleASS,
    smoothSubtitleBlocks,
    escapePathForFFmpegFilter,
    toFileUri,
    CUSTOM_FONTS_DIR,
};
