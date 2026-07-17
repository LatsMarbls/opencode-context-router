import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../session.js';
import type { LoadedSkill } from '../loader.js';

function makeSkill(name: string, content: string, priority = 5): LoadedSkill {
  return { name, content, source: 'static-file', priority };
}

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager('test-session', 8000, false, 600000);
  });

  it('queues and flushes skills', () => {
    mgr.queueSkills([makeSkill('a', 'content a')], 'test');
    const active = mgr.flushPending();
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('a');
  });

  it('deduplicates by name — higher priority wins', () => {
    mgr.queueSkills([makeSkill('a', 'low', 5)], 'test');
    mgr.queueSkills([makeSkill('a', 'high', 100)], 'test');
    mgr.flushPending();
    const active = mgr.getActiveSkills();
    expect(active.length).toBe(1);
    expect(active[0].content).toBe('high');
  });

  it('hasSkill checks both active and pending', () => {
    expect(mgr.hasSkill('a')).toBe(false);
    mgr.queueSkills([makeSkill('a', 'content')], 'test');
    expect(mgr.hasSkill('a')).toBe(true);
  });

  it('clear removes all skills', () => {
    mgr.queueSkills([makeSkill('a', 'content')], 'test');
    mgr.flushPending();
    mgr.clear();
    expect(mgr.getActiveSkills().length).toBe(0);
  });

  it('enforces token budget', () => {
    const smallMgr = new SessionManager('test', 50, false, 600000); // 50 tokens
    smallMgr.queueSkills([
      makeSkill('high', 'a'.repeat(100), 100),   // ~25 tok
      makeSkill('mid', 'b'.repeat(100), 50),      // ~25 tok
      makeSkill('low', 'c'.repeat(100), 10),      // ~25 tok — should be dropped
    ], 'test');
    smallMgr.flushPending();
    const active = smallMgr.getActiveSkills();
    expect(active.length).toBe(2);
    expect(active[0].name).toBe('high');
    expect(active[1].name).toBe('mid');
  });

  it('tracks dropped skills in budget status', () => {
    const smallMgr = new SessionManager('test', 50, false, 600000);
    smallMgr.queueSkills([
      makeSkill('high', 'a'.repeat(100), 100),
      makeSkill('low', 'b'.repeat(200), 10),
    ], 'test');
    smallMgr.flushPending();
    smallMgr.getActiveSkills(); // triggers budget
    const status = smallMgr.getBudgetStatus();
    expect(status.dropped.length).toBeGreaterThanOrEqual(1);
    expect(status.dropped[0].name).toBe('low');
  });

  it('evicts stale skills by TTL', async () => {
    const ttlMgr = new SessionManager('test', 8000, false, 50); // 50ms TTL
    ttlMgr.queueSkills([makeSkill('a', 'content')], 'test');
    ttlMgr.flushPending();
    expect(ttlMgr.getActiveSkills().length).toBe(1);
    await new Promise(r => setTimeout(r, 60));
    expect(ttlMgr.getActiveSkills().length).toBe(0);
  });

  it('getSkillsSummary returns formatted string', () => {
    mgr.queueSkills([makeSkill('php-conventions', '# PHP Rules', 50)], 'test');
    mgr.flushPending();
    const summary = mgr.getSkillsSummary();
    expect(summary).toContain('Context Routes');
    expect(summary).toContain('php-conventions');
  });

  describe('summarizeContent', () => {
    it('extracts headings and first lines', () => {
      const content = `# PHP Conventions

Some description here.

## Types

- item one
- item two

## Code Example

\`\`\`php
echo "hello";
\`\`\``;
      const summary = mgr.summarizeContent(content);
      expect(summary).toContain('# PHP Conventions');
      expect(summary).toContain('## Types');
      expect(summary).toContain('## Code Example');
      expect(summary).toContain('```php ... ```');
      expect(summary).not.toContain('echo "hello"');
    });
  });
});