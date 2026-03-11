/**
 * OpenAI Model Adapter (GPT-4o)
 * Uses OpenAI SDK with JSON mode
 */

const MODEL_NAME = 'gpt-4o';

/**
 * Analyze transcript using OpenAI GPT-4o
 * @param {string} apiKey - OpenAI API Key  
 * @param {string} prompt - The full analysis prompt
 * @returns {Promise<object>} - Parsed JSON response
 */
async function analyze(apiKey, prompt, modelVariant) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: modelVariant || MODEL_NAME,
            messages: [
                { role: 'system', content: 'You are a professional video editor. Always respond with valid JSON only.' },
                { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.7,
            max_tokens: 8192
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'OpenAI API Error');
    }

    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
}

/**
 * Verify API key is valid
 * @param {string} apiKey 
 * @returns {Promise<boolean>}
 */
async function verifyKey(apiKey) {
    try {
        const response = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || `OpenAI Error: ${response.statusText}`);
        }

        const data = await response.json();
        return {
            valid: true,
            models: data.data.map(m => m.id)
        };
    } catch (error) {
        throw new Error(error.message);
    }
}

module.exports = { analyze, verifyKey, MODEL_NAME };
