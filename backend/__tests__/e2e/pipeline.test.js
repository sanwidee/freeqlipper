/**
 * E2E: Full Qlipper render pipeline
 *
 * Tests the real server + real FFmpeg — no mocks, no YouTube, no Gemini API.
 * Uses a bundled 5-second fixture video (__tests__/fixtures/short.mp4).
 *
 * Run separately from unit/integration tests:
 *   cd app/backend && npm run test:e2e
 *
 * Requirements:
 *   - FFmpeg available (either ffmpeg-static npm package or system PATH)
 *   - NODE_ENV=test (set automatically by Vitest — bypasses license check)
 */

import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App root = app/ (server.js lives in app/backend, so app root is one level up)
const APP_ROOT = path.resolve(__dirname, '../../..');

// Track created files for cleanup
const createdFiles = [];

afterAll(() => {
    for (const f of createdFiles) {
        try {
            if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
                fs.rmSync(f, { recursive: true, force: true });
            } else if (fs.existsSync(f)) {
                fs.unlinkSync(f);
            }
        } catch { /* ignore cleanup errors */ }
    }
});

describe('E2E: Full render pipeline (raw-cuts format)', () => {
    let uploadedRelativePath;
    let jobId;
    let completedJob;

    it('server health check — /version responds', async () => {
        const res = await request(app).get('/version');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('version');
    });

    it('uploads fixture video to /api/upload', async () => {
        const fixturePath = path.join(__dirname, '../fixtures/short.mp4');
        expect(fs.existsSync(fixturePath)).toBe(true);

        const res = await request(app)
            .post('/api/upload')
            .attach('video', fixturePath);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('path');

        uploadedRelativePath = res.body.path; // e.g. "downloads/upload_123_short.mp4"
        const absPath = path.join(APP_ROOT, uploadedRelativePath);
        createdFiles.push(absPath);

        expect(fs.existsSync(absPath)).toBe(true);
    });

    it('starts a raw-cuts render job via /api/video/process', async () => {
        expect(uploadedRelativePath).toBeTruthy();

        const config = {
            video_clips: [
                {
                    clip_id: 1,
                    topic: 'e2e_test_clip',
                    highlight: 'E2E test highlight',
                    description: 'E2E test description',
                    language: 'en',
                    total_duration_seconds: 4,
                    timelines: [
                        { start: '00:00:00', end: '00:00:04', duration: 4 }
                    ]
                }
            ]
        };

        const res = await request(app)
            .post('/api/video/process')
            .send({
                videoPath: uploadedRelativePath,
                config,
                outputFormat: 'raw-cuts',
                outputResolution: '720p',
                turboMode: true
            });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('jobId');
        jobId = res.body.jobId;
    });

    it('job completes within 30s and output file exists', async () => {
        expect(jobId).toBeTruthy();

        // Poll until completed or timeout (30 seconds)
        let status = 'processing';
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const res = await request(app).get(`/api/job/${jobId}`);
            expect(res.status).toBe(200);
            status = res.body.status;

            if (status === 'completed' || status === 'failed') {
                completedJob = res.body;
                break;
            }
        }

        expect(status).toBe('completed');
    });

    it('output clip file exists on disk with non-zero size', () => {
        expect(completedJob).toBeTruthy();
        expect(completedJob.completedClips).toBeInstanceOf(Array);
        expect(completedJob.completedClips.length).toBeGreaterThan(0);

        const clip = completedJob.completedClips[0];
        expect(clip).toHaveProperty('url');

        const absOutputPath = path.join(APP_ROOT, clip.url);
        const jobClipsDir = path.dirname(absOutputPath);
        createdFiles.push(jobClipsDir); // schedule whole job dir for cleanup

        expect(fs.existsSync(absOutputPath)).toBe(true);
        const stat = fs.statSync(absOutputPath);
        expect(stat.size).toBeGreaterThan(10000); // at least 10KB
    });
});
