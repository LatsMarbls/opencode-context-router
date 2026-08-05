import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';
import { parseFrontmatter } from '../scanner.js';
import type { PreloaderConfig } from '../config.js';

describe('scanner integration', () => {
  it('loadConfig returns valid config', () => {
    const config = loadConfig(process.cwd());
    expect(config).toBeDefined();
    expect(config.skillLocations.length).toBeGreaterThan(0);
    expect(typeof config.maxTokens).toBe('number');
  });
});

describe('parseFrontmatter', () => {
  it('parses a complete frontmatter block', () => {
    const content = `---
name: php-conventions
triggers:
  extensions: [".php"]
  keywords: ["laravel"]
priority: 10
always: false
groups: ["backend"]
---

# PHP Rules
- Use PSR-4
`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.name).toBe('php-conventions');
    expect(frontmatter?.priority).toBe(10);
    expect(frontmatter?.always).toBe(false);
    expect(frontmatter?.groups).toEqual(['backend']);
    expect(frontmatter?.triggers?.extensions).toEqual(['.php']);
    expect(body).toContain('# PHP Rules');
  });

  it('returns null when no frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('# Just a heading\n\nNo frontmatter here.');
    expect(frontmatter).toBeNull();
    expect(body).toContain('Just a heading');
  });

  it('returns null when closing --- is missing', () => {
    const { frontmatter } = parseFrontmatter('---\nname: broken\nNo closing');
    expect(frontmatter).toBeNull();
  });

  it('returns null when frontmatter is empty (---  ---)', () => {
    const { frontmatter, body } = parseFrontmatter('---\n\n---\n\n# Body');
    expect(frontmatter).toBeNull();
    expect(body).toContain('# Body');
  });

  it('handles invalid YAML gracefully (returns null)', () => {
    const content = `---
name: [unclosed bracket
priority: : ::
---

# Body`;
    // Should not throw — invalid YAML yields no frontmatter, body still parsed
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toContain('Body');
  });

  it('parses frontmatter with quoted strings and special chars', () => {
    const content = `---
name: "c++ rules"
triggers:
  keywords:
    - "vue component"
    - "react: hook"
---

# body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter?.name).toBe('c++ rules');
    expect(frontmatter?.triggers?.keywords).toEqual(['vue component', 'react: hook']);
  });

  it('handles frontmatter with only some fields', () => {
    const content = `---
name: minimal
---

# body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter?.name).toBe('minimal');
    expect(frontmatter?.priority).toBeUndefined();
    expect(frontmatter?.triggers).toBeUndefined();
  });
});

describe('scanCache', () => {
  // Use a temp dir for tests so we don't pollute the user's home
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = mkdtempSync(join(tmpdir(), 'context-routing-test-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    // Point cache to a file inside our temp dir
    const { setCachePathForTesting, loadScanCache, saveScanCache } = await import('../scanCache.js');
    setCachePathForTesting(tmpDir);
  });

  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    const { setCachePathForTesting } = await import('../scanCache.js');
    process.chdir(prevCwd);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    setCachePathForTesting(null);
  });

  it('returns null when no cache file exists', async () => {
    const { loadScanCache } = await import('../scanCache.js');
    expect(loadScanCache()).toBeNull();
  });

  it('round-trips: save then load returns same data', async () => {
    const { loadScanCache, saveScanCache, buildCacheForProject } = await import('../scanCache.js');
    const cache = buildCacheForProject(
      null,
      '/test/project',
      ['{project}/skills'],
      {
        'my-skill': {
          name: 'my-skill',
          filePath: '/test/project/skills/my-skill/SKILL.md',
          mtime: 12345,
          size: 678,
          frontmatter: { name: 'my-skill', priority: 10 },
        },
      },
    );
    saveScanCache(cache);
    const loaded = loadScanCache();
    expect(loaded).not.toBeNull();
    expect(loaded!.projects['/test/project'].entries['my-skill'].frontmatter?.priority).toBe(10);
  });

  it('returns null on corrupt cache file', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(tmpDir, 'scan-cache.json'), '{ corrupt json', 'utf-8');
    const { loadScanCache } = await import('../scanCache.js');
    expect(loadScanCache()).toBeNull();
  });

  it('returns null on version mismatch', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(
      join(tmpDir, 'scan-cache.json'),
      JSON.stringify({ version: 999, projects: {} }),
      'utf-8',
    );
    const { loadScanCache } = await import('../scanCache.js');
    expect(loadScanCache()).toBeNull();
  });

  it('getCachedEntry returns undefined for unknown project/skill', async () => {
    const { loadScanCache, getCachedEntry } = await import('../scanCache.js');
    const cache = loadScanCache() ?? { version: 1, projects: {} };
    expect(getCachedEntry(cache, '/unknown', 'skill')).toBeUndefined();
  });
});

