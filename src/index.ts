/**
 * Plugin entry point — hooks registration for OpenCode.
 *
 * Architecture:
 *   chat.message                  → session init + reset turn flag
 *   experimental.chat.messages.transform → resolve triggers → load → queue
 *                                          → inject as system message (FALLBACK)
 *   experimental.chat.system.transform    → flush queue → inject into
 *                                          system prompt (PREFERRED)
 *   experimental.session.compacting      → persist skill list across compaction
 *   event                               → cleanup on session deleted
 *
 * Hook order detection:
 *   OpenCode's hook invocation order for messages.transform vs system.transform
 *   is undocumented. Instead of guessing, we detect which fires FIRST each turn
 *   via an `injectedThisTurn` flag. Whichever fires first injects skills.
 *   The other hook skips (avoids duplication).
 *
 *   When system.transform fires first → skills inject into system prompt (ideal)
 *   When messages.transform fires first → skills inject as system message (fallback)
 *   Either way: same-turn visibility ✓
 */
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { loadConfig } from "./config.js";
import { SkillLoader, type LoadedSkill } from "./loader.js";
import { Resolver } from "./resolver.js";
import { scanSkillFiles, type ScannedSkillIndex } from "./scanner.js";
import { getOrCreateSession, deleteSession } from "./session.js";
import { trackSessionEvent } from "./analytics.js";
import { appendFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadScanCache } from "./scanCache.js";

// ── File Logger ─────────────────────────────────────────────────────────────
// Writes diagnostics to ~/.config/opencode/plugins/context-routing/debug.log
// so user can share without terminal access.
const LOG_FILE = join(homedir(), ".config", "opencode", "plugins", "context-routing", "debug.log");

// ── Reload Signal ───────────────────────────────────────────────────────────
// Global config + skill files live in ~/.config/opencode/, which is OUTSIDE
// the active workspace. OpenCode's file watcher won't fire for them.
// To support hot reload of global files: a `npx context-routing reload`
// CLI command touches this file. The plugin checks for it on each turn
// and reloads if present, then deletes it.
const RELOAD_SIGNAL = join(homedir(), ".config", "opencode", "plugins", "context-routing", ".reload-signal");

function log(...args: unknown[]) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // silently fail if file can't be written
  }
}

// ── Turn-scoped state ──────────────────────────────────────────────────────

/**
 * Tracks which hook injected skills this turn.
 * Reset to `null` at the start of each turn (chat.message).
 * Whichever hook fires first sets this; the other skips.
 */
let injectedThisTurn: "messages" | "system" | null = null;

// ── Plugin Definition ───────────────────────────────────────────────────────

