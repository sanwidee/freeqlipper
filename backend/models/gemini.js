/**
 * Gemini Model Adapter
 * Uses Google's Generative AI SDK
 * Supports dynamic model variant selection
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Supported Gemini model variants (2.0+ only, text/multimodal models)
// Excluded: nano, embedding, imagen, AQA, and pre-2.0 models
const GEMINI_VARIANTS = {
    // Gemini 3.0 Series
    'gemini-3.0-flash': { displayName: 'Gemini 3.0 Flash', tier: 'free', description: 'Latest Flash model' },
    'gemini-3.0-pro': { displayName: 'Gemini 3.0 Pro', tier: 'paid', description: 'Advanced capabilities' },
    // Gemini 2.5 Series (Preview)
    'gemini-2.5-pro-preview-05-06': { displayName: 'Gemini 2.5 Pro Preview', tier: 'paid', description: 'Preview model' },
    'gemini-2.5-flash-preview-04-17': { displayName: 'Gemini 2.5 Flash Preview', tier: 'free', description: 'Preview Flash model' },
    // Gemini 2.0 Series
    'gemini-2.0-flash': { displayName: 'Gemini 2.0 Flash', tier: 'free', recommended: true, description: 'Fast, versatile (recommended)' },
    'gemini-2.0-flash-lite': { displayName: 'Gemini 2.0 Flash Lite', tier: 'free', description: 'Lightweight, cost-effective' },
    'gemini-2.0-pro-exp': { displayName: 'Gemini 2.0 Pro (Experimental)', tier: 'paid', description: 'Advanced reasoning' },
    // Aliases / Latest
    'gemini-flash-latest': { displayName: 'Gemini Flash (Latest)', tier: 'free', description: 'Auto-updated to latest Flash' },
    'gemini-pro-latest': { displayName: 'Gemini Pro (Latest)', tier: 'paid', description: 'Auto-updated to latest Pro' },
};

const DEFAULT_MODEL = 'gemini-flash-latest';

/**
 * Get list of supported Gemini variants
 */
function getVariants() {
    return Object.entries(GEMINI_VARIANTS).map(([id, info]) => ({
        id,
        ...info
    }));
}

/**
 * Analyze transcript using Gemini (with automatic retry)
 * @param {string} apiKey - Gemini API Key
 * @param {string} prompt - The full analysis prompt
 * @param {string} modelVariant - Model variant to use (defaults to gemini-flash-latest)
 * @param {string} [youtubeUrl] - Optional YouTube URL for video frame analysis via fileData
 * @returns {Promise<object>} - Parsed JSON response
 */
async function analyze(apiKey, prompt, modelVariant, youtubeUrl) {
    // Ensure we always have a valid model name (handle empty string, null, undefined)
    const effectiveModel = modelVariant && modelVariant.trim() ? modelVariant.trim() : DEFAULT_MODEL;
    
    console.log(`[GEMINI] Using model: ${effectiveModel}`);
    if (youtubeUrl) {
        console.log(`[GEMINI] Video analysis enabled: ${youtubeUrl}`);
    }
    
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: effectiveModel });

    const generationConfig = {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 16384,
        responseMimeType: "text/plain",
    };

    // Build content parts (text-only for now)
    // NOTE: fileData.fileUri requires a Google Cloud Storage URI (gs://...) or
    // Gemini Files API URI — raw YouTube URLs are NOT valid and cause API errors
    // that trigger retries with higher temperature, degrading output quality.
    // Face positions are estimated from transcript context instead.
    const parts = [{ text: prompt }];

    const MAX_RETRIES = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // ---- Step 1: Call Gemini API ----
            let result;
            try {
                result = await model.generateContent({
                    contents: [{ role: "user", parts }],
                    generationConfig
                });
            } catch (apiErr) {
                // API-level errors: auth, rate limit, network, model not found, safety
                // These are NOT JSON parsing issues — propagate with original error info
                const msg = apiErr.message || String(apiErr);
                console.error(`[GEMINI] API Error (attempt ${attempt}/${MAX_RETRIES}):`, msg);

                // Retryable: rate limit (429), server errors (500/502/503), network/timeout
                const isRetryable = /429|500|502|503|rate.?limit|quota|timeout|network|econnr|socket hang up/i.test(msg);

                if (isRetryable && attempt < MAX_RETRIES) {
                    const delay = attempt * 3000; // 3s, 6s
                    console.log(`[GEMINI] Retrying in ${delay / 1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                // Non-retryable or final attempt — throw original error so parseAIError can classify it
                throw apiErr;
            }

            // ---- Step 2: Extract & parse JSON from response ----
            const response = await result.response;
            let text = response.text();

            // Robust cleanup: finding the FIRST '{' and LAST '}' to extract valid JSON
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');

            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                text = text.substring(firstBrace, lastBrace + 1);
            }

            try {
                return JSON.parse(text);
            } catch (parseErr) {
                // JSON parsing failed — Gemini returned malformed output
                console.error(`[GEMINI] JSON Parse Error (attempt ${attempt}/${MAX_RETRIES}):`, parseErr.message);
                console.error(`[GEMINI] Raw response (first 500 chars):`, text.substring(0, 500));
                lastError = new Error(`Gemini returned invalid JSON: ${parseErr.message}`);

                if (attempt < MAX_RETRIES) {
                    console.log(`[GEMINI] Retrying analysis (attempt ${attempt + 1})...`);
                    // Slightly increase temperature on retry to get different output
                    generationConfig.temperature = Math.min(0.9, generationConfig.temperature + 0.1);
                    continue;
                }
                throw lastError;
            }

        } catch (err) {
            lastError = err;
            if (attempt >= MAX_RETRIES) {
                console.error(`[GEMINI] All ${MAX_RETRIES} attempts failed:`, err.message);
                throw err;
            }
        }
    }

    // Should not reach here, but safety net
    throw lastError || new Error('Gemini analysis failed after all retries');
}

/**
 * Verify API key is valid
 * @param {string} apiKey 
 * @param {string} modelVariant
 * @returns {Promise<boolean>}
 */
async function verifyKey(apiKey) {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || `Gemini Error: ${response.statusText}`);
        }
        const data = await response.json();
        return {
            valid: true,
            models: data.models ? data.models.map(m => m.name.replace('models/', '')) : []
        };
    } catch (err) {
        throw new Error(err.message);
    }
}

module.exports = { analyze, verifyKey, getVariants, GEMINI_VARIANTS, DEFAULT_MODEL };

