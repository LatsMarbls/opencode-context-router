import { describe, it, expect } from 'vitest';
import { Resolver } from '../resolver.js';
import { extractPaths } from '../paths.js';
import type { PreloaderConfig } from '../config.js';
import type { ScannedSkillIndex } from '../scanner.js';

// Fixture mirrors the user's 9 real backend skills: each declares `.php`
// extension + `backend-stack` group, with path triggers for specificity.
const skills: Record<string, { paths?: string[]; groups?: string[] }> = {
  'controller-rules': { paths: ['src/Controllers/', 'src/Http/Controllers/', 'app/Http/Controllers/'], groups: ['backend-stack'] },
  'model-rules':      { paths: ['src/Models/', 'app/Models/'], groups: ['backend-stack'] },
  'enum-rules':       { paths: ['src/Enums/', 'app/Enums/'], groups: ['backend-stack'] },
  'php-conventions':  {},
  'laravel-rules':    { paths: ['src/', 'app/'], groups: ['backend-stack'] },
  'migration-rules':  { paths: ['database/migrations/'], groups: ['backend-stack'] },
  'request-rules':    { paths: ['src/Requests/', 'app/Http/Requests/'], groups: ['backend-stack'] },
  'service-rules':    { paths: ['src/Services/', 'app/Services/'], groups: ['backend-stack'] },
  'testing-rules':    { paths: ['tests/'], groups: ['backend-stack'] },
};

const scannedIndex: ScannedSkillIndex = new Map(
  Object.entries(skills).map(([name, { paths, groups }]) => [
    name,
    { name, filePath: '/fake', triggers: { extensions: ['.php'], paths: paths ?? [] }, groups },
  ]),
);

const config: PreloaderConfig = {
  skills: [],
  fileTypeSkills: {},
  agentSkills: {},
  pathPatterns: {},
  contentTriggers: {},
  skillSettings: {},
  skillLocations: [],
  scannerEnabled: true,
  triggerIgnoreTags: ['node_modules', '.git', 'vendor'],
  injectionMethod: 'systemPrompt',
  maxTokens: 8000,
  useSummaries: false,
  useMinification: false,
  showToasts: false,
  enableTools: false,
  analytics: false,
  persistAfterCompaction: true,
  accumulateSkills: false,
  debug: false,
  priority: {},
  skillTTL: 600000,
  cacheFileTTL: 60000,
};

describe('Routing precision (path ≥ extension)', () => {
  it('tagging a controller path loads ONLY controller-rules, not all 9 .php skills', () => {
    const resolver = new Resolver(config, scannedIndex);
    const result = resolver.resolveFileTriggers('src/Http/Controllers/ProductController.php');
    expect(result).toContain('controller-rules');
    expect(result).toContain('laravel-rules');
    expect(result).not.toContain('model-rules');
    expect(result).not.toContain('enum-rules');
    expect(result).not.toContain('service-rules');
    expect(result.length).toBeLessThan(9);
  });

  it('PiaCore path (src/Controllers/) also resolves controller-rules', () => {
    const resolver = new Resolver(config, scannedIndex);
    const result = resolver.resolveFileTriggers('src/Controllers/ProductController.php');
    expect(result).toContain('controller-rules');
    expect(result).not.toContain('model-rules');
  });

  it('tagging a model path loads only the model + base laravel rules (no controller/enum)', () => {
    const resolver = new Resolver(config, scannedIndex);
    const result = resolver.resolveFileTriggers('src/Models/User.php');
    expect(result).toContain('model-rules');
    expect(result).not.toContain('controller-rules');
    expect(result).not.toContain('enum-rules');
  });

  it('tagging a service path loads only service rules', () => {
    const resolver = new Resolver(config, scannedIndex);
    const result = resolver.resolveFileTriggers('app/Services/OrderService.php');
    expect(result).toContain('service-rules');
    expect(result).not.toContain('controller-rules');
  });

  it('a file with NO matching path falls back to extension skills', () => {
    const resolver = new Resolver(config, scannedIndex);
    const result = resolver.resolveFileTriggers('helpers.php');
    // Root-level file — no `src/` / `app/` / test path match → extension set.
    expect(result).toContain('php-conventions');
    expect(result).toContain('model-rules');
  });
});

describe('extractPaths — file + folder references', () => {
  it('extracts a tagged file path (WITHOUT the @ prefix)', () => {
    expect(extractPaths('check @src/Http/Controllers/Controller.php please')).toContain(
      'src/Http/Controllers/Controller.php',
    );
  });

  it('extracts a bare folder reference (keeps trailing slash)', () => {
    expect(extractPaths('refactor @src/Http/Controllers/ now')).toContain('src/Http/Controllers/');
  });

  it('does not absorb surrounding prose into the extracted path', () => {
    const out = extractPaths('open src/Http/X.php now');
    expect(out).toContain('src/Http/X.php');
    expect(out).toContain('src/Http/');
    expect(out.some(p => p.startsWith('open'))).toBe(false);
  });

  it('handles Windows drive + backslash', () => {
    const out = extractPaths('open D:\\Herd\\app\\Controllers\\Home.php');
    expect(out.some(p => p.includes('Controllers/Home.php'))).toBe(true);
  });
});