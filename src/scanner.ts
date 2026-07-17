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
import {
  loadScanCache,
  saveScanCache,
  getCachedEntry,
  getCachedLocations,
  getFileStat,
  buildCacheForProject,
  type ScanCacheEntry,
} from "./scanCache.js";

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
 *
 * Uses the scan cache to skip re-reading files whose mtime + size haven't
 * changed since the last scan. Cache is at
 * ~/.config/opencode/plugins/context-routing/scan-cache.json.
 */
export function scanSkillFiles(
  config: PreloaderConfig,
  projectDir: string,
): ScannedSkillIndex {
  const index: ScannedSkillIndex = new Map();
  const seen = new Set<string>(); // track by absPath to avoid dupes

  // Load cache + check if skill locations have changed since last scan.
  // If they have, the cache is meaningless (might be missing new files).
  const cache = loadScanCache();
  const cachedLocations = cache ? getCachedLocations(cache, projectDir) : undefined;
  const locationsUnchanged =
    cachedLocations !== undefined &&
    cachedLocations.length === config.skillLocations.length &&
    cachedLocations.every((loc, i) => loc === config.skillLocations[i]);

  const newCacheEntries: Record<string, ScanCacheEntry> = {};

  for (const tmpl of config.skillLocations) {
    const files = findFilesFromTemplate(tmpl, projectDir);
    for (const { skillName, absPath } of files) {
      if (seen.has(absPath)) continue;
      seen.add(absPath);

      // Cheap stat call — mtime + size
      const stat = getFileStat(absPath);
      if (!stat) continue; // file gone between findFiles and stat

      let frontmatter: ParsedFrontmatter | null = null;
      let fromCache = false;

      // Try cache first (if locations unchanged)
      if (cache && locationsUnchanged) {
        const cached = getCachedEntry(cache, projectDir, skillName);
        if (
          cached &&
          cached.filePath === absPath &&
          cached.mtime === stat.mtime &&
          cached.size === stat.size
        ) {
          // Cache hit — skip read + parse
          frontmatter = cached.frontmatter;
          fromCache = true;
        }
      }

      // Cache miss or stale — actually read the file
      if (!fromCache) {
        const content = readFileSync(absPath, "utf-8");
        const parsed = parseFrontmatter(content);
        frontmatter = parsed.frontmatter;
      }

      // Record the entry for the new cache (only if file has frontmatter)
      if (frontmatter) {
        const entry: ScanCacheEntry = {
          name: frontmatter.name ?? skillName,
          filePath: absPath,
          mtime: stat.mtime,
          size: stat.size,
          frontmatter,
        };
        // Key by the effective name (what it'll be in the index)
        newCacheEntries[frontmatter.name ?? skillName] = entry;
      }

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
        const source = fromCache ? "cache" : "disk";
        console.log(`[context-routing] Scanned skill "${name}" from ${absPath} (${source})`);
      }
    }
  }

  // Save updated cache for this project (preserves other projects' entries)
  const updatedCache = buildCacheForProject(
    cache,
    projectDir,
    config.skillLocations,
    newCacheEntries,
  );
  saveScanCache(updatedCache);

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

  // Support * wildcard: expand to each namespace subdirectory
  const starIdx = resolved.indexOf("*");
  if (starIdx !== -1) {
    const prefix = resolved.slice(0, starIdx);
    const suffix = resolved.slice(starIdx + 1);
    if (!existsSync(prefix)) return [];
    const results: FoundFile[] = [];
    const entries = readdirSync(prefix, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nsTemplate = prefix + entry.name + suffix;
      results.push(...findFilesFromTemplate(nsTemplate, projectDir));
    }
    return results;
  }

  const [beforeName, afterName] = resolved.split("{name}");
  if (!existsSync(beforeName)) return [];

  const results: FoundFile[] = [];

  if (afterName.startsWith("/")) {
    // Directory-based: skills/{name}/SKILL.md (or skills/ns/{name}/SKILL.md via *)
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

// ── Frontmatter parser (js-yaml) ────────────────────────────────────────────

export interface ParsedFrontmatter {
  name?: string;
  triggers?: {
    extensions?: string[];
    paths?: string[];
    agents?: string[];
    keywords?: string[];
  };
  priority?: number;
  always?: boolean;
  groups?: string[];
}

/**
 * Parse YAML frontmatter from a skill file.
 * Handles all valid YAML via js-yaml (lists of maps, nested objects,
 * quoted strings, multi-line, etc.)
 */
export function parseFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter | null;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  // Find closing delimiter on its own line
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return { frontmatter: null, body: content };

  const yamlStr = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 4).trimStart();

  if (!yamlStr) return { frontmatter: null, body };

  try {
    const doc = yaml.load(yamlStr) as Record<string, unknown> | undefined;
    if (!doc || typeof doc !== "object") {
      return { frontmatter: null, body };
    }

    const parsed: ParsedFrontmatter = {};

    if (typeof doc.name === "string") parsed.name = doc.name;
    if (typeof doc.priority === "number") parsed.priority = doc.priority;
    if (typeof doc.always === "boolean") parsed.always = doc.always;

    if (Array.isArray(doc.groups)) {
      parsed.groups = doc.groups.map(String);
    }

    if (doc.triggers && typeof doc.triggers === "object") {
      const t = doc.triggers as Record<string, unknown>;
      const triggers: ParsedFrontmatter["triggers"] = {};
      if (Array.isArray(t.extensions)) triggers.extensions = t.extensions.map(String);
      if (Array.isArray(t.paths)) triggers.paths = t.paths.map(String);
      if (Array.isArray(t.agents)) triggers.agents = t.agents.map(String);
      if (Array.isArray(t.keywords)) triggers.keywords = t.keywords.map(String);
      parsed.triggers = triggers;
    }

    return { frontmatter: Object.keys(parsed).length > 0 ? parsed : null, body };
  } catch {
    // YAML parse failure — treat as no frontmatter
    return { frontmatter: null, body };
  }
}
