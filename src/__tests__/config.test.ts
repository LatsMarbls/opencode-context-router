import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, resolveSkillPath } from '../config.js';

describe('config', () => {
  it('has all expected defaults', () => {
    expect(DEFAULT_CONFIG.maxTokens).toBe(8000);
    expect(DEFAULT_CONFIG.scannerEnabled).toBe(true);
    expect(DEFAULT_CONFIG.accumulateSkills).toBe(true);
    expect(DEFAULT_CONFIG.persistAfterCompaction).toBe(true);
    expect(DEFAULT_CONFIG.skillTTL).toBe(600000);
    expect(DEFAULT_CONFIG.cacheFileTTL).toBe(60000);
  });

  it('resolves skill path templates', () => {
    const result = resolveSkillPath(
      '{project}/.opencode/skills/{name}/SKILL.md',
      '/my/project',
      'php-conventions',
    );
    expect(result).toBe('/my/project/.opencode/skills/php-conventions/SKILL.md');
  });

  it('resolves {user} placeholder', () => {
    const result = resolveSkillPath(
      '{user}/skills/{name}/SKILL.md',
      '/project',
      'test',
    );
    expect(result).toContain('.config/opencode/skills/test/SKILL.md');
  });
});