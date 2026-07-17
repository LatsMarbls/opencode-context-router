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
  groups: { 'laravel-stack': ['php-conventions', 'migration-rules', 'model-rules'] },
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
};

/** Minimal scanned index for group resolution tests */
const scannedIndex: ScannedSkillIndex = new Map([
  ['migration-rules', { name: 'migration-rules', filePath: '/fake', triggers: {}, groups: ['laravel-stack'] }],
  ['php-conventions', { name: 'php-conventions', filePath: '/fake', triggers: {}, groups: ['laravel-stack'] }],
  ['model-rules', { name: 'model-rules', filePath: '/fake', triggers: {}, groups: ['laravel-stack'] }],
]);

describe('Resolver', () => {
  describe('resolveFileTriggers', () => {
    it('matches by extension', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveFileTriggers('src/app.php')).toContain('php-conventions');
    });

    it('matches by path pattern', () => {
      const resolver = new Resolver(baseConfig);
      expect(resolver.resolveFileTriggers('src/Models/User.php')).toContain('model-rules');
      expect(resolver.resolveFileTriggers('src/Models/User.php')).toContain('php-conventions');
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

  describe('expandGroups', () => {
    it('expands group key to members', () => {
      const resolver = new Resolver(baseConfig);
      const expanded = resolver.expandGroups(['laravel-stack']);
      expect(expanded).toContain('php-conventions');
      expect(expanded).toContain('migration-rules');
      expect(expanded).toContain('model-rules');
    });

    it('expands group member to siblings', () => {
      const resolver = new Resolver(baseConfig, scannedIndex);
      const expanded = resolver.expandGroups(['migration-rules']);
      expect(expanded).toContain('php-conventions');
      expect(expanded).toContain('model-rules');
    });

    it('deduplicates', () => {
      const resolver = new Resolver(baseConfig);
      const expanded = resolver.expandGroups(['php-conventions', 'laravel-stack']);
      const counts = expanded.filter(n => n === 'php-conventions');
      expect(counts.length).toBe(1);
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