import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../server.js';

describe('POST /api/video/process', () => {
    it('returns 400 when videoPath is missing', async () => {
        const res = await request(app)
            .post('/api/video/process')
            .send({ config: { clips: [] }, outputFormat: 'stacked-blur' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when config is missing', async () => {
        const res = await request(app)
            .post('/api/video/process')
            .send({ videoPath: '/tmp/test.mp4' });
        expect(res.status).toBe(400);
    });
});

describe('GET /api/job/:id', () => {
    it('returns 404 for non-existent job', async () => {
        const res = await request(app).get('/api/job/nonexistent-job-id-12345');
        expect(res.status).toBe(404);
    });
});

describe('POST /api/upload', () => {
    it('returns 400 when no file attached', async () => {
        const res = await request(app)
            .post('/api/upload');
        expect(res.status).toBe(400);
    });
});
