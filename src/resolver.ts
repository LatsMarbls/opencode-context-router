/**
 * Resolver — matches file/message/agent triggers to skill names.
 * The central "pattern matching" engine that decides what skills to load.
 */
import type { PreloaderConfig } from "./config.js";
import type { LoadedSkill } from "./loader.js";

// ── Resolver ────────────────────────────────────────────────────────────────

export class Resolver {
  constructor(private config: PreloaderConfig) {}

  /**
   * Given an absolute file path, resolve all skill names that match
   * based on extension and path patterns.
   */
  resolveFileTriggers(filePath: string): string[] {
    if (shouldIgnorePath(filePath, this.config.triggerIgnoreTags)) {
      return [];
    }

    const matched = new Set<string>();
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

    // 1. Extension-based
    const extSkills = this.config.fileTypeSkills[`.${ext}`];
    if (extSkills) {
      extSkills.forEach(s => matched.add(s));
    }

    // Also try bare extension
    const bareExtSkills = this.config.fileTypeSkills[ext];
    if (bareExtSkills && ext !== `.${ext}`) {
      bareExtSkills.forEach(s => matched.add(s));
    }

    // 2. Path pattern matching (glob-like)
    for (const [pattern, skills] of Object.entries(this.config.pathPatterns)) {
      if (matchGlob(filePath, pattern)) {
        skills.forEach(s => matched.add(s));
      }
    }

    return Array.from(matched);
  }

  /**
   * Given an agent name, resolve all skills that should always load
   * for that agent.
   */
  resolveAgentTriggers(agentName: string): string[] {
    const matched = new Set<string>();

    for (const [pattern, skills] of Object.entries(this.config.agentSkills)) {
      if (matchGlob(agentName, pattern)) {
        skills.forEach(s => matched.add(s));
      }
    }

    return Array.from(matched);
  }

  /**
   * Given a user message, resolve skills triggered by keywords/phrases.
   */
  resolveMessageTriggers(messageText: string): string[] {
    const matched = new Set<string>();

    for (const [pattern, skills] of Object.entries(this.config.contentTriggers)) {
      try {
        const re = new RegExp(pattern, "im");
        if (re.test(messageText)) {
          skills.forEach(s => matched.add(s));
        }
      } catch {
        // Plain string substring match
        if (messageText.toLowerCase().includes(pattern.toLowerCase())) {
          skills.forEach(s => matched.add(s));
        }
      }
    }

    return Array.from(matched);
  }

  /**
   * Get all "always-on" skill names (from priorities > 0 or skillSettings.always).
   */
  getAlwaysOnSkills(): string[] {
    return Object.entries(this.config.skillSettings)
      .filter(([_, s]) => s.always)
      .map(([name]) => name);
  }

  /**
   * Merge an array of skill names into a priority-sorted, deduplicated list.
   * Higher priority = first. Ties broken alphabetically.
   */
  sortByPriority(skillNames: string[]): string[] {
    const seen = new Set<string>();
    return skillNames
      .filter(name => {
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      })
      .sort((a, b) => {
        const pa = this.config.priority[a]
          ?? this.config.skillSettings[a]?.priority
          ?? 5;
        const pb = this.config.priority[b]
          ?? this.config.skillSettings[b]?.priority
          ?? 5;
        if (pa !== pb) return pb - pa; // descending
        return a.localeCompare(b);
      });
  }
}

// ── Glob-like matcher (simple, no **) ──────────────────────────────────────

function matchGlob(text: string, pattern: string): boolean {
  // Normalize separators
  text = text.replace(/\\/g, "/");
  pattern = pattern.replace(/\\/g, "/");

  // Exact match shortcut
  if (pattern === text) return true;

  // Simple suffix/prefix/infix matching
  if (pattern.startsWith("**/")) {
    return text.endsWith(pattern.slice(3));
  }
  if (pattern.endsWith("/**")) {
    return text.startsWith(pattern.slice(0, -3));
  }
  if (pattern.includes("*")) {
    const re = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$",
    );
    return re.test(text);
  }

  // Prefix match (directory prefix)
  if (pattern.endsWith("/")) {
    return text.startsWith(pattern);
  }

  return text.includes(pattern);
}

/**
 * Check if a file path should be ignored (node_modules, vendor, etc.)
 */
function shouldIgnorePath(absPath: string, ignoreTags: string[]): boolean {
  if (ignoreTags.length === 0) return false;
  const normalized = absPath.replace(/\\/g, "/").toLowerCase();
  return ignoreTags.some(tag => normalized.includes(tag.toLowerCase()));
}
