import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../server.js';

describe('POST /api/analyze', () => {
    it('returns 400 when no URL provided', async () => {
        const res = await request(app)
            .post('/api/analyze')
            .send({ model: 'gemini' });
        // Should reject missing URL
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('returns 400 when no API key header provided', async () => {
        const res = await request(app)
            .post('/api/analyze')
            .send({ url: 'https://example.com/video.mp4', model: 'gemini' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

describe('POST /api/system/check-model', () => {
    it('returns 400 when model is missing', async () => {
        const res = await request(app)
            .post('/api/system/check-model')
            .send({ apiKey: 'test-key' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when apiKey is missing', async () => {
        const res = await request(app)
            .post('/api/system/check-model')
            .send({ model: 'gemini' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
});

describe('POST /api/test-key', () => {
    it('returns 400 when no apiKey provided', async () => {
        const res = await request(app)
            .post('/api/test-key')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });
});
