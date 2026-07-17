import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PreloaderConfig } from "./config.js";
import { resolveSkillPath } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LoadedSkill {
  /** Skill identifier (used for dedup + priority) */
  name: string;
  /** Raw skill content as markdown */
  content: string;
  /** How this skill was loaded */
  source: "static-file";
  /** Priority weight (higher = survives budget cuts) */
  priority: number;
}

// ── Skill Loader ────────────────────────────────────────────────────────────

interface CacheEntry {
  content: string;
  loadedAt: number;
}

export class SkillLoader {
  private fileCache = new Map<string, CacheEntry>();
  private readonly cacheTTL: number;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private config: PreloaderConfig,
    private projectDir: string,
    cacheTTL: number = 60_000, // 1 min default
  ) {
    this.cacheTTL = cacheTTL;
  }

  /**
   * Load a single skill by name. Tries all locations in order.
   * Returns the first hit.
   */
  loadStaticSkill(name: string): LoadedSkill | null {
    const priority = this.config.priority[name]
      ?? this.config.skillSettings[name]?.priority
      ?? 5;

    // Try each location template
    for (const tmpl of this.config.skillLocations) {
      // ── Wildcard expansion ────────────────────────────────────────────────
      // Templates with * (e.g. {user}/skills/*/{name}/SKILL.md) need directory
      // scan to find matching subdirectories.
      if (tmpl.includes("*")) {
        const [before, after] = tmpl.split("*");
        const parentTmpl = before;            // e.g. {user}/skills/
        const childTmpl  = after;             // e.g. /{name}/SKILL.md
        // Resolve {project}/{user}/{name} in parent path, then scan subdirs
        const parentDir = resolveSkillPath(parentTmpl, this.projectDir, name);
        let subDirs: string[];
        try {
          subDirs = readdirSync(parentDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        } catch {
          continue; // parent doesn't exist, skip this template
        }
        for (const sub of subDirs) {
          const absPath = join(parentDir, sub, childTmpl.replace(/\{name\}/g, name));
          if (!existsSync(absPath)) continue;
          const content = this.readFile(absPath);
          if (!content) continue;
          if (this.config.debug) {
            console.log(`[context-routing] Loaded skill "${name}" from ${absPath}`);
          }
          return { name, content, source: "static-file", priority };
        }
        continue;
      }

      // ── Direct path ───────────────────────────────────────────────────────
      const absPath = resolveSkillPath(tmpl, this.projectDir, name);
      if (!existsSync(absPath)) continue;
      const content = this.readFile(absPath);
      if (!content) continue;
      if (this.config.debug) {
        console.log(`[context-routing] Loaded skill "${name}" from ${absPath}`);
      }
      return { name, content, source: "static-file", priority };
    }

    return null;
  }

  /**
   * Resolve a named group into its constituent skill names.
   */
  resolveGroup(name: string): string[] {
    return this.config.groups[name] ?? [];
  }

  /**
   * Get all skills that have always:true in their settings.
   */
  getAlwaysOnSkills(): string[] {
    return Object.entries(this.config.skillSettings)
      .filter(([_, s]) => s.always)
      .map(([name]) => name);
  }

  /**
   * Get cache statistics for debugging/inspection.
   */
  getCacheStats(): { size: number; hitRate: number; entries: string[] } {
    return {
      size: this.fileCache.size,
      hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses) || 0,
      entries: Array.from(this.fileCache.keys()),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private readFile(absPath: string): string | null {
    const cached = this.fileCache.get(absPath);
    const now = Date.now();
    if (cached && (now - cached.loadedAt) < this.cacheTTL) {
      this.cacheHits++;
      return cached.content;
    }
    this.cacheMisses++;
    // Stale or missing — re-read from disk
    try {
      const content = readFileSync(absPath, "utf-8");
      this.fileCache.set(absPath, { content, loadedAt: now });
      return content;
    } catch {
      return null;
    }
  }
}
