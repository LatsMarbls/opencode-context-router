import { readFileSync, existsSync } from "node:fs";
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

  // ── Private ──────────────────────────────────────────────────────────────

  private readFile(absPath: string): string | null {
    const cached = this.fileCache.get(absPath);
    const now = Date.now();
    if (cached && (now - cached.loadedAt) < this.cacheTTL) {
      return cached.content;
    }
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
