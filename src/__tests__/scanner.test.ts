import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';
import { parseFrontmatter } from '../scanner.js';

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