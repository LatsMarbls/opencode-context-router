/**
 * Resolver — matches file/message/agent triggers to skill names.
 *
 * Merges two trigger sources:
 *   1. Config trigger maps (explicit declarations in context-router.jsonc)
 *   2. Scanned trigger index (from skill files with YAML frontmatter)
 *
 * Config triggers take priority over scanned triggers for the same skill name.
 */
import type { PreloaderConfig } from "./config.js";
import type { ScannedSkillIndex } from "./scanner.js";

// ── Resolver ────────────────────────────────────────────────────────────────

export class Resolver {
  /** Reverse map: skillName → groupNames it belongs to (from scanned frontmatter) */
  private skillToGroups = new Map<string, string[]>();

  constructor(
    private config: PreloaderConfig,
    private scannedIndex: ScannedSkillIndex = new Map(),
  ) {
    // Build reverse map from scanned frontmatter groups field
    for (const [name, meta] of scannedIndex) {
      if (meta.groups?.length) {
        this.skillToGroups.set(name, meta.groups);
      }
    }
  }

  /**
   * Given an absolute file path, resolve all skill names that match
   * based on extension and path patterns. Checks both config and scanned sources.
   */
  resolveFileTriggers(filePath: string): string[] {
    if (shouldIgnorePath(filePath, this.config.triggerIgnoreTags)) {
      return [];
    }

    const matched = new Set<string>();
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

    // 1. Config extension-based
    const extSkills = this.config.fileTypeSkills[`.${ext}`];
    if (extSkills) extSkills.forEach(s => matched.add(s));
    const bareExtSkills = this.config.fileTypeSkills[ext];
    if (bareExtSkills && ext !== `.${ext}`) {
      bareExtSkills.forEach(s => matched.add(s));
    }

    // 2. Config path patterns
    for (const [pattern, skills] of Object.entries(this.config.pathPatterns)) {
      if (matchGlob(filePath, pattern)) {
        skills.forEach(s => matched.add(s));
      }
    }

    // 3. Scanned extension triggers
    for (const [name, meta] of this.scannedIndex) {
      if (meta.triggers.extensions?.some(e => e === `.${ext}` || e === ext)) {
        matched.add(name);
      }
    }

    // 4. Scanned path triggers
    const normPath = filePath.replace(/\\/g, "/");
    for (const [name, meta] of this.scannedIndex) {
      if (meta.triggers.paths?.some(p => matchGlob(normPath, p))) {
        matched.add(name);
      }
    }

    return Array.from(matched);
  }

  /**
   * Given an agent name, resolve all skills triggered for that agent.
   */
  resolveAgentTriggers(agentName: string): string[] {
    const matched = new Set<string>();

    // Config agent triggers
    for (const [pattern, skills] of Object.entries(this.config.agentSkills)) {
      if (matchGlob(agentName, pattern)) {
        skills.forEach(s => matched.add(s));
      }
    }

    // Scanned agent triggers
    for (const [name, meta] of this.scannedIndex) {
      if (meta.triggers.agents?.some(a => matchGlob(agentName, a))) {
        matched.add(name);
      }
    }

    return Array.from(matched);
  }

  /**
   * Given a user message, resolve skills triggered by keywords.
   * Uses whole-word matching to avoid false triggers:
   *   "typescript" matches "use typescript" but NOT "typescript-rule"
   *   "ts"         matches "ts" but NOT "its" or "typescript"
   */
  resolveMessageTriggers(messageText: string): string[] {
    const matched = new Set<string>();

    // Config keyword triggers
    for (const [pattern, skills] of Object.entries(this.config.contentTriggers)) {
      if (matchesWholeWord(messageText, pattern)) {
        skills.forEach(s => matched.add(s));
      }
    }

    // Scanned keyword triggers
    for (const [name, meta] of this.scannedIndex) {
      for (const kw of meta.triggers.keywords ?? []) {
        if (matchesWholeWord(messageText, kw)) {
          matched.add(name);
          break;
        }
      }
    }

    return Array.from(matched);
  }

  /**
   * Get all skill names that should always be loaded.
   * Merges config always-on + scanned always-on.
   */
  getAlwaysOnSkills(): string[] {
    const always = new Set<string>();

    // Config always-on (from skillSettings)
    for (const [name, s] of Object.entries(this.config.skillSettings)) {
      if (s.always) always.add(name);
    }

    // Scanned always-on
    for (const [name, meta] of this.scannedIndex) {
      if (meta.always) always.add(name);
    }

    return Array.from(always);
  }

  /**
   * Merge an array of skill names into a priority-sorted, deduplicated list.
   * Priority resolution order: config.priority → config.skillSettings → scanned → default 5
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
        const pa = this.resolvePriority(a);
        const pb = this.resolvePriority(b);
        if (pa !== pb) return pb - pa;
        return a.localeCompare(b);
      });
  }

  /**
   * Get the effective priority for a skill name.
   * Config > scanned > default.
   */
  resolvePriority(name: string): number {
    return (
      this.config.priority[name]
      ?? this.config.skillSettings[name]?.priority
      ?? this.scannedIndex.get(name)?.priority
      ?? 5
    );
  }

