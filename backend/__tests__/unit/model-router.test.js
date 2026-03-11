import { describe, it, expect } from 'vitest';
import { analyze, verifyKey, getAvailableModels, models } from '../../models/index.js';

describe('Model Registry', () => {
    it('has all 6 expected model adapters', () => {
        const expectedModels = ['gemini', 'gpt-4o', 'claude', 'groq', 'mistral', 'deepseek'];
        expect(Object.keys(models)).toEqual(expect.arrayContaining(expectedModels));
        expect(Object.keys(models)).toHaveLength(6);
    });

    it('each model has adapter, displayName, and icon', () => {
        for (const [id, model] of Object.entries(models)) {
            expect(model).toHaveProperty('adapter');
            expect(model).toHaveProperty('displayName');
            expect(model).toHaveProperty('icon');
            expect(typeof model.displayName).toBe('string');
            expect(model.displayName.length).toBeGreaterThan(0);
        }
    });

    it('each adapter has analyze and verifyKey functions', () => {
        for (const [id, model] of Object.entries(models)) {
            expect(typeof model.adapter.analyze).toBe('function');
            expect(typeof model.adapter.verifyKey).toBe('function');
        }
    });
});

describe('getAvailableModels', () => {
    it('returns array of model objects for frontend', () => {
        const available = getAvailableModels();
        expect(Array.isArray(available)).toBe(true);
        expect(available).toHaveLength(6);
    });

    it('each model has id, displayName, icon', () => {
        const available = getAvailableModels();
        for (const model of available) {
            expect(model).toHaveProperty('id');
            expect(model).toHaveProperty('displayName');
            expect(model).toHaveProperty('icon');
        }
    });

    it('does not expose adapter internals to frontend', () => {
        const available = getAvailableModels();
        for (const model of available) {
            expect(model).not.toHaveProperty('adapter');
        }
    });
});

describe('analyze', () => {
    it('throws for unknown model ID', async () => {
        await expect(analyze('nonexistent', 'key', 'prompt'))
            .rejects.toThrow('Unknown model: nonexistent');
    });

    it('error message lists available models', async () => {
        try {
            await analyze('nonexistent', 'key', 'prompt');
        } catch (e) {
            expect(e.message).toContain('gemini');
            expect(e.message).toContain('gpt-4o');
            expect(e.message).toContain('claude');
        }
    });
});

describe('verifyKey', () => {
    it('throws for unknown model ID', async () => {
        await expect(verifyKey('nonexistent', 'key'))
            .rejects.toThrow('Unknown model: nonexistent');
    });
});