const plugin: Plugin = async ({ client, project, directory }: PluginInput) => {
  const projectDir = directory;

  // 1. Load configuration (project + user + defaults)
  //    Reassignable for hot reload (via reload signal or file watcher event).
  let config = loadConfig(projectDir);

  // 2. Scan skill files for self-declared triggers
  let scannedIndex: ScannedSkillIndex = new Map();
  if (config.scannerEnabled) {
    scannedIndex = scanSkillFiles(config, projectDir);
    if (config.debug && scannedIndex.size > 0) {
      console.log(`[context-routing] Scanned ${scannedIndex.size} skill files with frontmatter triggers`);
    }
  }

  // 3. Create core services
  const loader = new SkillLoader(config, projectDir, config.cacheFileTTL);
  let resolver = new Resolver(config, scannedIndex);

  log(`[cr-debug] Plugin init START. projectDir=${projectDir}`);
  log(`[cr-debug]   config: skills=${JSON.stringify(config.skills)}, fileTypeSkills=${JSON.stringify(Object.keys(config.fileTypeSkills))}`);
  log(`[cr-debug]   contentTriggers=${JSON.stringify(Object.keys(config.contentTriggers))}`);
  log(`[cr-debug]   agentSkills=${JSON.stringify(Object.keys(config.agentSkills))}`);
  log(`[cr-debug]   scannerEnabled=${config.scannerEnabled}, debug=${config.debug}`);

  // ── Hot reload helper ─────────────────────────────────────────────
  // Re-reads config, re-scans skills, invalidates loader cache, rebuilds resolver.
  // Existing sessions keep their loaded skills; new config applies to new sessions
  // and to trigger resolution in the current turn.
  function performReload(reason: string): void {
    log(`[cr-debug] performReload: ${reason}`);
    config = loadConfig(projectDir);
    if (config.scannerEnabled) {
      scannedIndex = scanSkillFiles(config, projectDir);
    } else {
      scannedIndex = new Map();
    }
    loader.invalidateAll();
    resolver = new Resolver(config, scannedIndex);
    if (config.debug) {
      console.log(`[context-routing] Reloaded (${reason}). Scanned ${scannedIndex.size} skills.`);
    }
  }

  if (config.debug) {
    console.log(`[context-routing] Initialized (project: ${projectDir})`);
  }

  // 4. Build hooks object
  const hooks: Hooks = {
    // ── Chat message — session init + trigger resolution + (chatMessage) inject ──
    // Resolution lives here (not in messages.transform) so it always runs before
    // any transform hook fires. Decouples from the undocumented hook ordering of
    // messages.transform vs system.transform.

    "chat.message": async (input, output) => {
      log(`[cr-debug] chat.message fired. sessionID=${input.sessionID}`);
      injectedThisTurn = null;

      // Check for global reload signal (set by `npx context-routing reload`).
      // Project-local files reload automatically via file.watcher.updated below.
      if (existsSync(RELOAD_SIGNAL)) {
        try { unlinkSync(RELOAD_SIGNAL); } catch { /* race with another turn — fine */ }
        performReload("global reload signal");
      }

      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);
      if (!config.accumulateSkills) {
        mgr.clear();
        mgr.clearInjectionCache();
      }

      // Track session creation (first time only)
      if (config.analytics && mgr.getActiveSkills().length === 0) {
        trackSessionEvent("session.created", input.sessionID);
      }

      // ── Resolve triggers (moved here from messages.transform) ───────
      // Two buckets:
      //   expandable  — triggers that SHOULD expand groups (file/agent/group-name)
      //   keywordOnly — keyword-matched skills that load solo, no group expansion
      const messageText = extractTextFromParts(output.parts);
      const agentName = input.agent;
      const expandable = new Set<string>();
      const keywordOnly = new Set<string>();

      if (agentName) {
        resolver.resolveAgentTriggers(agentName).forEach((n) => expandable.add(n));
      }

      if (messageText) {
        // Group name keywords → expandable (loads all member skills)
        resolver.resolveGroupNameTriggers(messageText).forEach((n) => expandable.add(n));

        // Individual skill keywords → keywordOnly (NO group expansion)
        resolver.resolveMessageTriggers(messageText).forEach((n) => keywordOnly.add(n));

        for (const p of extractPaths(messageText)) {
          resolver.resolveFileTriggers(p).forEach((n) => expandable.add(n));
        }
      }

      config.skills.forEach((n) => expandable.add(n));
      resolver.getAlwaysOnSkills().forEach((n) => expandable.add(n));

      // Expand groups only from expandable set
      resolver.expandGroups(Array.from(expandable)).forEach((n) => expandable.add(n));

      // Merge: expandable + keyword-only (keyword-only don't get group expansion)
      const skillNames = new Set([...expandable, ...keywordOnly]);

      log(`[cr-debug]   resolved skill names: ${JSON.stringify(Array.from(skillNames))}`);

      // ── Load new skills ───────────────────────────────────────────
      if (skillNames.size > 0) {
        const toLoad = Array.from(skillNames).filter((n) => !mgr.hasSkill(n));
        if (toLoad.length > 0) {
          const loaded: LoadedSkill[] = [];
          let loadFailures = 0;
          for (const name of toLoad) {
            try {
              const skill = loader.loadStaticSkill(name);
              if (skill) loaded.push(skill);
            } catch (err) {
              log(`[cr-debug]   ERROR loading "${name}": ${err instanceof Error ? err.message : String(err)}`);
              loadFailures++;
            }
          }
          if (loadFailures > 0) {
            log(`[cr-debug]   ${loadFailures} skill(s) failed to load`);
          }
          if (loaded.length > 0) {
            // Dedup against active skills' content (avoid queueing same content twice)
            const existingContent = new Set(
              mgr.getActiveSkills().map(s => s.content.trim()),
            );
            const deduped = loaded.filter(s => !existingContent.has(s.content.trim()));
            if (deduped.length < loaded.length) {
              log(`[cr-debug]   dedup: ${loaded.length - deduped.length} skills already active`);
            }
            if (deduped.length > 0) {
              mgr.queueSkills(deduped, "content.match");
              if (config.showToasts) {
                client.tui.showToast({
                  body: {
                    message: `Context routed: ${deduped.map((s) => s.name).join(", ")}`,
                    variant: "info",
                    duration: 3_000,
                  },
                });
              }
            }
          }
        }
      }

      mgr.flushPending();
      log(`[cr-debug]   active skills after flush: ${mgr.getActiveSkills().length}`);

      // ── chatMessage injection mode (fallback path) ─────────────────
      if (config.injectionMethod === "chatMessage") {
        const newSkills = mgr.filterNewForInjection();
        if (newSkills.length > 0) {
          const injectedNames = newSkills.map(s => s.name).join(", ");
          const formatted = newSkills.map(s =>
            `<context-route name="${s.name}">\n${s.content.trim()}\n</context-route>`
          ).join("\n\n");
          const note = `<context-routes-loaded>\nThe following skills are already loaded: ${injectedNames}\nDo NOT use the skill tool to load them again.\n</context-routes-loaded>`;
          output.parts.push({ type: "text", text: `\n${note}\n${formatted}\n` } as Part);
          injectedThisTurn = "messages";
          log(`[cr-debug]   ✅ injected ${newSkills.length} skills via chatMessage mode`);
        }
      }
    },

    // ── Messages transform — no-op (resolution moved to chat.message) ──
    // chat.message fires before both transform hooks and has access to
    // message parts via output.parts, so it resolves triggers + loads skills.
    // This hook is kept for any future per-message enrichment but currently
    // does nothing — the system.transform hook injects from the session's
    // already-loaded active skills.

    "experimental.chat.messages.transform": async (_input, _output) => {
      log(`[cr-debug] messages.transform fired. no-op (resolution handled in chat.message)`);
    },

    // ── System prompt injection (primary path) ───────────────────────
    // Resolution + loading already done in chat.message. This hook just
    // injects whatever's in the session's active skill set, deduped by
    // content hash. Works regardless of whether this hook fires before or
    // after messages.transform.

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      log(`[cr-debug] system.transform fired. sessionID=${sessionID}`);

      if (!sessionID) return;

      // Skip if injectionMethod is chatMessage — already injected in chat.message
      if (config.injectionMethod === "chatMessage") {
        log(`[cr-debug]   skipping — chatMessage injection mode`);
        return;
      }

      const mgr = getOrCreateSession(sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);

      // Safety: flush any pending (should be empty since chat.message already flushed)
      mgr.flushPending();

      // Dedup via per-session hash Set — O(1) per skill instead of
      // re-scanning the whole system prompt every turn.
      const newSkills = mgr.filterNewForInjection();
      if (newSkills.length === 0) {
        log(`[cr-debug]   ⚠ no new skills to inject`);
        return;
      }

      const skillNames = newSkills.map(s => s.name).join(", ");
      const formatted = newSkills.map(s =>
        `<context-route name="${s.name}">\n${s.content.trim()}\n</context-route>`
      ).join("\n\n");

      // Tell the LLM these skills are already loaded — do NOT call the skill tool for them
      const note = `<context-routes-loaded>\nThe following skills are already loaded in this system prompt: ${skillNames}\nDo NOT use the skill tool to load them again.\n</context-routes-loaded>`;

      log(`[cr-debug]   ✅ injecting ${newSkills.length} skills into system prompt (${formatted.length} chars)`);
      output.system.push(`\n${note}\n${formatted}\n`);

      if (config.debug) {
        console.log(`[context-routing] Injected ${newSkills.length} skills into system prompt`);
      }
    },

    // ── Compaction persistence ────────────────────────────────────────

    "experimental.session.compacting": async (input, output) => {
      if (!config.persistAfterCompaction) return;

      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);

      const summary = mgr.getSkillsSummary();
      if (!summary) return;

      output.context.push(summary);
    },

    // ── Event handlers ────────────────────────────────────────────────

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        deleteSession(sessionID);
        if (config.analytics) {
          trackSessionEvent("session.deleted", sessionID);
        }
        if (config.debug) {
          console.log(`[context-routing] Cleaned up session ${sessionID}`);
        }
        return;
      }

      // ── Hot reload: workspace file changes ───────────────────────
      // OpenCode's file watcher fires for project workspace files.
      // Global files (in ~/.config/opencode/) don't trigger this —
      // use `npx context-routing reload` instead.
      if (event.type === "file.watcher.updated") {
        const file = (event.properties as { file?: string }).file;
        if (!file) return;

        // Project config changed → full reload
        if (file.endsWith("context-router.jsonc") || file.endsWith("context-router.json")) {
          performReload(`config changed: ${file}`);
          return;
        }

        // Skill file changed → invalidate just that file + re-scan if needed
        const isSkill = config.skillLocations.some(loc =>
          file.includes(".opencode/skills/") || file.includes(".opencode/agent/"),
        );
        if (isSkill) {
          loader.invalidateAll();
          if (config.scannerEnabled) {
            scannedIndex = scanSkillFiles(config, projectDir);
            resolver = new Resolver(config, scannedIndex);
          }
          if (config.debug) {
            console.log(`[context-routing] Re-scanned skills (${file} changed)`);
          }
        }
      }
    },

  } satisfies Hooks;

  // Add custom tool conditionally
  if (config.enableTools) {
    hooks.tool = {
      context_routes: {
        description: "Show all context-routed skills grouped by file extension with budget usage",
        args: {} as Record<string, never>,
        async execute(_args: Record<string, never>, context: ToolContextLike) {
          const mgr = getOrCreateSession(
            context.sessionID,
            config.maxTokens,
            config.debug,
            config.skillTTL,
            config.useMinification,
            config.useSummaries,
            config.skillSettings,
            config.analytics,
          );

          log(`[cr-debug] context_routes tool: sessionID=${context.sessionID}, active=${mgr.getActiveSkills().length}`);

          // ── Budget bar ───────────────────────────────────────────
          const budget = mgr.getBudgetStatus();
          const pct = budget.limit > 0 ? Math.round((budget.used / budget.limit) * 100) : 0;
          const barLen = 20;
          const filled = Math.round((pct / 100) * barLen);
          const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
          const budgetLine =
            `**Token Budget:** ${bar} ${pct}% (${budget.used} / ${budget.limit} tok · ${budget.loadedCount} skills)`;

          // ── Active skills table ──────────────────────────────────
          const active = mgr.getActiveSkills();
          if (active.length === 0) {
            return `${budgetLine}\n\nNo context-routed skills.`;
          }

          const tableHeader = "| Skill | Source | Priority | Tokens | Trigger |";
          const tableSep   = "|-------|--------|----------|--------|---------|";
          const tableRows = active.map((s) => {
            const tok = mgr.estimateTokens(s.content);
            const triggerSrc = findSkillTrigger(s.name, scannedIndex);
            return `| ${s.name} | ${s.source} | ${s.priority} | ${tok} | ${triggerSrc} |`;
          });

          // ── Per-extension grouping ───────────────────────────────
          const activeNames = new Set(active.map((s) => s.name));
          const extLines: string[] = [];
          for (const [ext, skillNames] of Object.entries(config.fileTypeSkills).sort()) {
            const matched = skillNames.filter((n) => activeNames.has(n));
            if (matched.length === 0) continue;
            extLines.push(
              `\`${ext}\` — ${matched.map((n) => `**${n}**`).join(", ")}`,
            );
          }

          // ── Dropped skills ───────────────────────────────────────
          const droppedLines: string[] = [];
          if (budget.dropped.length > 0) {
            droppedLines.push("\n#### Dropped (budget exceeded)");
            for (const d of budget.dropped) {
              droppedLines.push(`- ${d.name} (prio ${d.priority}, ${d.tokens} tok)`);
            }
          }

          // ── Scan cache section ──────────────────────────────────
          const cacheInfo = getScanCacheSummary(projectDir, scannedIndex, config.skillLocations);

          return [
            `## Context Routes`,
            budgetLine,
            "",
            "### Active",
            tableHeader,
            tableSep,
            ...tableRows,
            "",
            ...(extLines.length > 0 ? ["### Per Extension", ...extLines, ""] : []),
            ...droppedLines,
            "",
            "### Scan Cache",
            cacheInfo,
          ].join("\n");
        },
      },
    };
  }

  return hooks;
};

