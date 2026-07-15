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

  if (afterName.startsWith("/")) {
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

// ── Frontmatter parser (no YAML dep) ────────────────────────────────────────

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

  const yaml = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 4).trimStart();

  const parsed: ParsedFrontmatter = {};
  let currentKey: string | null = null;

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trimEnd();

    // Nested key (2-space indent under triggers)
    const nestedMatch = line.match(/^ {2}(\w[\w-]*):\s*(.*)$/);
    if (nestedMatch && currentKey === "triggers") {
      const key = nestedMatch[1] as keyof ScannedSkillTriggers;
      const val = nestedMatch[2].trim();
      if (!parsed.triggers) parsed.triggers = {};
      if (["extensions", "paths", "agents", "keywords"].includes(key)) {
        parsed.triggers[key] = parseArrayValue(val);
      }
      continue;
    }

    // Top-level key
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!topMatch) continue;

    currentKey = topMatch[1];
    const val = topMatch[2].trim();

    switch (currentKey) {
      case "name":
        parsed.name = val;
        break;
      case "triggers":
        // Next indented lines are children
        break;
      case "priority":
        parsed.priority = parseInt(val, 10);
        break;
      case "always":
        parsed.always = val === "true";
        break;
      case "groups":
        parsed.groups = parseArrayValue(val);
        break;
    }
  }

  return { frontmatter: Object.keys(parsed).length > 0 ? parsed : null, body };
}

function parseArrayValue(val: string): string[] {
  if (!val) return [];
  // Handle: [item1, item2] or "item1"
  if (val.startsWith("[") && val.endsWith("]")) {
    return val
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [val.replace(/^["']|["']$/g, "")];
}
