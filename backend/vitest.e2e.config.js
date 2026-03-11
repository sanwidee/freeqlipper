import { defineConfig } from 'vitest/config';

// Separate config for E2E tests — runs against real server + real FFmpeg.
// Usage: npm run test:e2e
// Do NOT run with npm test (that runs unit/integration tests only).
export default defineConfig({
    test: {
        include: ['__tests__/e2e/**/*.test.js'],
        exclude: ['node_modules', '**/._{*,**}', '**/._*'],
        testTimeout: 60000,  // 60s — real FFmpeg rendering can take time
        hookTimeout: 30000,
        pool: 'forks',       // Separate process to avoid port conflicts
    },
});
