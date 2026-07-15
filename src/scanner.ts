/**
 * Scanner — reads skill files from disk, parses YAML frontmatter,
 * and builds a searchable trigger index so skill files can declare
 * their own triggers without needing entries in context-router.jsonc.
 *
 * Two file layouts supported:
 *   dir-based:  skills/{name}/SKILL.md
 *   file-based: agent/{name}.md
 *
 * Frontmatter is YAML between --- markers:
 *   ---
 *   triggers:
 *     extensions: [.php]
 *     paths: [src/Controllers/**]
 *     agents: [coder-lite]
 *     keywords: [controller]
 *   priority: 9
 *   always: false
 *   groups: [backend-only]
 *   ---
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";
import type { PreloaderConfig } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScannedSkillTriggers {
  extensions?: string[];
  paths?: string[];
  agents?: string[];
  keywords?: string[];
}

export interface ScannedSkillMeta {
  /** Skill name (from frontmatter or derived from filename) */
  name: string;
  /** Absolute path to the skill file on disk */
  filePath: string;
  /** Trigger declarations from frontmatter */
  triggers: ScannedSkillTriggers;
  /** Priority override (defaults to config lookup or 5) */
  priority?: number;
  /** Always-on override */
  always?: boolean;
  /** Groups this skill belongs to */
  groups?: string[];
}

/**
 * Full index of all discovered skills, keyed by name.
 */
export type ScannedSkillIndex = Map<string, ScannedSkillMeta>;

// ── Main scanner ────────────────────────────────────────────────────────────

/**
 * Walk all configured skill locations and build a trigger index
 * from any files that have YAML frontmatter.
 */
export function scanSkillFiles(
  config: PreloaderConfig,
  projectDir: string,
): ScannedSkillIndex {
  const index: ScannedSkillIndex = new Map();
  const seen = new Set<string>(); // track by absPath to avoid dupes

  for (const tmpl of config.skillLocations) {
    const files = findFilesFromTemplate(tmpl, projectDir);
    for (const { skillName, absPath } of files) {
      if (seen.has(absPath)) continue;
      seen.add(absPath);

      const content = readFileSync(absPath, "utf-8");
      const { frontmatter } = parseFrontmatter(content);
      if (!frontmatter) continue; // no frontmatter → not self-declaring

      const name = frontmatter.name ?? skillName;

      // Only register if not already seen (first location wins)
      if (index.has(name)) continue;

      index.set(name, {
        name,
        filePath: absPath,
        triggers: frontmatter.triggers ?? {},
        priority: frontmatter.priority,
        always: frontmatter.always,
        groups: frontmatter.groups,
      });

      if (config.debug) {
        console.log(`[context-routing] Scanned skill "${name}" from ${absPath}`);
      }
    }
  }

  return index;
}

// ── File discovery ──────────────────────────────────────────────────────────

interface FoundFile {
  skillName: string;
  absPath: string;
}

function findFilesFromTemplate(
  template: string,
  projectDir: string,
): FoundFile[] {
  // Resolve {project} and {user} placeholders
  const userDir = resolve(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".config",
    "opencode",
  );
  let resolved = template
    .replace(/\{project\}/g, projectDir)
    .replace(/\{user\}/g, userDir);

  if (!resolved.includes("{name}")) return [];

  const [beforeName, afterName] = resolved.split("{name}");
  if (!existsSync(beforeName)) return [];

  const results: FoundFile[] = [];

  if (afterName.startsWith("/") || afterName.startsWith("\\")) {
    // Directory-based: skills/{name}/SKILL.md
    // afterName = /SKILL.md → the file inside each dir
    const innerFile = afterName.slice(1);
    const entries = readdirSync(beforeName, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(beforeName, entry.name, innerFile);
      if (existsSync(skillFile)) {
        results.push({ skillName: entry.name, absPath: skillFile });
      }
    }
  } else if (afterName.startsWith(".")) {
    // File-based: agent/{name}.md
    const ext = afterName;
    const entries = readdirSync(beforeName, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(ext)) continue;
      const skillName = entry.name.slice(0, -ext.length);
      results.push({ skillName, absPath: join(beforeName, entry.name) });
    }
  }

  return results;
}

// ── Frontmatter parser (js-yaml) ───────────────────────────────────────────────

interface ParsedFrontmatter {
  name?: string;
  triggers?: ScannedSkillTriggers;
  priority?: number;
  always?: boolean;
  groups?: string[];
}

function parseFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter | null;
  body: string;
} {
  // Must start with opening delimiter
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  // Find closing delimiter
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return { frontmatter: null, body: content };

  const rawYaml = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 4).trimStart();

  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(rawYaml) as Record<string, unknown>;
  } catch {
    return { frontmatter: null, body };
  }
  if (!parsed || typeof parsed !== "object") {
    return { frontmatter: null, body };
  }

  const frontmatter: ParsedFrontmatter = {};

  if (typeof parsed.name === "string") {
    frontmatter.name = parsed.name;
  }

  if (parsed.triggers && typeof parsed.triggers === "object") {
    const t = parsed.triggers as Record<string, unknown>;
    frontmatter.triggers = {};
    for (const key of ["extensions", "paths", "agents", "keywords"] as const) {
      const val = t[key];
      if (Array.isArray(val)) {
        frontmatter.triggers[key] = val.map(String);
      }
    }
    if (Object.keys(frontmatter.triggers).length === 0) {
      delete frontmatter.triggers;
    }
  }

  if (typeof parsed.priority === "number") {
    frontmatter.priority = parsed.priority;
  }

  if (typeof parsed.always === "boolean") {
    frontmatter.always = parsed.always;
  }

  if (Array.isArray(parsed.groups)) {
    frontmatter.groups = parsed.groups.map(String);
  }

  return { frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null, body };
}
