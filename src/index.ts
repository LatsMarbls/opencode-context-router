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
import { loadConfig } from "./config.js";
import { SkillLoader, type LoadedSkill } from "./loader.js";
import { Resolver } from "./resolver.js";
import { scanSkillFiles, type ScannedSkillIndex } from "./scanner.js";
import { getOrCreateSession, deleteSession } from "./session.js";
import { trackSessionEvent } from "./analytics.js";
import { appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── File Logger ─────────────────────────────────────────────────────────────
// Writes diagnostics to ~/.config/opencode/plugins/context-routing/debug.log
// so user can share without terminal access.
const LOG_FILE = join(homedir(), ".config", "opencode", "plugins", "context-routing", "debug.log");

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
  const config = loadConfig(projectDir);

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
  const resolver = new Resolver(config, scannedIndex);

  log(`[cr-debug] Plugin init START. projectDir=${projectDir}`);
  log(`[cr-debug]   config: skills=${JSON.stringify(config.skills)}, fileTypeSkills=${JSON.stringify(Object.keys(config.fileTypeSkills))}`);
  log(`[cr-debug]   contentTriggers=${JSON.stringify(Object.keys(config.contentTriggers))}`);
  log(`[cr-debug]   agentSkills=${JSON.stringify(Object.keys(config.agentSkills))}`);
  log(`[cr-debug]   scannerEnabled=${config.scannerEnabled}, debug=${config.debug}`);

  if (config.debug) {
    console.log(`[context-routing] Initialized (project: ${projectDir})`);
  }

  // 4. Build hooks object
  const hooks: Hooks = {
    // ── Chat message — session init + reset turn flag ──────────────────

    "chat.message": async (input) => {
      log(`[cr-debug] chat.message fired. sessionID=${input.sessionID}`);
      injectedThisTurn = null;
      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);
      if (!config.accumulateSkills) {
        mgr.clear();
      }

      // Track session creation (first time only)
      if (config.analytics && mgr.getActiveSkills().length === 0) {
        trackSessionEvent("session.created", input.sessionID);
      }
    },

    // ── Messages transform — resolve triggers + load skills only ──────
    // Injection is done by system.transform (fires after, targets system prompt).

    "experimental.chat.messages.transform": async (_input, output) => {
      log(`[cr-debug] messages.transform fired. total messages=${output.messages.length}`);

      // Find last user message (fully assembled with parts)
      const userMessages = output.messages.filter(
        (m: any) => m.info?.role === "user",
      );
      log(`[cr-debug]   user messages=${userMessages.length}`);
      const lastUserMsg = userMessages[userMessages.length - 1];
      if (!lastUserMsg) {
        log(`[cr-debug]   ⚠ no last user message found`);
        return;
      }

      const sessionID = lastUserMsg.info?.sessionID;
      const agentName = (lastUserMsg.info as any)?.agent;
      const messageText = extractTextFromParts(lastUserMsg.parts);
      log(`[cr-debug]   sessionID=${sessionID}, agent=${agentName}, text="${messageText?.substring(0, 80)}"`);

      if (!sessionID) {
        log(`[cr-debug]   ⚠ no sessionID on lastUserMsg.info`);
        return;
      }

      const mgr = getOrCreateSession(sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);

      // ── Resolve triggers ──────────────────────────────────────────
      const skillNames = new Set<string>();

      // Agent-based triggers
      if (agentName) {
        const agents = resolver.resolveAgentTriggers(agentName);
        log(`[cr-debug]   agent triggers: ${JSON.stringify(agents)}`);
        agents.forEach((n) => skillNames.add(n));
      } else {
        log(`[cr-debug]   no agent name`);
      }

      // Content-based triggers from user's message parts
      if (messageText) {
        const keywords = resolver.resolveMessageTriggers(messageText);
        log(`[cr-debug]   keyword triggers: ${JSON.stringify(keywords)}`);
        keywords.forEach((n) => skillNames.add(n));

        const paths = extractPaths(messageText);
        log(`[cr-debug]   extracted paths: ${JSON.stringify(paths)}`);
        for (const p of paths) {
          resolver.resolveFileTriggers(p).forEach((n) => skillNames.add(n));
        }
      } else {
        log(`[cr-debug]   no message text`);
      }

      // Always-on skills
      config.skills.forEach((n) => skillNames.add(n));
      if (config.groups["always"]) {
        config.groups["always"].forEach((n) => skillNames.add(n));
      }
      resolver.getAlwaysOnSkills().forEach((n) => skillNames.add(n));

      // Expand group names → member skills
      resolver.expandGroups(Array.from(skillNames)).forEach((n) => skillNames.add(n));

      log(`[cr-debug]   total resolved skill names: ${JSON.stringify(Array.from(skillNames))}`);

      // ── Load new skills ───────────────────────────────────────────
      if (skillNames.size > 0) {
        const toLoad = Array.from(skillNames).filter((n) => !mgr.hasSkill(n));
        log(`[cr-debug]   to load (not already in session): ${JSON.stringify(toLoad)}`);
        if (toLoad.length > 0) {
          const loaded: LoadedSkill[] = [];
          let loadFailures = 0;
          for (const name of toLoad) {
            try {
              const skill = loader.loadStaticSkill(name);
              log(`[cr-debug]     loading "${name}": ${skill ? "found" : "NOT FOUND"}`);
              if (skill) loaded.push(skill);
            } catch (err) {
              log(`[cr-debug]     ERROR loading "${name}": ${err instanceof Error ? err.message : String(err)}`);
              loadFailures++;
            }
          }
          if (loadFailures > 0) {
            log(`[cr-debug]   ${loadFailures} skill(s) failed to load`);
          }
          if (loaded.length > 0) {
            // Dedup: skip skills whose content already appears in system message
            const existingSystem = output.messages
              .filter((m: any) => m.info?.role === "system")
              .map((m: any) => extractTextFromParts(m.parts))
              .join("\n");
            const deduped = loaded.filter(s => !existingSystem.includes(s.content.trim()));
            if (deduped.length < loaded.length) {
              log(`[cr-debug]   dedup: ${loaded.length - deduped.length} skills already in system message`);
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

      // ── Flush pending ────────────────────────────────────────────
      mgr.flushPending();
      log(`[cr-debug]   active skills after flush: ${mgr.getActiveSkills().length}`);

      // ── Inject as system message if injectionMethod is chatMessage ──
      if (config.injectionMethod === "chatMessage") {
        const active = mgr.getActiveSkills();
        if (active.length > 0) {
          const existingSystem = output.messages
            .filter((m: any) => m.info?.role === "system")
            .map((m: any) => extractTextFromParts(m.parts))
            .join("\n");
          const newSkills = active.filter(s => !existingSystem.includes(s.content.trim()));
          if (newSkills.length > 0) {
            const skillNames = newSkills.map(s => s.name).join(", ");
            const formatted = newSkills.map(s =>
              `<context-route name="${s.name}">\n${s.content.trim()}\n</context-route>`
            ).join("\n\n");
            const note = `<context-routes-loaded>\nThe following skills are already loaded: ${skillNames}\nDo NOT use the skill tool to load them again.\n</context-routes-loaded>`;
            output.messages.push({
              info: { role: "system" },
              parts: [`\n${note}\n${formatted}\n`],
            } as any);
            injectedThisTurn = "messages";
            log(`[cr-debug]   ✅ injected ${newSkills.length} skills as system message (chatMessage mode)`);
          }
        }
      }
    },

    // ── System prompt injection (preferred, skipped if chatMessage mode) ──

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      log(`[cr-debug] system.transform fired. sessionID=${sessionID}`);

      if (!sessionID) return;

      // Skip if injectionMethod is chatMessage — already handled by messages.transform
      if (config.injectionMethod === "chatMessage") {
        log(`[cr-debug]   skipping — chatMessage injection mode`);
        return;
      }

      const mgr = getOrCreateSession(sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);

      // Flush any pending skills into active
      mgr.flushPending();

      const activeCount = mgr.getActiveSkills().length;
      log(`[cr-debug]   active skills=${activeCount}, injectedThisTurn=${injectedThisTurn}`);

      if (injectedThisTurn === "messages") {
        log(`[cr-debug]   skipping — messages already injected`);
        return;
      }

      const active = mgr.getActiveSkills();
      if (active.length === 0) {
        log(`[cr-debug]   ⚠ no active skills`);
        return;
      }

      // Dedup: skip skills whose content already appears in system prompt
      const existingSystem = output.system.join("\n");
      const newSkills = active.filter(s => !existingSystem.includes(s.content.trim()));
      if (newSkills.length === 0) {
        log(`[cr-debug]   ⚠ all ${active.length} skills already present in system prompt — skipping`);
        return;
      }

      const skillNames = newSkills.map(s => s.name).join(", ");
      const formatted = newSkills.map(s =>
        `<context-route name="${s.name}">\n${s.content.trim()}\n</context-route>`
      ).join("\n\n");

      // Tell the LLM these skills are already loaded — do NOT call the skill tool for them
      const note = `<context-routes-loaded>\nThe following skills are already loaded in this system prompt: ${skillNames}\nDo NOT use the skill tool to load them again.\n</context-routes-loaded>`;

      log(`[cr-debug]   ✅ injecting ${newSkills.length}/${active.length} skills into system prompt (${formatted.length} chars)`);
      output.system.push(`\n${note}\n${formatted}\n`);
      injectedThisTurn = "system";

      if (config.debug) {
        const count = mgr.getActiveSkills().length;
        console.log(`[context-routing] Injected ${count} skills into system prompt`);
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
      }
    },

  } satisfies Hooks;

  // Add custom tool conditionally
  if (config.enableTools) {
    hooks.tool = {
      context_routes: {
        description: "Show all context-routed skills grouped by file extension with budget usage",
        args: {} as Record<string, never>,
        async execute(_args: Record<string, never>, context: any) {
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
            const tok = Math.ceil(s.content.length / 4);
            const triggerSrc = findSkillTrigger(s.name, scannedIndex);
            return `| ${s.name} | ${s.source} | ${s.priority} | ~${tok} | ${triggerSrc} |`;
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
              droppedLines.push(`- ${d.name} (prio ${d.priority}, ~${d.tokens} tok)`);
            }
          }

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

export const server = plugin;
export default plugin;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract file-path-like strings from message text.
 */
function extractPaths(text: string): string[] {
  const results = new Set<string>();
  const pathRegex = /(?:[a-zA-Z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.(\w{2,6})/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    results.add(match[0].replace(/\\/g, "/"));
  }
  return Array.from(results);
}

function extractTextFromParts(parts: unknown[]): string {
  if (!parts || !Array.isArray(parts)) return "";
  return parts
    .map((p: any) => {
      if (typeof p === "string") return p;
      if (p?.type === "text") return p.text ?? "";
      return "";
    })
    .join(" ")
    .trim();
}
