const axios = require('axios');

const LICENSE_API = 'https://license.qlipper.id';

// In-memory cache: Map<string, { valid: boolean, timestamp: number }>
const verificationCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Express middleware that verifies the license key on critical endpoints.
 * Reads X-License-Key and X-Device-Id headers from the request.
 *
 * Behavior:
 *   - Valid license → next()
 *   - Invalid/missing license → 403
 *   - Network error (license server unreachable) → next() (graceful degradation for offline use)
 *   - Caches results for 1 hour to avoid hammering the license server
 */
const licenseCheck = async (req, res, next) => {
    const licenseKey = req.headers['x-license-key'];
    const deviceId = req.headers['x-device-id'];

    // Skip license check in test environment
    if (process.env.NODE_ENV === 'test') return next();

    if (!licenseKey) {
        return res.status(403).json({ error: 'Valid license required. Please activate your license in the app.' });
    }

    const cacheKey = `${licenseKey}:${deviceId || 'unknown'}`;

    // Check cache first
    const cached = verificationCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        if (cached.valid) return next();
        return res.status(403).json({ error: 'License verification failed. Please check your license key.' });
    }

    // Verify against license server
    try {
        const response = await axios.get(`${LICENSE_API}/license/verify`, {
            params: { key: licenseKey, fingerprint: deviceId || '' },
            timeout: 10000
        });

        const isValid = response.data && response.data.valid === true;

        // Cache the result
        verificationCache.set(cacheKey, { valid: isValid, timestamp: Date.now() });

        if (isValid) {
            return next();
        }

        return res.status(403).json({
            error: 'License verification failed. Please check your license key.',
            reason: response.data?.reason || 'invalid'
        });
    } catch (err) {
        // Network error → graceful degradation (allow offline use)
        console.warn(`[LICENSE] Verification failed (network): ${err.message}. Allowing request (offline mode).`);
        return next();
    }
};

module.exports = { licenseCheck };