  /**
   * Expand skill names through group membership.
   *
   * Groups are defined SOLELY by frontmatter. A group "laravel-stack" exists
   * iff at least one skill's frontmatter `groups: ["laravel-stack", ...]`.
   *
   * Two directions:
   *   1. Name is a group name → load all skills with that group in frontmatter
   *   2. Name is a skill with `groups: [...]` → load all siblings (skills sharing
   *      any of those group names)
   *
   * Recurses up to 3 passes to handle nested groups (A → B → C).
   *
   * Note: "always-on" loading is handled separately via `getAlwaysOnSkills()`,
   * not via a magic "always" group.
   */
  expandGroups(skillNames: string[]): string[] {
    const result = new Set<string>();

    // Build reverse map: groupName → [skillName, ...] from frontmatter
    const groupToMembers = new Map<string, string[]>();
    for (const [skillName, meta] of this.scannedIndex) {
      for (const group of meta.groups ?? []) {
        const members = groupToMembers.get(group) ?? [];
        members.push(skillName);
        groupToMembers.set(group, members);
      }
    }

    // Seed with original names
    skillNames.forEach(n => result.add(n));

    // Expand iteratively (max 3 passes for nested groups)
    for (let pass = 0; pass < 3; pass++) {
      const toExpand = [...result];
      let added = false;

      for (const name of toExpand) {
        // 1. Is this name a group key? Load all members.
        const members = groupToMembers.get(name);
        if (members) {
          for (const m of members) {
            if (!result.has(m)) { result.add(m); added = true; }
          }
          continue;
        }

        // 2. Is this a skill with group membership? Load siblings.
        const groups = this.skillToGroups.get(name);
        if (groups) {
          for (const groupName of groups) {
            const siblings = groupToMembers.get(groupName);
            if (siblings) {
              for (const sib of siblings) {
                if (!result.has(sib)) { result.add(sib); added = true; }
              }
            }
          }
        }
      }

      if (!added) break;
    }

    return Array.from(result);
  }
}

// ── Glob-like matcher ————————————————————————————————————————————————————

function matchGlob(text: string, pattern: string): boolean {
  text = text.replace(/\\/g, "/");
  pattern = pattern.replace(/\\/g, "/");

  if (pattern === text) return true;

  // Build regex from glob, handling **/ (any depth prefix), /** (any depth suffix),
  // * (single segment wildcard), ? (single char), trailing / (directory prefix).
  const re = buildGlobRegex(pattern);
  if (re) {
    // Test full text
    if (re.test(text)) return true;
    // Test each path suffix — handles absolute paths against relative patterns.
    // e.g., "/project/src/Models/User.php" against "src/Models/**"
    // tries suffixes: "project/src/Models/User.php", "src/Models/User.php", …
    const parts = text.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (re.test(parts.slice(i).join("/"))) return true;
    }
    return false;
  }

  return text.includes(pattern);
}

function buildGlobRegex(pattern: string): RegExp | null {
  try {
    let s = "^";
    let i = 0;
    while (i < pattern.length) {
      if (pattern[i] === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
        // ** — match any directory depth
        if (i + 2 < pattern.length && pattern[i + 2] === "/") {
          s += "(.*/)?";
          i += 3;
        } else {
          // ** at end of pattern
          s += ".*";
          i += 2;
        }
      } else if (pattern[i] === "*") {
        s += "[^/]*";
        i += 1;
      } else if (pattern[i] === "?") {
        s += ".";
        i += 1;
      } else {
        s += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
        i += 1;
      }
    }
    // Trailing / matches anything under that directory
    if (pattern.endsWith("/")) {
      s += ".*";
    }
    s += "$";
    return new RegExp(s);
  } catch {
    return null;
  }
}

/**
 * Check if a file path should be ignored (node_modules, vendor, etc.)
 * Matches on full path segments only — prevents "dist" from matching
 * "src/distribution/services/EmailService.php".
 */
function shouldIgnorePath(absPath: string, ignoreTags: string[]): boolean {
  if (ignoreTags.length === 0) return false;
  const normalized = absPath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  return ignoreTags.some(tag => segments.includes(tag.toLowerCase()));
}

/**
 * Whole-word keyword match. Ensures "typescript" matches "use typescript"
 * but NOT "typescript-rule" or "typescripting".
 * Also handles:
 *   - "ts" does NOT match "its"
 *   - "controller" does NOT match "controllers"
 *   - "c++" matches "write c++ code" (regex special chars escaped)
 *   - Multi-word phrases like "vue component"
 *   - "vue" DOES match "vue3" (digit suffix allowed for version-aware keywords)
 * Case-insensitive.
 *
 * Uses word-boundary detection with explicit char-class checks for hyphen
 * boundaries, avoiding lookbehind for compatibility with older runtimes.
 */
function matchesWholeWord(text: string, keyword: string): boolean {
  if (!keyword) return false;
  // Escape regex special chars so literal keywords don't break the regex
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    // Boundary: (start | non-word-non-hyphen) before.
    // Boundary: after must be (non-word-non-hyphen | end | digits+end).
    // The trailing \d* allows version-like suffixes (vue3, swift5, react18).
    const re = new RegExp(`(?:^|[^\\w-])${escaped}\\d*(?:[^\\w-]|$)`, "i");
    return re.test(text);
  } catch {
    return false;
  }
}
