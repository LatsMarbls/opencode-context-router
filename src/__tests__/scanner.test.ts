import { describe, it, expect } from 'vitest';
// Note: parseFrontmatter is not exported. We test the public API.
import { loadConfig } from '../config.js';

describe('scanner integration', () => {
  it('loadConfig returns valid config', () => {
    const config = loadConfig(process.cwd());
    expect(config).toBeDefined();
    expect(config.skillLocations.length).toBeGreaterThan(0);
    expect(typeof config.maxTokens).toBe('number');
  });
});