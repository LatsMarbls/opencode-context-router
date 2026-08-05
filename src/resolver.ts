/**
 * Resolver — matches file/message/agent triggers to skill names.
 *
 * Merges two trigger sources:
 *   1. Config trigger maps (explicit declarations in context-router.jsonc)
 *   2. Scanned trigger index (from skill files with YAML frontmatter)
 *
 * Config triggers take priority over scanned triggers for the same skill name.
 *
 * Routing semantics:
 *   - FILE/FOLDER paths: a matched trigger bucket (path OR extension) can take
 *     precedence per config.precedencePrimary / precedenceSubagent. By default
 *     a folder-path match suppresses the broad extension list (path-wins); with
 *     precedence "extension", the .ext trigger wins instead. The losing bucket
 *     is only used as fallback when the winning bucket is empty.
 */
import type { PreloaderConfig } from "./config.js";
import type { ScannedSkillIndex } from "./scanner.js";

// ── Resolver ────────────────────────────────────────────────────────────────

interface PathEntry {
  regex: RegExp;
  names: string[];
}

export class Resolver {
  /** Reverse map: skillName → groupNames it belongs to (from scanned frontmatter) */
  private skillToGroups = new Map<string, string[]>();

  /** Reverse map: groupName → member skills (from scanned frontmatter) */
  private groupToMembers = new Map<string, string[]>();

  /** All known group names (precomputed) */
  private allGroupNames: string[] = [];

  /** Extension → skills (merged config + scanned), keys normalized w/o leading dot */
  private extToSkills = new Map<string, string[]>();

  /** Compiled path entries (merged config + scanned) */
  private pathEntries: PathEntry[] = [];

  /** Compiled agent entries (merged config + scanned) */
  private agentEntries: PathEntry[] = [];

  /** Whole-word keyword regex cache (compiled once per keyword) */
  private kwRegexCache = new Map<string, RegExp | null>();

  constructor(
    private config: PreloaderConfig,
    private scannedIndex: ScannedSkillIndex = new Map(),
  ) {
    this.buildGroupIndexes();
    this.buildExtensionIndex();
    this.buildPathIndex();
    this.buildAgentIndex();
  }

  // ── Index construction (once per reload) ────────────────────────────────

  private buildGroupIndexes(): void {
    for (const [name, meta] of this.scannedIndex) {
      if (!meta.groups?.length) continue;
      this.skillToGroups.set(name, meta.groups);
      for (const g of meta.groups) {
        const members = this.groupToMembers.get(g) ?? [];
        members.push(name);
        this.groupToMembers.set(g, members);
      }
    }
    const names = new Set<string>();
    for (const members of this.groupToMembers.values()) {
      for (const m of members) names.add(m);
    }
    this.allGroupNames = Array.from(names);
  }

  private addExt(ext: string, name: string): void {
    const key = ext.replace(/^\./, "").toLowerCase();
    const arr = this.extToSkills.get(key) ?? [];
    if (!arr.includes(name)) arr.push(name);
    this.extToSkills.set(key, arr);
  }

  private buildExtensionIndex(): void {
    for (const [ext, names] of Object.entries(this.config.fileTypeSkills)) {
      for (const n of names) this.addExt(ext, n);
    }
    for (const [name, meta] of this.scannedIndex) {
      for (const e of meta.triggers.extensions ?? []) {
        this.addExt(e, name);
      }
    }
  }

  private addPathEntry(pattern: string, names: string[]): void {
    const regex = buildGlobRegex(pattern.replace(/\\/g, "/"));
    if (regex) this.pathEntries.push({ regex, names });
  }

  private buildPathIndex(): void {
    for (const [pattern, names] of Object.entries(this.config.pathPatterns)) {
      this.addPathEntry(pattern, names);
    }
    for (const [name, meta] of this.scannedIndex) {
      for (const p of meta.triggers.paths ?? []) {
        this.addPathEntry(p, [name]);
      }
    }
  }

  private buildAgentIndex(): void {
    for (const [pattern, names] of Object.entries(this.config.agentSkills)) {
      const regex = buildGlobRegex(pattern.replace(/\\/g, "/"));
      if (regex) this.agentEntries.push({ regex, names });
    }
    for (const [name, meta] of this.scannedIndex) {
      for (const a of meta.triggers.agents ?? []) {
        const regex = buildGlobRegex(a.replace(/\\/g, "/"));
        if (regex) this.agentEntries.push({ regex, names: [name] });
      }
    }
  }

  // ── File triggers ──────────────────────────────────────────────────────

