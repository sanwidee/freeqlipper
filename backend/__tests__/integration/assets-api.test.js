import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../server.js';

describe('GET /api/assets', () => {
    it('returns 200 with array', async () => {
        const res = await request(app).get('/api/assets');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('GET /api/history', () => {
    it('returns 200 with array', async () => {
        const res = await request(app).get('/api/history');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('DELETE /api/history/:id', () => {
    it('returns 404 for non-existent project', async () => {
        const res = await request(app).delete('/api/history/nonexistent-project-id');
        expect(res.status).toBe(404);
    });
});

describe('PATCH /api/history/:projectId/clips/:clipIdx', () => {
    it('returns 404 for non-existent project', async () => {
        const res = await request(app)
            .patch('/api/history/nonexistent-project/clips/0')
            .send({ customTitle: 'Test' });
        expect(res.status).toBe(404);
    });
});

describe('GET /api/logos', () => {
    it('returns 200 with array', async () => {
        const res = await request(app).get('/api/logos');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('POST /api/assets/upload', () => {
    it('returns 400 when no file attached', async () => {
        const res = await request(app).post('/api/assets/upload');
        expect(res.status).toBe(400);
    });
});

describe('GET /api/system/download-file', () => {
    it('returns 400 when no path provided', async () => {
        const res = await request(app).get('/api/system/download-file');
        expect(res.status).toBe(400);
    });
});

describe('POST /api/system/open-file', () => {
    it('returns 400 when no path provided', async () => {
        const res = await request(app)
            .post('/api/system/open-file')
            .send({});
        expect(res.status).toBe(400);
    });
});

describe('GET /api/proxy-image', () => {
    it('returns 400 when no URL provided', async () => {
        const res = await request(app).get('/api/proxy-image');
        expect(res.status).toBe(400);
    });
});
