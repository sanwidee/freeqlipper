import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../server.js';

describe('GET /api/models', () => {
    it('returns array of available models', async () => {
        const res = await request(app).get('/api/models');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(6);
    });

    it('each model has id, displayName, icon', async () => {
        const res = await request(app).get('/api/models');
        for (const model of res.body) {
            expect(model).toHaveProperty('id');
            expect(model).toHaveProperty('displayName');
            expect(model).toHaveProperty('icon');
            expect(typeof model.id).toBe('string');
            expect(typeof model.displayName).toBe('string');
        }
    });

    it('includes all expected model IDs', async () => {
        const res = await request(app).get('/api/models');
        const ids = res.body.map(m => m.id);
        expect(ids).toEqual(expect.arrayContaining(['gemini', 'gpt-4o', 'claude', 'groq', 'mistral', 'deepseek']));
    });
});

describe('GET /api/gemini/variants', () => {
    it('returns variants array and default model', async () => {
        const res = await request(app).get('/api/gemini/variants');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('variants');
        expect(res.body).toHaveProperty('default');
        expect(Array.isArray(res.body.variants)).toBe(true);
    });
});
