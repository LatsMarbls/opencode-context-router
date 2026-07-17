import type { LoadedSkill } from "./loader.js";
import { trackSkillLoaded, trackSkillDropped, trackSkillEvicted } from "./analytics.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillQueueEntry {
  skill: LoadedSkill;
  /** Unix timestamp when queued */
  queuedAt: number;
  /** Unix timestamp when promoted to active (used for TTL eviction) */
  loadedAt: number;
  /** How it was triggered (for debugging) */
  trigger: string;
}

// ── Session Manager ─────────────────────────────────────────────────────────

export interface BudgetStatus {
  /** Total estimated tokens across all active skills */
  used: number;
  /** Token budget ceiling */
  limit: number;
  /** Skills that were dropped because budget was exceeded */
  dropped: { name: string; priority: number; tokens: number }[];
  /** How many skills survived the budget filter */
  loadedCount: number;
}

export class SessionManager {
  /** Skills loaded in current session, keyed by name for dedup */
  private activeSkills = new Map<string, SkillQueueEntry>();

  /** Queue of skills pending injection on next LLM call */
  private pendingQueue = new Map<string, SkillQueueEntry>();

  /** Skills that were loaded then dropped by budget filter */
  private droppedCache = new Map<string, SkillQueueEntry>();

  /** Content hashes of skills already injected this turn.
   *  Used by dedup to avoid re-scanning the entire system prompt every turn. */
  private injectedHashes = new Set<string>();

  /** Session ID this manager is bound to */
  readonly sessionID: string;

  constructor(
    sessionID: string,
    private maxTokens: number = 8_000,
    private debug: boolean = false,
    private skillTTL: number = 600_000, // 10 min default
    private useMinification: boolean | "standard" | "aggressive" = false,
    private useSummaries: boolean = false,
    private skillSettings: Record<string, { useSummary?: boolean }> = {},
    private analytics: boolean = false,
  ) {
    this.sessionID = sessionID;
  }

  // ── Queuing ─────────────────────────────────────────

  /**
   * Queue one or more skills for injection.
   * If a skill with the same name already exists, higher priority wins.
   */
  queueSkills(skills: LoadedSkill[], trigger: string): void {
    for (const skill of skills) {
      const existing = this.pendingQueue.get(skill.name);
      if (existing && existing.skill.priority >= skill.priority) {
        continue; // Existing is same-or-higher priority, keep it
      }

      this.pendingQueue.set(skill.name, {
        skill,
        queuedAt: Date.now(),
        loadedAt: 0, // set when promoted to active
        trigger,
      });

      if (this.debug) {
        console.log(`[context-routing] Queued skill "${skill.name}" (trigger: ${trigger}, priority: ${skill.priority})`);
      }
    }
  }

  /**
   * Promote all pending skills to active.
   * Returns the final sorted list of active skills.
   */
  flushPending(): LoadedSkill[] {
    for (const [name, entry] of this.pendingQueue) {
      // Apply summarization FIRST (reduces content before minification)
      const shouldSummarize = this.useSummaries
        && (this.skillSettings[name]?.useSummary !== false)
        && entry.skill.content.length > 500;
      if (shouldSummarize) {
        entry.skill = {
          ...entry.skill,
          content: this.summarizeContent(entry.skill.content),
        };
      }

      // Apply minification if enabled
      if (this.useMinification) {
        entry.skill = {
          ...entry.skill,
          content: this.minifyContent(entry.skill.content, this.useMinification),
        };
      }
      entry.loadedAt = Date.now();
      this.activeSkills.set(name, entry);

      // Track analytics for this skill load
      if (this.analytics) {
        const tokens = this.estimateTokens(entry.skill.content);
        trackSkillLoaded(this.sessionID, name, entry.trigger, entry.skill.priority, tokens);
      }

      // If this skill was previously dropped by budget, re-activate clears that
      this.droppedCache.delete(name);
    }
    this.pendingQueue.clear();
    return this.getActiveSkills();
  }

  /**
   * Get all active skills, sorted by priority descending, then by queue time ascending.
   * Filters stale skills by TTL, then applies token budget.
   */
  getActiveSkills(): LoadedSkill[] {
    this.evictStale();

    const skills = Array.from(this.activeSkills.values())
      .sort((a, b) => {
        // Higher priority first
        const prioDiff = b.skill.priority - a.skill.priority;
        if (prioDiff !== 0) return prioDiff;
        // Then by queue time (FIFO)
        return a.queuedAt - b.queuedAt;
      });

    return this.applyTokenBudget(skills.map(e => e.skill));
  }