  /**
   * Given an absolute file path, resolve all skill names that match
   * based on extension and path patterns. Checks both config and scanned sources.
   *
   * Precedence when a file matches BOTH a path pattern and an extension trigger:
   *   "path"      — path-matched skills win, extension suppressed
   *   "extension" — extension-triggered skills win, path suppressed
   * If the winning bucket is empty, the other bucket is used as fallback.
   * The primary/subagent choice is made by the caller; defaults to
   * config.precedencePrimary when omitted.
   */
  resolveFileTriggers(filePath: string, precedence?: "path" | "extension"): string[] {
    if (shouldIgnorePath(filePath, this.config.triggerIgnoreTags)) {
      return [];
    }

    const normPath = filePath.replace(/\\/g, "/");
    const pathMatched = new Set<string>();
    const extMatched = new Set<string>();

    // Path patterns (config + scanned).
    for (const entry of this.pathEntries) {
      if (testGlob(normPath, entry.regex)) {
        entry.names.forEach(n => pathMatched.add(n));
      }
    }

    // Extension triggers (config + scanned).
    const ext = normPath.split(".").pop()?.toLowerCase() ?? "";
    const extSkills = this.extToSkills.get(ext);
    if (extSkills) extSkills.forEach(s => extMatched.add(s));

    const mode = precedence ?? this.config.precedencePrimary;
    if (mode === "extension") {
      if (extMatched.size > 0) return Array.from(extMatched);
      return Array.from(pathMatched);
    }
    if (pathMatched.size > 0) return Array.from(pathMatched);
    return Array.from(extMatched);
  }

  // ── Agent triggers ─────────────────────────────────────────────────────

  /**
   * Given an agent name, resolve all skills triggered for that agent.
   */
  resolveAgentTriggers(agentName: string): string[] {
    const matched = new Set<string>();
    for (const entry of this.agentEntries) {
      if (testGlob(agentName.replace(/\\/g, "/"), entry.regex)) {
        entry.names.forEach(n => matched.add(n));
      }
    }
    return Array.from(matched);
  }

  // ── Message triggers ───────────────────────────────────────────────────

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
      if (this.matchesWholeWord(messageText, pattern)) {
        skills.forEach(s => matched.add(s));
      }
    }

    // Scanned keyword triggers
    for (const [name, meta] of this.scannedIndex) {
      for (const kw of meta.triggers.keywords ?? []) {
        if (this.matchesWholeWord(messageText, kw)) {
          matched.add(name);
          break;
        }
      }
    }

    return Array.from(matched);
  }

  /**
   * Get all known group names from scanned skill frontmatter.
   */
  getAllGroupNames(): string[] {
    return this.allGroupNames;
  }

  /**
   * Check if message text contains any group name as a whole word.
   * Returns matching group names — these will be passed to expandGroups
   * to load all member skills of that group.
   *
   * Example: "load all backend-stack rules" → ["backend-stack"]
   * Unlike resolveMessageTriggers, this triggers GROUP expansion rather
   * than loading a single skill.
   */
  resolveGroupNameTriggers(messageText: string): string[] {
    const matched: string[] = [];
    for (const groupName of this.allGroupNames) {
      if (this.matchesWholeWord(messageText, groupName)) {
        matched.push(groupName);
      }
    }
    return matched;
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
   */
  expandGroups(skillNames: string[]): string[] {
    const result = new Set<string>(skillNames);

    for (let pass = 0; pass < 3; pass++) {
      const toExpand = [...result];
      let added = false;

      for (const name of toExpand) {
        // 1. Is this name a group key? Load all members.
        const members = this.groupToMembers.get(name);
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
            const siblings = this.groupToMembers.get(groupName);
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

  // ── Word/keyword matching (compiled once per keyword) ───────────────────

  /**
   * Whole-word keyword match. Ensures "typescript" matches "use typescript"
   * but NOT "typescript-rule" or "typescripting".
   * Case-insensitive, allows digit suffixes ("vue3", "swift5").
   */
  private matchesWholeWord(text: string, keyword: string): boolean {
    if (!keyword) return false;

    let re = this.kwRegexCache.get(keyword);
    if (re === undefined) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try {
        re = new RegExp(`(?:^|[^\\w-])${escaped}\\d*(?:[^\\w-]|$)`, "i");
      } catch {
        re = null;
      }
      this.kwRegexCache.set(keyword, re);
    }
    return re !== null && re.test(text);
  }
}

// ── Glob-like matcher ————————————————————————————————————————————————————
// Regexes are compiled once and reused; matching tests the full path plus
// every path suffix so relative patterns match absolute inputs.

function testGlob(text: string, re: RegExp): boolean {
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