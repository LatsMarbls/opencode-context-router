/**
 * Scan cache — persist parsed YAML frontmatter across runs so we don't
 * re-read + re-parse every skill file on every OpenCode startup (or
 * every hot reload).
 *
 * Cache file: ~/.config/opencode/plugins/context-routing/scan-cache.json
 * Keyed by projectDir for multi-project safety.
 *
 * Invalidation:
 *   - File mtime or size changed → re-read that file
 *   - skillLocations template list changed → full rescan
 *   - projectDir changed → full rescan
 *   - Cache version mismatch → full rescan
 *   - Cache file corrupt/missing → full rescan (cache is rebuilt)
 *
 * Atomic writes: write to .tmp, then rename. Avoids partial-write corruption
 * if the process is killed mid-write.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ParsedFrontmatter } from "./scanner.js";

const CACHE_VERSION = 1;

/** Default cache path. Override via setCachePathForTesting() in tests. */
let CACHE_DIR = join(homedir(), ".config", "opencode", "plugins", "context-routing");
let CACHE_FILE = join(CACHE_DIR, "scan-cache.json");

/**
 * Override the cache path (testing seam). Pass null to restore default.
 */
export function setCachePathForTesting(dir: string | null): void {
  if (dir === null) {
    CACHE_DIR = join(homedir(), ".config", "opencode", "plugins", "context-routing");
    CACHE_FILE = join(CACHE_DIR, "scan-cache.json");
  } else {
    CACHE_DIR = dir;
    CACHE_FILE = join(dir, "scan-cache.json");
  }
}

/** One cached skill's parsed frontmatter + the metadata used to invalidate. */
export interface ScanCacheEntry {
  /** Skill name (from frontmatter or filename) */
  name: string;
  /** Absolute path to the skill file */
  filePath: string;
  /** File mtime in ms — used for change detection */
  mtime: number;
  /** File size in bytes — secondary change signal (mtime alone can lie) */
  size: number;
  /** Parsed YAML frontmatter (null if file had no frontmatter) */
  frontmatter: ParsedFrontmatter | null;
}

/** Top-level cache structure, keyed by projectDir for multi-project safety. */
export interface ScanCache {
  version: number;
  /** projectDir → { skillLocations snapshot, entries map } */
  projects: Record<string, {
    skillLocations: string[];
    /** Keyed by skill name */
    entries: Record<string, ScanCacheEntry>;
  }>;
}

/**
 * Load the scan cache. Returns null on any error (missing file, corrupt JSON,
 * version mismatch) — caller should treat null as "no cache" and do a full scan.
 */
export function loadScanCache(): ScanCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as ScanCache;
    if (parsed.version !== CACHE_VERSION) return null;
    if (!parsed.projects || typeof parsed.projects !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save the scan cache atomically (write to .tmp, then rename).
 * Silent on error — cache is a perf optimization, not critical state.
 */
export function saveScanCache(cache: ScanCache): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    const tmpFile = `${CACHE_FILE}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(cache), "utf-8");
    renameSync(tmpFile, CACHE_FILE);
  } catch {
    // best-effort
  }
}

/**
 * Get the cached entry for a project + file path, or undefined if not cached.
 * Caller compares the returned entry's mtime/size against the live file to
 * decide whether to re-read.
 */
export function getCachedEntry(
  cache: ScanCache,
  projectDir: string,
  skillName: string,
): ScanCacheEntry | undefined {
  return cache.projects[projectDir]?.entries[skillName];
}

/**
 * Get the snapshot of skillLocations for a project from the cache.
 * Used to detect when the user has changed their config's skill locations.
 */
export function getCachedLocations(
  cache: ScanCache,
  projectDir: string,
): string[] | undefined {
  return cache.projects[projectDir]?.skillLocations;
}

/**
 * Get file stat (mtime + size) cheaply. Returns null if file doesn't exist.
 */
export function getFileStat(absPath: string): { mtime: number; size: number } | null {
  try {
    const s = statSync(absPath);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Build a fresh cache (or refresh an existing one) for a project.
 * Returns the new cache state.
 */
export function buildCacheForProject(
  existing: ScanCache | null,
  projectDir: string,
  skillLocations: string[],
  entries: Record<string, ScanCacheEntry>,
): ScanCache {
  const cache: ScanCache = existing ?? { version: CACHE_VERSION, projects: {} };
  cache.projects[projectDir] = { skillLocations, entries };
  return cache;
}
