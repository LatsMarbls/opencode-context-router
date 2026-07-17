import { describe, it, expect } from 'vitest';
import { SkillLoader } from '../loader.js';
import type { PreloaderConfig } from '../config.js';

const testConfig: PreloaderConfig = {
  skills: [],
  fileTypeSkills: {},
  agentSkills: {},
  pathPatterns: {},
  contentTriggers: {},
  skillSettings: {},
  skillLocations: [
    '{project}/.opencode/skills/{name}/SKILL.md',
    '{project}/.opencode/agent/{name}.md',
  ],
  scannerEnabled: false,
  triggerIgnoreTags: [],
  injectionMethod: 'systemPrompt',
  maxTokens: 8000,
  useSummaries: false,
  useMinification: false,
  showToasts: false,
  enableTools: false,
  analytics: false,
  persistAfterCompaction: true,
  accumulateSkills: true,
  debug: false,
  priority: {},
  skillTTL: 600000,
  cacheFileTTL: 60000,
};

describe('SkillLoader', () => {
  it('returns null for nonexistent skill', () => {
    const loader = new SkillLoader(testConfig, '/nonexistent');
    expect(loader.loadStaticSkill('no-such-skill')).toBeNull();
  });

  it('tracks cache stats', () => {
    const loader = new SkillLoader(testConfig, '/nonexistent');
    loader.loadStaticSkill('no-such-skill');
    const stats = loader.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(Array.isArray(stats.entries)).toBe(true);
  });
});