  /** Remove skills whose TTL has expired */
  private evictStale(): void {
    if (this.skillTTL <= 0) return;
    const now = Date.now();
    for (const [name, entry] of this.activeSkills) {
      if (entry.loadedAt > 0 && (now - entry.loadedAt) > this.skillTTL) {
        this.activeSkills.delete(name);
        if (this.analytics) {
          trackSkillEvicted(this.sessionID, name);
        }
        if (this.debug) {
          console.log(`[context-routing] Evicted stale skill "${name}" (TTL ${this.skillTTL}ms exceeded)`);
        }
      }
    }
  }

  /**
   * Get all active skills as formatted markdown for system prompt injection.
   */
  getFormattedSkills(): string {
    const skills = this.getActiveSkills();
    if (skills.length === 0) return "";

    const parts = skills.map(s => {
      return `<context-route name="${s.name}">\n${s.content.trim()}\n</context-route>`;
    });

    return `\n${parts.join("\n\n")}\n`;
  }

  /**
   * Get a compact summary of active skills (for compaction context).
   */
  getSkillsSummary(): string {
    const skills = this.getActiveSkills();
    if (skills.length === 0) return "";

    const lines = skills.map(s =>
      `- **${s.name}** (${s.source}, priority ${s.priority})`
    );

    return `## Context Routes\n${lines.join("\n")}\n`;
  }

  /**
   * Check if a skill is already loaded.
   */
  hasSkill(name: string): boolean {
    return this.activeSkills.has(name) || this.pendingQueue.has(name);
  }

  /**
   * Filter active skills to those whose content has not yet been injected
   * this turn. O(1) per skill via the injected-hash Set.
   * Returns the new skills and marks them as injected in-place.
   */
  filterNewForInjection(): LoadedSkill[] {
    const result: LoadedSkill[] = [];
    for (const skill of this.getActiveSkills()) {
      const hash = hashContent(skill.content);
      if (this.injectedHashes.has(hash)) continue;
      this.injectedHashes.add(hash);
      result.push(skill);
    }
    return result;
  }

  /**
   * Clear the injected-hash Set (call at start of each turn when
   * `accumulateSkills: false`, so skills can be re-injected fresh).
   */
  clearInjectionCache(): void {
    this.injectedHashes.clear();
  }
  /**
   * Remove a skill from both active and pending.
   */
  removeSkill(name: string): void {
    this.activeSkills.delete(name);
    this.pendingQueue.delete(name);
  }

  /**
   * Clear all skills for this session.
   */
  clear(): void {
    this.activeSkills.clear();
    this.pendingQueue.clear();
  }

  // ── Private ──────────────────────────────────────────

  private applyTokenBudget(skills: LoadedSkill[]): LoadedSkill[] {
    if (this.maxTokens <= 0) return skills;

    let total = 0;
    const result: LoadedSkill[] = [];
    this.droppedCache.clear();

    for (const skill of skills) {
      const tokens = this.estimateTokens(skill.content);
      if (total + tokens > this.maxTokens) {
        // Track dropped skill (still iterate to capture all for dashboard)
        this.droppedCache.set(skill.name, {
          skill,
          queuedAt: Date.now(),
          loadedAt: 0,
          trigger: "dropped:budget",
        });

        if (this.analytics) {
          trackSkillDropped(this.sessionID, skill.name, skill.priority, tokens);
        }

        if (this.debug) {
          console.log(`[context-routing] Budget exceeded at "${skill.name}" (${total}+${tokens} > ${this.maxTokens})`);
        }
        // Skills sorted by priority descending — once budget exceeded,
        // no lower-priority skill will fit either
        continue;
      }
      total += tokens;
      result.push(skill);
    }

    return result;
  }

  /**
   * Get current budget status (used tokens, limit, dropped skills).
   * Single source of truth: derives both `used` and `dropped` from one
   * `getActiveSkills()` call so they can never disagree.
   */
  getBudgetStatus(): BudgetStatus {
    this.evictStale();

    const allEntries = Array.from(this.activeSkills.values())
      .sort((a, b) => b.skill.priority - a.skill.priority);

    const loadedSkills = this.applyTokenBudget(allEntries.map(e => e.skill));
    const loadedNames = new Set(loadedSkills.map(s => s.name));

    const used = loadedSkills.reduce(
      (sum, s) => sum + this.estimateTokens(s.content),
      0,
    );

    const dropped = allEntries
      .filter(e => !loadedNames.has(e.skill.name))
      .map(e => ({
        name: e.skill.name,
        priority: e.skill.priority,
        tokens: this.estimateTokens(e.skill.content),
      }));

    return {
      used,
      limit: this.maxTokens,
      dropped,
      loadedCount: loadedSkills.length,
    };
  }

