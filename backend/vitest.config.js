import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['__tests__/**/*.test.js'],
        exclude: ['node_modules', '**/._{*,**}', '**/._*', '__tests__/e2e/**'],
        testTimeout: 10000,
    },
});
