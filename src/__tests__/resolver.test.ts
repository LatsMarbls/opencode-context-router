import { describe, it, expect } from 'vitest';
import { Resolver } from '../resolver.js';
import type { PreloaderConfig } from '../config.js';
import type { ScannedSkillIndex } from '../scanner.js';

const baseConfig: PreloaderConfig = {
  skills: [],
  fileTypeSkills: { '.php': ['php-conventions'], '.vue': ['vue-conventions'] },
  agentSkills: { 'coder-lite': ['coding-rules'] },
  pathPatterns: { 'src/Models/**': ['model-rules'], 'src/Controllers/**': ['controller-rules'] },
  contentTriggers: { 'migration': ['migration-rules'], 'controller': ['controller-rules'] },
  skillSettings: {},
  skillLocations: [],
  scannerEnabled: false,
  triggerIgnoreTags: ['node_modules', '.git'],
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
  priority: { 'controller-rules': 100 },
  skillTTL: 600000,
  cacheFileTTL: 60000,
  precedencePrimary: 'path',
  precedenceSubagent: 'extension',
};

describe('Resolver', () => {
  describe('resolveFileTriggers', () => {
    it('matches by extension', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveFileTriggers('src/app.php')).toContain('php-conventions');
    });

    it('path match wins — suppresses extension triggers', () => {
      const resolver = new Resolver(baseConfig);
      // src/Models/User.php matches pathPattern "src/Models/**" → only model-rules loads,
      // NOT the broad .php extension skills.
      expect(resolver.resolveFileTriggers('src/Models/User.php')).toEqual(['model-rules']);
      expect(resolver.resolveFileTriggers('src/Models/User.php')).not.toContain('php-conventions');
    });

    it('extension precedence — .ext wins over the path pattern', () => {
      const resolver = new Resolver(baseConfig);
      // Same file, but with "extension" precedence: the .php extension trigger
      // wins over the src/Models/** path — php-conventions loads, model-rules dropped.
      const r = resolver.resolveFileTriggers('src/Models/User.php', 'extension');
      expect(r).toContain('php-conventions');
      expect(r).not.toContain('model-rules');
    });

    it('ignores paths in node_modules', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveFileTriggers('node_modules/package/index.php')).toEqual([]);
    });

    it('handles Windows-style paths', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveFileTriggers('src\\Models\\User.php')).toContain('model-rules');
    });

    it('matches ignore tags on path segments, not substrings (dist vs distribution)', () => {
      const configWithDist = { ...baseConfig, triggerIgnoreTags: ['dist'] };
      const resolver = new Resolver(configWithDist);
      // "src/distribution/..." contains "dist" as substring, but "distribution" is a different segment
      // and should NOT be ignored
      expect(resolver.resolveFileTriggers('src/distribution/services/EmailService.php')).toContain('php-conventions');
      // But actual dist/ directory SHOULD be ignored
      expect(resolver.resolveFileTriggers('dist/bundle.js')).toEqual([]);
    });
  });

  describe('resolveMessageTriggers', () => {
    it('matches keywords whole-word', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveMessageTriggers('create a migration')).toContain('migration-rules');
    });

    it('does NOT match partial words', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveMessageTriggers('migration-helper')).not.toContain('migration-rules');
    });

    it('is case-insensitive', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveMessageTriggers('Create a Migration')).toContain('migration-rules');
    });

    it('matches digit suffix (vue → vue3, swift → swift5)', () => {
      const config = { ...baseConfig, contentTriggers: { vue: ['vue-rules'], swift: ['swift-rules'] } };
      const resolver = new Resolver(config);
      expect(resolver.resolveMessageTriggers('using vue3')).toContain('vue-rules');
      expect(resolver.resolveMessageTriggers('writing swift5 code')).toContain('swift-rules');
    });

    it('does NOT match if letters follow the keyword', () => {
      const config = { ...baseConfig, contentTriggers: { vue: ['vue-rules'] } };
      const resolver = new Resolver(config);
      // "vuex" has 'x' (letter) after "vue" — must NOT match
      expect(resolver.resolveMessageTriggers('using vuex')).not.toContain('vue-rules');
    });
  });

  describe('resolveAgentTriggers', () => {
    it('matches agent name', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveAgentTriggers('coder-lite')).toContain('coding-rules');
    });

    it('does not match unknown agent', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveAgentTriggers('researcher')).toEqual([]);
    });
  });

  describe('expandGroups (frontmatter-driven)', () => {
    // Frontmatter-driven: a group's membership is determined by which skills
    // have that group name in their frontmatter `groups:` field.
    const frontmatterIndex: ScannedSkillIndex = new Map([
      ['php-conventions', { name: 'php-conventions', filePath: '/fake', triggers: {}, groups: ['laravel-stack'] }],
      ['migration-rules', { name: 'migration-rules', filePath: '/fake', triggers: {}, groups: ['laravel-stack'] }],
      ['model-rules', { name: 'model-rules', filePath: '/fake', triggers: {}, groups: ['laravel-stack'] }],
    ]);

    it('expands a group name to all its frontmatter members', () => {
      const resolver = new Resolver(baseConfig, frontmatterIndex);
      const expanded = resolver.expandGroups(['laravel-stack']);
      expect(expanded).toContain('php-conventions');
      expect(expanded).toContain('migration-rules');
      expect(expanded).toContain('model-rules');
    });

    it('expands a skill to its group siblings', () => {
      const resolver = new Resolver(baseConfig, frontmatterIndex);
      const expanded = resolver.expandGroups(['migration-rules']);
      expect(expanded).toContain('php-conventions');
      expect(expanded).toContain('model-rules');
    });

    it('deduplicates when skill is in both input and group', () => {
      const resolver = new Resolver(baseConfig, frontmatterIndex);
      const expanded = resolver.expandGroups(['php-conventions', 'laravel-stack']);
      const counts = expanded.filter(n => n === 'php-conventions');
      expect(counts.length).toBe(1);
    });

    it('returns input unchanged when no group matches', () => {
      const resolver = new Resolver(baseConfig, frontmatterIndex);
      const expanded = resolver.expandGroups(['nonexistent-skill']);
      expect(expanded).toEqual(['nonexistent-skill']);
    });

    it('handles empty scannedIndex gracefully', () => {
      const resolver = new Resolver(baseConfig, new Map());
      const expanded = resolver.expandGroups(['any-skill']);
      expect(expanded).toEqual(['any-skill']);
    });
  });

  describe('sortByPriority', () => {
    it('sorts by priority descending', () => {
      const resolver = new Resolver(baseConfig);
      const sorted = resolver.sortByPriority(['php-conventions', 'controller-rules']);
      expect(sorted[0]).toBe('controller-rules'); // priority 100
    });
  });
});