import type { LoadedSkill } from "./loader.js";

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

  /** Session ID this manager is bound to */
  readonly sessionID: string;

  constructor(
    sessionID: string,
    private maxTokens: number = 8_000,
    private debug: boolean = false,
    private skillTTL: number = 600_000, // 10 min default
    private useMinification: boolean | "standard" | "aggressive" = false,
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
      // Apply minification if enabled
      if (this.useMinification) {
        entry.skill = {
          ...entry.skill,
          content: this.minifyContent(entry.skill.content, this.useMinification),
        };
      }
      entry.loadedAt = Date.now();
      this.activeSkills.set(name, entry);
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
   */
  getBudgetStatus(): BudgetStatus {
    this.evictStale();

    const allSkills = Array.from(this.activeSkills.values())
      .sort((a, b) => b.skill.priority - a.skill.priority);

    let used = 0;
    const loaded: LoadedSkill[] = [];
    for (const entry of allSkills) {
      const t = this.estimateTokens(entry.skill.content);
      if (used + t <= this.maxTokens) {
        used += t;
        loaded.push(entry.skill);
      }
    }

    const dropped = Array.from(this.droppedCache.values()).map((e) => ({
      name: e.skill.name,
      priority: e.skill.priority,
      tokens: this.estimateTokens(e.skill.content),
    }));

    return {
      used,
      limit: this.maxTokens,
      dropped,
      loadedCount: loaded.length,
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
}

// ── Session Registry ────────────────────────────────────────────────────────

const sessions = new Map<string, SessionManager>();

export function getOrCreateSession(
  sessionID: string,
  maxTokens?: number,
  debug?: boolean,
  skillTTL?: number,
  useMinification?: boolean | "standard" | "aggressive",
): SessionManager {
  let mgr = sessions.get(sessionID);
  if (!mgr) {
    mgr = new SessionManager(sessionID, maxTokens, debug, skillTTL, useMinification);
    sessions.set(sessionID, mgr);
  }
  return mgr;
}

export function deleteSession(sessionID: string): void {
  sessions.delete(sessionID);
}
