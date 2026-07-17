/**
 * Context Routing CLI — visualize skill triggers, config, and live preview.
 *
 * Usage:
 *   context-routing           Show trigger matrix + config overview
 *   context-routing matrix    Same, full trigger matrix
 *   context-routing check <file>   Preview which skills fire for a file
 *   context-routing config    Show effective config
 *   context-routing reload    Signal the running plugin to hot-reload
 *   context-routing help      This message
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config";
import { SkillLoader } from "./loader";
import { scanSkillFiles, type ScannedSkillIndex, type ScannedSkillMeta } from "./scanner";
// ── Resolve config ──────────────────────────────────────────────────────────

const CWD = process.cwd();

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPriority(p: number): string {
  if (p >= 90) return "HIGH";
  if (p >= 50) return "MED";
  return "low";
}

function bar(value: number, max: number, width = 20): string {
  const pct = max > 0 ? value / max : 0;
  const filled = Math.round(pct * width);
  const filledC = "\x1b[33m█\x1b[0m";  // yellow
  const emptyC  = "\x1b[90m░\x1b[0m";  // gray
  return filledC.repeat(filled) + emptyC.repeat(Math.max(0, width - filled));
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdMatrix(config: any, scannedIndex?: ScannedSkillIndex): string {
  const lines: string[] = [];

  lines.push("\n\x1b[1mContext Routing — Trigger Matrix\x1b[0m");
  lines.push("━".repeat(64));

  // Build unified skill list from all trigger maps
  const skillTriggers = new Map<string, {
    exts: string[];
    paths: string[];
    agents: string[];
    keywords: string[];
    always: boolean;
    priority: number;
  }>();

  function addSkill(name: string, props: Partial<{
    ext: string; path: string;
    agent: string; keyword: string;
    always: boolean; prio: number;
  }>) {
    if (!skillTriggers.has(name)) {
      skillTriggers.set(name, {
        exts: [], paths: [],
        agents: [], keywords: [],
        always: false, priority: config.priority?.[name] ?? 5,
      });
    }
    const entry = skillTriggers.get(name)!;
    if (props.ext) entry.exts.push(props.ext);
    if (props.path) entry.paths.push(props.path);
    if (props.agent) entry.agents.push(props.agent);
    if (props.keyword) entry.keywords.push(props.keyword);
    if (props.always) entry.always = true;
    if (props.prio !== undefined) entry.priority = props.prio;
  }

  // 1. fileTypeSkills
  for (const [ext, names] of Object.entries(config.fileTypeSkills ?? {})) {
    for (const n of names as string[]) addSkill(n, { ext });
  }
  // 2. pathPatterns
  for (const [pat, names] of Object.entries(config.pathPatterns ?? {})) {
    for (const n of names as string[]) addSkill(n, { path: pat });
  }
  // 3. agentSkills
  for (const [agent, names] of Object.entries(config.agentSkills ?? {})) {
    for (const n of names as string[]) addSkill(n, { agent });
  }
  // 4. contentTriggers
  for (const [kw, names] of Object.entries(config.contentTriggers ?? {})) {
    for (const n of names as string[]) addSkill(n, { keyword: kw });
  }
  // 5. skillSettings always
  for (const [name, s] of Object.entries(config.skillSettings ?? {})) {
    if ((s as any).always) addSkill(name, { always: true });
  }

  // 6. Scanned skills from frontmatter
  if (scannedIndex) {
    for (const [name, meta] of scannedIndex) {
      const props: any = {};
      if (meta.triggers.extensions?.length) props.ext = meta.triggers.extensions[0];
      if (meta.triggers.paths?.length) props.path = meta.triggers.paths[0];
      if (meta.triggers.agents?.length) props.agent = meta.triggers.agents[0];
      if (meta.triggers.keywords?.length) props.keyword = meta.triggers.keywords[0];
      if (meta.always) props.always = true;
      if (meta.priority) props.prio = meta.priority;
      addSkill(name, props);
    }
  }

  if (skillTriggers.size === 0) {
    lines.push("No skills configured.");
    return lines.join("\n");
  }

  // Sort by priority descending, then name
  const sorted = [...skillTriggers.entries()].sort((a, b) => {
    if (a[1].priority !== b[1].priority) return b[1].priority - a[1].priority;
    return a[0].localeCompare(b[0]);
  });

  // Header
  const hdr = `\x1b[1m${"Skill".padEnd(22)} ${"Ext".padEnd(10)} ${"Agt".padEnd(6)} ${"Kw".padEnd(4)} ${"Prio".padEnd(5)} Trigger\x1b[0m`;
  lines.push(hdr);
  lines.push("─".repeat(64));

  for (const [name, t] of sorted) {
    const skillN = name.padEnd(22);
    const ext   = (t.exts.length > 0 ? t.exts.join(",") : "—").slice(0, 9).padEnd(10);
    const agt   = (t.agents.length > 0 ? t.agents.join(",") : "—").slice(0, 5).padEnd(6);
    const kw    = t.keywords.length > 0 ? "\x1b[33m✓\x1b[0m".padEnd(4) : "—".padEnd(4);
    const prio  = `${t.priority}`.padEnd(5);
    const trigger = [
      t.exts.length > 0 ? "ext" : null,
      t.paths.length > 0 ? "path" : null,
      t.agents.length > 0 ? "agent" : null,
      t.keywords.length > 0 ? "keyword" : null,
      t.always ? "always" : null,
    ].filter(Boolean).join("+") || "config";
    lines.push(`${skillN} ${ext} ${agt} ${kw} ${prio} \x1b[90m${trigger}\x1b[0m`);
  }

  // ── Per-extension summary ─────────────────────────────────────────
  if (Object.keys(config.fileTypeSkills ?? {}).length > 0) {
    lines.push("");
    lines.push("\x1b[1mPer Extension\x1b[0m");
    lines.push("─".repeat(64));
    for (const [ext, names] of [...Object.entries(config.fileTypeSkills as Record<string, string[]>)].sort()) {
      lines.push(`  \x1b[33m${ext}\x1b[0m → ${names.join(", ")}`);
    }
  }

  // ── Priority histogram ────────────────────────────────────────────
  const prioCounts: Record<string, number> = { HIGH: 0, MED: 0, low: 0 };
  for (const [, t] of sorted) {
    prioCounts[formatPriority(t.priority)]++;
  }
  lines.push("");
  lines.push(`\x1b[1m${sorted.length}\x1b[0m skills total  ·  ` +
    `\x1b[33m${prioCounts.HIGH} HIGH\x1b[0m  ` +
    `${prioCounts.MED} MED  ` +
    `\x1b[90m${prioCounts.low} low\x1b[0m`);

  // ── Token budget ──────────────────────────────────────────────────
  const maxTok = config.maxTokens ?? 12000;
  // Very rough: assume ~500 chars per always-on skill
  const alwaysSkills = sorted.filter(([, t]) => t.always).length;
  const estTok = Math.ceil((alwaysSkills * 500) / 4);
  lines.push(`Token budget: ${bar(estTok, maxTok)} ~${estTok} / ${maxTok} tok (always-on base)`);

  return lines.join("\n");
}

function cmdCheck(filePath: string, config: any, scannedIndex?: ScannedSkillIndex): string {
  const lines: string[] = [];
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const fileName = filePath.split(/[\\/]/).pop() ?? "";

  // Honor triggerIgnoreTags the same way the runtime does.
  // Matches on path SEGMENTS only (not substrings) — "dist" doesn't match
  // "src/distribution/Foo.php" but DOES match "dist/Foo.js".
  const ignoreTags = (config as any).triggerIgnoreTags ?? [];
  const segments = filePath.replace(/\\/g, "/").toLowerCase().split("/");
  const ignored = ignoreTags.some((tag: string) => segments.includes(tag.toLowerCase()));

  lines.push(`\n\x1b[1mChecking: ${filePath}\x1b[0m`);
  lines.push(`  extension: \x1b[33m.${ext}\x1b[0m`);
  if (ignored) {
    lines.push(`  \x1b[33m⚠\x1b[0m  Path is in triggerIgnoreTags — runtime would skip this file.`);
  }
  lines.push("");

  const matched: string[] = [];
  const reasons: string[] = [];

  // 1. fileTypeSkills
  for (const [fe, names] of Object.entries((config as any).fileTypeSkills ?? {})) {
    if (fe === `.${ext}` || fe === ext) {
      for (const n of names as string[]) {
        if (ignored) continue;
        matched.push(n);
        reasons.push(`extension .${ext}`);
      }
    }
  }

  // 2. pathPatterns
  for (const [pat, names] of Object.entries((config as any).pathPatterns ?? {})) {
    const re = new RegExp(
      "^" + (pat as string).replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
    );
    if (re.test(filePath) || re.test(fileName)) {
      for (const n of names as string[]) {
        if (ignored) continue;
        matched.push(n);
        reasons.push(`path ${pat}`);
      }
    }
  }

  // 3. Scanned skills from frontmatter (extensions only)
  if (scannedIndex) {
    for (const [name, meta] of scannedIndex) {
      if (meta.triggers.extensions?.includes(`.${ext}`) || meta.triggers.extensions?.includes(ext)) {
        if (ignored) continue;
        matched.push(name);
        reasons.push(`scanned extension .${ext}`);
      }
    }
  }

  if (matched.length === 0) {
    lines.push("No skills trigger for this file.");
  } else {
    lines.push("\x1b[1mTriggered skills:\x1b[0m");
    for (let i = 0; i < matched.length; i++) {
      lines.push(`  \x1b[32m✓\x1b[0m ${matched[i]}  (${reasons[i]})`);
    }
  }

  return lines.join("\n");
}

function cmdConfig(config: any): string {
  const lines: string[] = [];
  lines.push("\n\x1b[1mConfig Overview\x1b[0m");
  lines.push("━".repeat(48));
  lines.push(`  Token budget:     ${config.maxTokens ?? 12000}`);
  lines.push(`  Show toasts:      ${config.showToasts ?? true}`);
  lines.push(`  Persist compact:  ${config.persistAfterCompaction ?? true}`);
  lines.push(`  Skills defined:   ${(config.skills ?? []).length}`);
  lines.push(`  File type maps:   ${Object.keys(config.fileTypeSkills ?? {}).length}`);
  lines.push(`  Path patterns:    ${Object.keys(config.pathPatterns ?? {}).length}`);
  lines.push(`  Agent maps:       ${Object.keys(config.agentSkills ?? {}).length}`);
  lines.push(`  Keyword triggers: ${Object.keys(config.contentTriggers ?? {}).length}`);

  if (config.skillLocations && config.skillLocations.length > 0) {
    lines.push("");
    lines.push("  Skill locations:");
    for (const loc of config.skillLocations) {
      lines.push(`    • ${loc}`);
    }
  }

  return lines.join("\n");
}

function cmdCache(config: any): string {
  const loader = new SkillLoader(config, CWD, config.cacheFileTTL);
  // Load all known skills to populate cache
  const allSkills = new Set<string>();
  for (const names of Object.values(config.fileTypeSkills ?? {})) (names as string[]).forEach(n => allSkills.add(n));
  for (const names of Object.values(config.pathPatterns ?? {})) (names as string[]).forEach(n => allSkills.add(n));
  for (const names of Object.values(config.agentSkills ?? {})) (names as string[]).forEach(n => allSkills.add(n));
  for (const names of Object.values(config.contentTriggers ?? {})) (names as string[]).forEach(n => allSkills.add(n));
  (config.skills ?? []).forEach((n: string) => allSkills.add(n));

  for (const name of allSkills) {
    loader.loadStaticSkill(name);
  }

  const stats = loader.getCacheStats();
  const lines: string[] = [];
  lines.push("\n\x1b[1mSkill File Cache\x1b[0m");
  lines.push("━".repeat(48));
  lines.push(`  Cached files:  ${stats.size}`);
  lines.push(`  Hit rate:      ${(stats.hitRate * 100).toFixed(1)}%`);
  if (stats.entries.length > 0) {
    lines.push("");
    lines.push("  Entries:");
    for (const entry of stats.entries) {
      lines.push(`    • ${entry}`);
    }
  }
  return lines.join("\n");
}

function cmdReload(): void {
  const signalDir = join(homedir(), ".config", "opencode", "plugins", "context-routing");
  const signalFile = join(signalDir, ".reload-signal");
  try {
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(signalFile, new Date().toISOString(), "utf-8");
    console.log("\x1b[32m✓\x1b[0m Reload signal sent.");
    console.log(`  Signal file: ${signalFile}`);
    console.log("  The running plugin will pick this up on the next turn and reload config + skills.");
    console.log("  (If no turn happens soon, just send any message to OpenCode.)");
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Failed to write reload signal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function cmdHelp(): string {
  return `
\x1b[1mcontext-routing\x1b[0m — OpenCode skill trigger visualizer

\x1b[1mUsage:\x1b[0m
  context-routing           Show trigger matrix + overview
  context-routing matrix    Full trigger matrix
  context-routing check <file>  Preview which skills fire for a file
  context-routing config    Show effective config values
  context-routing cache     Show skill file cache stats
  context-routing reload    Signal the running plugin to hot-reload
                            (config + global skills). Use after editing
                            files in ~/.config/opencode/.
  context-routing help      This message
`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "matrix";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(cmdHelp());
    return;
  }

  const config = loadConfig(CWD);
  const scannedIndex = config.scannerEnabled ? scanSkillFiles(config, CWD) : new Map();

  switch (command) {
    case "matrix":
      console.log(cmdMatrix(config, scannedIndex));
      break;
    case "check":
      if (!args[1]) {
        console.error("\x1b[31mError:\x1b[0m Usage: context-routing check <file>");
        process.exit(1);
      }
      console.log(cmdCheck(args[1], config, scannedIndex));
      break;
    case "config":
      console.log(cmdConfig(config));
      break;
    case "cache":
      console.log(cmdCache(config));
      break;
    case "reload":
      cmdReload();
      break;
    default:
      console.log(cmdMatrix(config, scannedIndex));
      break;
  }
}

main();