// ── Tool helper ──────────────────────────────────────────────────────────────

function findSkillTrigger(
  skillName: string,
  scannedIndex: ScannedSkillIndex,
): string {
  const meta = scannedIndex.get(skillName);
  if (meta) {
    if (meta.triggers.extensions?.length) return `file ${meta.triggers.extensions[0]}`;
    if (meta.triggers.paths?.length) return "path pattern";
    if (meta.triggers.agents?.length) return "agent match";
    if (meta.triggers.keywords?.length) return "keyword";
    if (meta.always) return "always-on";
  }
  return "frontmatter";
}

/**
 * Render a one-line scan cache summary for the in-session tool dashboard.
 * Shows: skill count, cache file location, in-sync status.
 */
function getScanCacheSummary(
  projectDir: string,
  scannedIndex: ScannedSkillIndex,
  currentLocations: string[],
): string {
  const cache = loadScanCache();
  const entry = cache?.projects[projectDir];
  const totalSkills = scannedIndex.size;
  const lines: string[] = [];

  lines.push(`- **Skills indexed:** ${totalSkills}`);

  if (entry) {
    const cachedCount = Object.keys(entry.entries).length;
    const locationMatch = JSON.stringify(entry.skillLocations) === JSON.stringify(currentLocations);
    const status = locationMatch ? "✓ in sync" : "⚠ locations changed";
    lines.push(`- **Cache:** ${cachedCount} entries · ${status}`);
  } else {
    lines.push(`- **Cache:** (no entry for this project — full scan on next reload)`);
  }

  lines.push(`- **Path:** \`~/.config/opencode/plugins/context-routing/scan-cache.json\``);
  lines.push(`- **Tip:** run \`npx context-routing benchmark\` to verify cache perf`);

  return lines.join("\n");
}

export const server = plugin;
export default plugin;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * OpenCode message part shape (subset we care about for text extraction).
 * The full `Part` type is a union with many variants; we only need the
 * text-like ones.
 */
type PartLike = Part | { type?: string; text?: string };

/** OpenCode tool execution context (subset). */
interface ToolContextLike {
  sessionID: string;
}

/**
 * Extract file-path-like strings from message text.
 */
function extractPaths(text: string): string[] {
  const results = new Set<string>();
  const pathRegex = /(?:[a-zA-Z]:[\\/])?(?:[\w.\-@()[\] ]+[\\/])+[\w.\-@()[\] ]+\.(\w{2,8})/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    results.add(match[0].replace(/\\/g, "/"));
  }
  return Array.from(results);
}

function extractTextFromParts(parts: Part[] | unknown): string {
  if (!parts || !Array.isArray(parts)) return "";
  return (parts as unknown[])
    .map((p: unknown) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
        return (p as { text?: string }).text ?? "";
      }
      return "";
    })
    .join(" ")
    .trim();
}
