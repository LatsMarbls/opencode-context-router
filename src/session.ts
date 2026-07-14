import type { LoadedSkill } from "./loader.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillQueueEntry {
  skill: LoadedSkill;
  /** Unix timestamp when queued */
  queuedAt: number;
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
      this.activeSkills.set(name, entry);
    }
    this.pendingQueue.clear();
    return this.getActiveSkills();
  }

  /**
   * Get all active skills, sorted by priority descending, then by queue time ascending.
   * Applies token budget — drops lowest-priority skills when over limit.
   */
  getActiveSkills(): LoadedSkill[] {
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

  /**
   * Get all active skills as formatted markdown for system prompt injection.
   */
  getFormattedSkills(): string {
    const skills = this.getActiveSkills();
    if (skills.length === 0) return "";

    const parts = skills.map(s => {
      return `<preloaded-skill name="${s.name}">\n${s.content.trim()}\n</preloaded-skill>`;
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

    return `## Preloaded Skills\n${lines.join("\n")}\n`;
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
      if (total + tokens > this.maxTokens && result.length > 0) {
        // Track dropped skill
        this.droppedCache.set(skill.name, {
          skill,
          queuedAt: Date.now(),
          trigger: "dropped:budget",
        });
        if (this.debug) {
          console.log(`[context-routing] Budget exceeded at "${skill.name}" (${total}+${tokens} > ${this.maxTokens})`);
        }
        continue; // Don't break — lower-prio might still fit?
        // Actually, skills are already sorted by priority descending.
        // Once we exceed budget on a priority level, lower-prio won't fit either.
        // But we still track all dropped for the dashboard.
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
    const allSkills = Array.from(this.activeSkills.values())
      .sort((a, b) => b.skill.priority - a.skill.priority);

    let used = 0;
    const loaded: LoadedSkill[] = [];
    for (const entry of allSkills) {
      const t = this.estimateTokens(entry.skill.content);
      if (used + t <= this.maxTokens || loaded.length === 0) {
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

  /** Rough token estimate: ~4 chars per token */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ── Session Registry ────────────────────────────────────────────────────────

const sessions = new Map<string, SessionManager>();

export function getOrCreateSession(
  sessionID: string,
  maxTokens?: number,
  debug?: boolean,
): SessionManager {
  let mgr = sessions.get(sessionID);
  if (!mgr) {
    mgr = new SessionManager(sessionID, maxTokens, debug);
    sessions.set(sessionID, mgr);
  }
  return mgr;
}

export function deleteSession(sessionID: string): void {
  sessions.delete(sessionID);
}
