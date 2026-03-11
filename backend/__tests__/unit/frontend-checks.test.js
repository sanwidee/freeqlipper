import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'check-component-props.js');

describe('Frontend static analysis', () => {
    it('check-component-props.js script exists', () => {
        expect(existsSync(SCRIPT)).toBe(true);
    });

    it('all child components receive parent state they reference as props', () => {
        // Runs scripts/check-component-props.js --json
        // This catches bugs like ClipEditModal using styleSettings without it being in props
        const result = execSync(`node "${SCRIPT}" --json`, {
            cwd: PROJECT_ROOT,
            encoding: 'utf-8',
            timeout: 10000,
        });

        const data = JSON.parse(result);
        
        if (data.issues.length > 0) {
            const details = data.issues
                .map(i => `  ${i.component}: "${i.variable}" (line ${i.line})`)
                .join('\n');
            throw new Error(
                `Found ${data.issues.length} component prop scope issue(s):\n${details}\n` +
                `Fix: pass the missing variable(s) as props to the child component.`
            );
        }

        expect(data.issues).toHaveLength(0);
        expect(['QlipperApp', 'QlipperAppInner']).toContain(data.mainComponent);
        expect(data.mainStateCount).toBeGreaterThan(0);
    });
});