  /**
   * Rough token estimate with markdown overhead penalty.
   * Headings, bullets, and code fences add visual noise that tokenizers
   * split into extra tokens, so we inflate char count accordingly.
   */
  private estimateTokens(text: string): number {
    let chars = text.length;

    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#')) chars += 2;        // heading markers
      else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) chars += 1; // bullets
      else if (trimmed.startsWith('```')) chars += 2;  // code fences
    }

    return Math.ceil(chars / 4);
  }

  /**
   * Strip markdown noise to reduce token count.
   * "standard" mode: remove HTML comments, collapse 3+ blank lines to 2.
   * "aggressive" mode: also strip markdown link syntax, image tags, and trailing whitespace.
   */
  minifyContent(content: string, level: boolean | "standard" | "aggressive" = false): string {
    if (!level) return content;

    let result = content;

    // Standard: remove HTML comments
    result = result.replace(/<!--[\s\S]*?-->/g, "");

    // Standard: collapse 3+ consecutive blank lines to 2
    result = result.replace(/\n{3,}/g, "\n\n");

    // Standard: trim trailing whitespace per line
    result = result.replace(/[ \t]+$/gm, "");

    if (level === "aggressive") {
      // Strip markdown image syntax: ![alt](url) → alt
      result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
      // Strip markdown link syntax: [text](url) → text
      result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      // Strip reference-style links: [text][ref] → text
      result = result.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
      // Remove link definitions: [ref]: url
      result = result.replace(/^\[[^\]]*\]:\s+.*$/gm, "");
      // Collapse multiple spaces
      result = result.replace(/  +/g, " ");
      // Collapse 2+ blank lines to 1
      result = result.replace(/\n{2,}/g, "\n");
    }

    return result.trim();
  }

  /**
   * Generate a structural summary of a skill file.
   * Extracts headings, first sentences of sections, and code block hints.
   * Reduces token count by ~60% while preserving the skill's intent.
   */
  summarizeContent(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let lastHeading = '';
    let sectionFirstLine = '';
    let capturedFirstLine = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Track code blocks — just note the language
      if (trimmed.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          const lang = trimmed.slice(3).trim();
          if (lang) result.push(`\`\`\`${lang} ... \`\`\``);
        } else {
          inCodeBlock = false;
        }
        continue;
      }
      if (inCodeBlock) continue;

      // Capture headings
      if (trimmed.startsWith('#')) {
        // Flush previous section's first line
        if (sectionFirstLine && !capturedFirstLine) {
          result.push(sectionFirstLine);
          capturedFirstLine = true;
        }
        result.push(trimmed);
        lastHeading = trimmed;
        sectionFirstLine = '';
        capturedFirstLine = false;
        continue;
      }

      // Capture first non-empty line after a heading
      if (lastHeading && !trimmed && !sectionFirstLine) continue;
      if (lastHeading && trimmed && !sectionFirstLine) {
        sectionFirstLine = trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
        capturedFirstLine = false;
      }

      // Tables: keep header row and separator only
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        if (!result.some(r => r.startsWith('|') && r.includes('---'))) {
          result.push(trimmed);
        }
        // Also keep separator if this is it
        if (trimmed.includes('---')) {
          result.push(trimmed);
        }
        continue;
      }

      // Lists: keep first item of each list
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
        if (!capturedFirstLine) {
          result.push(trimmed.length > 100 ? trimmed.slice(0, 97) + '...' : trimmed);
          capturedFirstLine = true;
        }
        continue;
      }
    }

    // Flush last section
    if (sectionFirstLine && !capturedFirstLine) {
      result.push(sectionFirstLine);
    }

    return result.join('\n').trim();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * DJB2 hash — fast non-cryptographic string hash used for content dedup.
 * Collisions are astronomically unlikely for skill-sized strings and would
 * just cause a false-positive dedup (one fewer skill injected), not data loss.
 */
function hashContent(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return `h${(hash >>> 0).toString(36)}`;
}

// ── Session Registry ────────────────────────────────────────────────────────

const sessions = new Map<string, SessionManager>();

export function getOrCreateSession(
  sessionID: string,
  maxTokens?: number,
  debug?: boolean,
  skillTTL?: number,
  useMinification?: boolean | "standard" | "aggressive",
  useSummaries?: boolean,
  skillSettings?: Record<string, { useSummary?: boolean }>,
  analytics?: boolean,
): SessionManager {
  let mgr = sessions.get(sessionID);
  if (!mgr) {
    mgr = new SessionManager(sessionID, maxTokens, debug, skillTTL, useMinification, useSummaries, skillSettings, analytics);
    sessions.set(sessionID, mgr);
  }
  return mgr;
}

export function deleteSession(sessionID: string): void {
  sessions.delete(sessionID);
}