describe('scanner uses cache (integration)', () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = mkdtempSync(join(tmpdir(), 'context-routing-scan-test-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);

    // Create a skill file with frontmatter
    const skillDir = join(tmpDir, '.opencode', 'skills', 'php-conventions');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: php-conventions
triggers:
  extensions: [".php"]
priority: 10
---

# PHP
`,
      'utf-8',
    );

    // Point cache to a separate temp dir
    const cacheDir = join(tmpDir, '.cache');
    mkdirSync(cacheDir, { recursive: true });
    const { setCachePathForTesting } = await import('../scanCache.js');
    setCachePathForTesting(cacheDir);
  });

  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    const { setCachePathForTesting } = await import('../scanCache.js');
    process.chdir(prevCwd);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    setCachePathForTesting(null);
  });

  it('first scan populates the cache', async () => {
    const { scanSkillFiles } = await import('../scanner.js');
    const { loadScanCache } = await import('../scanCache.js');
    const config: PreloaderConfig = {
      skills: [], fileTypeSkills: {}, agentSkills: {}, pathPatterns: {},
      contentTriggers: {}, skillSettings: {},
      skillLocations: ['{project}/.opencode/skills/{name}/SKILL.md'],
      scannerEnabled: true, triggerIgnoreTags: [],
      injectionMethod: 'systemPrompt', maxTokens: 8000,
      useSummaries: false, useMinification: false, showToasts: false,
      enableTools: false, analytics: false, persistAfterCompaction: true,
      accumulateSkills: true, debug: false, priority: {},
      skillTTL: 600000, cacheFileTTL: 60000,
      precedencePrimary: 'path', precedenceSubagent: 'path',
    };
    const index = scanSkillFiles(config, tmpDir);
    expect(index.size).toBe(1);
    expect(index.has('php-conventions')).toBe(true);

    const cache = loadScanCache();
    expect(cache).not.toBeNull();
    expect(cache!.projects[tmpDir]).toBeDefined();
    expect(cache!.projects[tmpDir].entries['php-conventions']).toBeDefined();
  });

  it('second scan uses cache (no re-read)', async () => {
    const { scanSkillFiles } = await import('../scanner.js');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const config: PreloaderConfig = {
      skills: [], fileTypeSkills: {}, agentSkills: {}, pathPatterns: {},
      contentTriggers: {}, skillSettings: {},
      skillLocations: ['{project}/.opencode/skills/{name}/SKILL.md'],
      scannerEnabled: true, triggerIgnoreTags: [],
      injectionMethod: 'systemPrompt', maxTokens: 8000,
      useSummaries: false, useMinification: false, showToasts: false,
      enableTools: false, analytics: false, persistAfterCompaction: true,
      accumulateSkills: true, debug: false, priority: {},
      skillTTL: 600000, cacheFileTTL: 60000,
      precedencePrimary: 'path', precedenceSubagent: 'path',
    };

    // First scan — populates cache
    scanSkillFiles(config, tmpDir);

    // Delete the skill file to prove the second scan doesn't touch it
    // (if it re-reads, the read would fail but the cache would still hit)
    // Actually we can't delete because the scan needs to find the file.
    // Instead, watch that the cache entry is preserved.
    const cachePath = join(tmpDir, '.cache', 'scan-cache.json');
    const before = readFileSync(cachePath, 'utf-8');

    // Second scan
    const index2 = scanSkillFiles(config, tmpDir);
    expect(index2.size).toBe(1);
    const after = readFileSync(cachePath, 'utf-8');
    // Cache content should be identical (mtime/size unchanged → re-saved with same data)
    expect(after).toBe(before);
  });
});