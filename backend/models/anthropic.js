/**
 * Anthropic Claude Model Adapter
 * Uses Claude 3.5 Sonnet via REST API
 */

const MODEL_NAME = 'claude-3-5-sonnet-20241022';

/**
 * Analyze transcript using Claude
 * @param {string} apiKey - Anthropic API Key
 * @param {string} prompt - The full analysis prompt
 * @returns {Promise<object>} - Parsed JSON response
 */
async function analyze(apiKey, prompt, modelVariant) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: modelVariant || MODEL_NAME,
            max_tokens: 8192,
            messages: [
                { role: 'user', content: prompt + '\n\nIMPORTANT: Respond with ONLY valid JSON, no markdown or explanations.' }
            ]
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'Anthropic API Error');
    }

    const data = await response.json();
    let text = data.content[0].text;

    // Clean up markdown if present
    if (text.startsWith('```json')) text = text.slice(7);
    if (text.startsWith('```')) text = text.slice(3);
    if (text.endsWith('```')) text = text.slice(0, -3);

    return JSON.parse(text.trim());
}

/**
 * Verify API key is valid
 * @param {string} apiKey 
 * @returns {Promise<boolean>}
 */
async function verifyKey(apiKey) {
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: MODEL_NAME,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'Hi' }]
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || `Anthropic Error: ${response.statusText}`);
        }

        return {
            valid: true,
            models: [MODEL_NAME] // Anthropic doesn't list models via API easily
        };
    } catch (error) {
        throw new Error(error.message);
    }
}

module.exports = { analyze, verifyKey, MODEL_NAME };
