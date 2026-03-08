/**
 * Model Router - Central entry point for all AI model adapters
 */

const gemini = require('./gemini');
const openai = require('./openai');
const anthropic = require('./anthropic');
const groq = require('./groq');
const mistral = require('./mistral');
const deepseek = require('./deepseek');

// Model registry
const models = {
    'gemini': { adapter: gemini, displayName: 'Gemini 2.0 Flash', icon: '✨' },
    'gpt-4o': { adapter: openai, displayName: 'GPT-4o', icon: '🧠' },
    'claude': { adapter: anthropic, displayName: 'Claude 3.5 Sonnet', icon: '🎭' },
    'groq': { adapter: groq, displayName: 'Llama 3.1 70B (Groq)', icon: '⚡' },
    'mistral': { adapter: mistral, displayName: 'Mistral Large', icon: '🌊' },
    'deepseek': { adapter: deepseek, displayName: 'Deepseek', icon: '🔮' }
};

/**
 * Get list of available models for frontend
 */
function getAvailableModels() {
    return Object.entries(models).map(([id, { displayName, icon }]) => ({
        id,
        displayName,
        icon
    }));
}

/**
 * Analyze using specified model
 * @param {string} modelId - Model identifier (gemini, gpt-4o, claude, groq, mistral)
 * @param {string} apiKey - API key for the provider
 * @param {string} prompt - Analysis prompt
 * @param {string} modelVariant - Optional model variant (for Gemini)
 * @param {string} [youtubeUrl] - Optional YouTube URL for video frame analysis (Gemini only)
 * @returns {Promise<object>} - Parsed JSON result
 */
async function analyze(modelId, apiKey, prompt, modelVariant = null, youtubeUrl = null) {
    const model = models[modelId];
    if (!model) {
        throw new Error(`Unknown model: ${modelId}. Available: ${Object.keys(models).join(', ')}`);
    }
    
    // Sanitize variant - treat empty string as null
    const effectiveVariant = modelVariant && modelVariant.trim() ? modelVariant.trim() : null;
    
    // Pass to adapter (each adapter handles its own defaults)
    // Only Gemini supports youtubeUrl for video frame analysis; other adapters ignore extra params
    return model.adapter.analyze(apiKey, prompt, effectiveVariant, youtubeUrl);
}

/**
 * Verify API key for specified model
 * @param {string} modelId 
 * @param {string} apiKey 
 * @returns {Promise<boolean>}
 */
async function verifyKey(modelId, apiKey) {
    const model = models[modelId];
    if (!model) {
        throw new Error(`Unknown model: ${modelId}`);
    }
    return model.adapter.verifyKey(apiKey);
}

module.exports = { analyze, verifyKey, getAvailableModels, models };
