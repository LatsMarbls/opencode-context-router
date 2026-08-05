import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SkillSettings {
  /** Override token budget weight for this skill (higher = survives budget cuts) */
  priority?: number;
  /** Use LLM-generated summary instead of raw content */
  useSummary?: boolean;
  /** Always load this skill regardless of triggers */
  always?: boolean;
  /** Override global TTL for this skill (ms, 0 = no TTL, never evict) */
  skillTTL?: number;
}

export interface PreloaderConfig {
  /** Skills always loaded for every session */
  skills: string[];

  /** Skills triggered by file extension */
  fileTypeSkills: Record<string, string[]>;

  /** Skills triggered by agent name (e.g. "coder-lite" → php conventions) */
  agentSkills: Record<string, string[]>;

  /** Skills triggered by glob path patterns */
  pathPatterns: Record<string, string[]>;

  /** Skills triggered by keyword/pattern in user messages */
  contentTriggers: Record<string, string[]>;

  /** Per-skill overrides */
  skillSettings: Record<string, SkillSettings>;

  /** Where to look for static skill files (order = priority).
   *  Supports {project} and {user} placeholders. */
  skillLocations: string[];

  /** Enable automatic scanning of skill files for frontmatter-declared triggers.
   *  When true, skill files with YAML frontmatter register their own triggers
   *  without needing entries in the config trigger maps. */
  scannerEnabled: boolean;

  /** File extensions to skip trigger detection on (e.g. "node_modules") */
  triggerIgnoreTags: string[];

  /** Where to inject skill content */
  injectionMethod: "systemPrompt" | "chatMessage";

  /** Approximate max tokens skills can consume (oldest/lowest priority dropped) */
  maxTokens?: number;

  /** Whether to use LLM-generated skill summaries (reduces token use) */
  useSummaries: boolean;

  /** Strip comments/whitespace from skill markdown */
  useMinification: boolean | "standard" | "aggressive";

  /** Show TUI toasts on skill load/unload */
  showToasts: boolean;

  /** Expose a custom `/skills` tool to list active skills */
  enableTools: boolean;

  /** Opt-in anonymous usage analytics */
  analytics: boolean;

  /** Keep skills across compaction boundaries */
  persistAfterCompaction: boolean;

  /** Accumulate skills across turns (true) or evaluate fresh each turn (false).
   *  When false, only skills triggered by the current message/agent/file are injected. */
  accumulateSkills: boolean;

  /** Enable verbose logging */
  debug: boolean;

  /** Global priority map (skillName → weight). Higher = survives budget cuts. */
  priority: Record<string, number>;

  /** Default TTL for loaded skills (ms). Skills evicted after this time.
   *  WARNING: 0 means "never evict" (skills live for session lifetime),
   *  NOT "instant expiry". If you want skills to drop after each turn,
   *  set accumulateSkills: false instead. Default 600000 (10 min). */
  skillTTL: number;

  /** File cache TTL (ms). How long a skill file read is cached before
   *  re-reading from disk. Default 60000 (1 min). */
  cacheFileTTL: number;

  /** File trigger precedence for the PRIMARY agent when a referenced file
   *  matches BOTH an extension trigger and a path pattern.
   *  "path"      — the folder-path match wins over .ext (default)
   *  "extension" — the .ext trigger wins over the folder-path match */
  precedencePrimary: "path" | "extension";

  /** Same as precedencePrimary, but for SUBAGENTS. Lets subagents route
   *  by extension even when the primary agent prefers path-wins. */
  precedenceSubagent: "path" | "extension";
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: PreloaderConfig = {
  skills: [],
  fileTypeSkills: {},
  agentSkills: {},
  pathPatterns: {},
  contentTriggers: {},
  skillSettings: {},
  skillLocations: [
    // Check project-local first, then user-global
    "{project}/.opencode/skills/{name}/SKILL.md",
    "{project}/.opencode/agent/{name}.md",
    "{user}/.config/opencode/skills/{name}/SKILL.md",
    "{user}/.config/opencode/agent/{name}.md",
  ],
  triggerIgnoreTags: [
    "node_modules",
    ".git",
    "vendor",
    "dist",
    ".next",
    "build",
  ],
  injectionMethod: "systemPrompt",
  maxTokens: 8_000,
  useSummaries: false,
  useMinification: false,
  showToasts: true,
  enableTools: true,
  analytics: false,
  persistAfterCompaction: true,
  accumulateSkills: true,
  scannerEnabled: true,
  debug: false,
  priority: {},
  skillTTL: 600_000,
  cacheFileTTL: 60_000,
  precedencePrimary: "path",
  precedenceSubagent: "path",
};

// ── Config resolution ──────────────────────────────────────────────────────

const USER_CONFIG_DIR = join(homedir(), ".config", "opencode");
const PROJECT_CONFIG_FILES = [".opencode/context-router.jsonc", ".opencode/context-router.json"];
const USER_CONFIG_FILES = [
  join(USER_CONFIG_DIR, "context-router.jsonc"),
  join(USER_CONFIG_DIR, "context-router.json"),
  join(USER_CONFIG_DIR, "plugins", "context-routing", "context-router.jsonc"),
  join(USER_CONFIG_DIR, "plugins", "context-routing", "context-router.json"),
];

/**
 * Resolve config by merging project-level over user-level over defaults.
 * Project-level values override user-level; user-level overrides defaults.
 */
export function loadConfig(projectDir: string): PreloaderConfig {
  const cfg = { ...DEFAULT_CONFIG, skillLocations: [...DEFAULT_CONFIG.skillLocations] };

  // 1. User-global config
  for (const fp of USER_CONFIG_FILES) {
    tryMergeFile(cfg, fp);
  }

  // 2. Project-local config
  for (const fp of PROJECT_CONFIG_FILES) {
    tryMergeFile(cfg, join(projectDir, fp));
  }

  return cfg;
}

function tryMergeFile(cfg: PreloaderConfig, absPath: string): void {
  if (!existsSync(absPath)) return;
  try {
    const raw = readFileSync(absPath, "utf-8");
    const parsed = JSON.parse(stripJsoncComments(raw));
    deepMerge(cfg, parsed);
    if (cfg.debug) console.log(`[context-routing] Loaded config: ${absPath}`);
  } catch (err) {
    console.error(`[context-routing] Failed to load config ${absPath}:`, err);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function stripJsoncComments(jsonc: string): string {
  return jsonc
    .replace(/\/\/.*$/gm, "")       // strip // comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip /* */ comments
    .trim();
}

function deepMerge(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    if (Array.isArray(source[key])) {
      // Arrays override, not concat — user config replaces defaults
      target[key] = [...source[key]];
    } else if (isPlainObject(source[key]) && isPlainObject(target[key])) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve a skill location template to an actual path.
 * Placeholders: {project}, {user}, {name}
 */
export function resolveSkillPath(
  template: string,
  projectDir: string,
  skillName: string,
): string {
  return template
    .replace(/\{project\}/g, projectDir)
    .replace(/\{user\}/g, USER_CONFIG_DIR)
    .replace(/\{name\}/g, skillName);
}
