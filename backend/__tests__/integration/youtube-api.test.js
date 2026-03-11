import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../server.js';

describe('GET /api/youtube/metadata', () => {
    it('returns 400 when no URL provided', async () => {
        const res = await request(app).get('/api/youtube/metadata');
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 with empty URL', async () => {
        const res = await request(app).get('/api/youtube/metadata?url=');
        expect(res.status).toBe(400);
    });
});

describe('GET /api/system/ytdlp-status', () => {
    it('returns status object with available field', async () => {
        const res = await request(app).get('/api/system/ytdlp-status');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('available');
        expect(typeof res.body.available).toBe('boolean');
    });

    it('includes version when available', async () => {
        const res = await request(app).get('/api/system/ytdlp-status');
        if (res.body.available) {
            expect(res.body).toHaveProperty('version');
        }
    });
});

describe('GET /api/youtube/download/:id', () => {
    it('returns 404 for non-existent download', async () => {
        const res = await request(app).get('/api/youtube/download/nonexistent-id');
        expect(res.status).toBe(404);
    });
});

describe('POST /api/youtube/download', () => {
    it('returns 400 when no URL provided', async () => {
        const res = await request(app)
            .post('/api/youtube/download')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });
});
