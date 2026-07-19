/**
 * Plugin entry point — hooks registration for OpenCode.
 *
 * Architecture:
 *   chat.message                  → session init + trigger resolution + skill load
 *   experimental.chat.messages.transform → semantic reorder (if semanticWindow)
 *   experimental.chat.system.transform    → inject skills into system prompt
 *   experimental.session.compacting      → persist skill list across compaction
 *   event                               → cleanup on session deleted
 *
 * Dual-layer system:
 *   Layer 1 (existing): Skill routing — keyword/agent/file triggers → inject skills
 *   Layer 2 (new):      Semantic search — ONNX embeddings + LanceDB → reorder messages
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
import type { Embedder } from "./embedding/provider.js";
import type { VectorStore } from "./store/vector-store.js";
import type { MessageIndexer } from "./semantic/message-indexer.js";
import type { QueryEngine } from "./semantic/query-engine.js";

// ── File Loggers ────────────────────────────────────────────────────────────
const PLUGIN_DIR = join(homedir(), ".config", "opencode", "plugins", "context-routing");
const LOG_FILE = join(PLUGIN_DIR, "debug.log");
const SKILL_LOG = join(PLUGIN_DIR, "skill.log");
const MESSAGE_LOG = join(PLUGIN_DIR, "message.log");
const PERF_LOG = join(PLUGIN_DIR, "perf.log");

const RELOAD_SIGNAL = join(PLUGIN_DIR, ".reload-signal");

function log(...args: unknown[]) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line, "utf-8"); } catch {}
}

function skillLog(...args: unknown[]) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(SKILL_LOG, line, "utf-8"); } catch {}
}

function msgLog(...args: unknown[]) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(MESSAGE_LOG, line, "utf-8"); } catch {}
}

function perfLog(...args: unknown[]) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(PERF_LOG, line, "utf-8"); } catch {}
}

// ── Turn-scoped state ──────────────────────────────────────────────────────

let injectedThisTurn: "messages" | "system" | null = null;
let currentSessionID: string | null = null;

// ── Semantic Search State ──────────────────────────────────────────────────

let embedder: Embedder | null = null;
let vectorStore: VectorStore | null = null;
let messageIndexer: MessageIndexer | null = null;
let queryEngine: QueryEngine | null = null;

async function initSemantic(config: ReturnType<typeof loadConfig>, projectDir: string): Promise<void> {
  if (!config.semanticWindow || config.embedder === "none") return;
  if (embedder && vectorStore) return;

  const t0 = Date.now();
  try {
    const { createOnnxEmbedder } = await import("./embedding/onnx-provider.js");
    const { createLanceStore } = await import("./store/lancedb-store.js");
    const { createMessageIndexer } = await import("./semantic/message-indexer.js");
    const { createQueryEngine } = await import("./semantic/query-engine.js");

    embedder = createOnnxEmbedder();
    vectorStore = await createLanceStore(projectDir);
    messageIndexer = createMessageIndexer(embedder, vectorStore);
    queryEngine = createQueryEngine(embedder, vectorStore, config.minScore);

    perfLog(`[init] semantic search initialized in ${Date.now() - t0}ms (model=${config.model}, store=${config.vectorStore})`);
  } catch (err) {
    perfLog(`[init] semantic search FAILED: ${err instanceof Error ? err.message : String(err)}`);
    embedder = null;
    vectorStore = null;
    messageIndexer = null;
    queryEngine = null;
  }
}

// ── Plugin Definition ───────────────────────────────────────────────────────

const plugin: Plugin = async ({ client, project, directory }: PluginInput) => {
  const projectDir = directory;

  let config = loadConfig(projectDir);

  let scannedIndex: ScannedSkillIndex = new Map();
  if (config.scannerEnabled) {
    scannedIndex = scanSkillFiles(config, projectDir);
  }

  const loader = new SkillLoader(config, projectDir, config.cacheFileTTL);
  let resolver = new Resolver(config, scannedIndex);

  // Initialize semantic search if enabled
  await initSemantic(config, projectDir);

  skillLog(`[init] projectDir=${projectDir}`);
  skillLog(`[init] skills=${JSON.stringify(config.skills)}`);
  skillLog(`[init] fileTypeSkills=${JSON.stringify(Object.keys(config.fileTypeSkills))}`);
  skillLog(`[init] contentTriggers=${JSON.stringify(Object.keys(config.contentTriggers))}`);
  skillLog(`[init] agentSkills=${JSON.stringify(Object.keys(config.agentSkills))}`);
  skillLog(`[init] semanticWindow=${config.semanticWindow}, embedder=${config.embedder}`);

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
  }

  // 4. Build hooks object
  const hooks: Hooks = {

    "chat.message": async (input, output) => {
      log(`[cr-debug] chat.message fired. sessionID=${input.sessionID}`);
      injectedThisTurn = null;
      currentSessionID = input.sessionID;

      if (existsSync(RELOAD_SIGNAL)) {
        try { unlinkSync(RELOAD_SIGNAL); } catch {}
        performReload("global reload signal");
      }

      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);
      if (!config.accumulateSkills) {
        mgr.clear();
        mgr.clearInjectionCache();
      }

      if (config.analytics && mgr.getActiveSkills().length === 0) {
        trackSessionEvent("session.created", input.sessionID);
      }

      // ── Resolve triggers ──────────────────────────────────────────
      const messageText = extractTextFromParts(output.parts);
      const agentName = input.agent;
      const expandable = new Set<string>();
      const keywordOnly = new Set<string>();

      if (agentName) {
        resolver.resolveAgentTriggers(agentName).forEach((n) => expandable.add(n));
      }

      if (messageText) {
        resolver.resolveGroupNameTriggers(messageText).forEach((n) => expandable.add(n));
        resolver.resolveMessageTriggers(messageText).forEach((n) => keywordOnly.add(n));
        for (const p of extractPaths(messageText)) {
          resolver.resolveFileTriggers(p).forEach((n) => expandable.add(n));
        }
      }

      config.skills.forEach((n) => expandable.add(n));
      resolver.getAlwaysOnSkills().forEach((n) => expandable.add(n));
      resolver.expandGroups(Array.from(expandable)).forEach((n) => expandable.add(n));

      const skillNames = new Set([...expandable, ...keywordOnly]);

      skillLog(`[turn] session=${input.sessionID}`);
      skillLog(`[turn] resolved: ${JSON.stringify(Array.from(skillNames))}`);

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
              skillLog(`[load] ERROR "${name}": ${err instanceof Error ? err.message : String(err)}`);
              loadFailures++;
            }
          }
          if (loadFailures > 0) {
            skillLog(`[load] ${loadFailures} skill(s) failed`);
          }
          if (loaded.length > 0) {
            const existingContent = new Set(
              mgr.getActiveSkills().map(s => s.content.trim()),
            );
            const deduped = loaded.filter(s => !existingContent.has(s.content.trim()));
            if (deduped.length > 0) {
              mgr.queueSkills(deduped, "content.match");
              skillLog(`[load] queued: ${deduped.map(s => s.name).join(", ")}`);
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

      const active = mgr.getActiveSkills();
      skillLog(`[active] count=${active.length}`);
      for (const s of active) {
        skillLog(`[active] ${s.name} (source=${s.source}, priority=${s.priority})`);
      }

      // ── Index message for semantic search ─────────────────────────
      if (config.semanticWindow && messageIndexer) {
        const t0 = Date.now();
        try {
          await messageIndexer.indexMessage(
            input.sessionID,
            output.parts,
            input.messageID ?? `msg_${Date.now()}`,
            "user",
          );
          perfLog(`[index] session=${input.sessionID}, parts=${output.parts.length}, text_len=${messageText.length}, latency=${Date.now() - t0}ms`);
          msgLog(`[index] session=${input.sessionID}, messageID=${input.messageID ?? "unknown"}, role=user, text_len=${messageText.length}`);
        } catch (err) {
          perfLog(`[index] FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── chatMessage injection mode ────────────────────────────────
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
        }
      }
    },

    // ── Messages transform — semantic reorder ───────────────────────
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!config.semanticWindow || !queryEngine) return;
      if (injectedThisTurn === "messages") return;
      if (!currentSessionID) return;

      const t0 = Date.now();
      const messages = output.messages;

      // Extract latest user message as query
      const query = extractLatestUserMessage(messages);
      if (!query) {
        msgLog(`[transform] no user query found, skipping`);
        return;
      }

      msgLog(`[transform] session=${currentSessionID}, query_len=${query.length}, total_messages=${messages.length}`);

      try {
        const relevant = await queryEngine.search(
          currentSessionID,
          query,
          config.maxResults,
        );

        if (relevant.length === 0) {
          msgLog(`[transform] no relevant messages found, keeping original order`);
          return;
        }

        const reordered = reorderMessages(messages, relevant, { boostRecent: 5 });
        output.messages = reordered as typeof output.messages;

        const topScores = relevant.slice(0, 3).map(r => `${r.messageID}:${r.score.toFixed(3)}`).join(", ");
        msgLog(`[transform] reordered: kept=${reordered.length}, relevant=${relevant.length}, top=[${topScores}]`);
        perfLog(`[search] session=${currentSessionID}, query_len=${query.length}, results=${relevant.length}, top_score=${relevant[0]?.score.toFixed(3) ?? "n/a"}, latency=${Date.now() - t0}ms`);
      } catch (err) {
        perfLog(`[search] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    // ── System prompt injection ─────────────────────────────────────
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      log(`[cr-debug] system.transform fired. sessionID=${sessionID}`);

      if (!sessionID) return;

      if (config.injectionMethod === "chatMessage") {
        log(`[cr-debug]   skipping — chatMessage injection mode`);
        return;
      }

      const mgr = getOrCreateSession(sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);

      mgr.flushPending();

      const newSkills = mgr.filterNewForInjection();
      if (newSkills.length === 0) {
        log(`[cr-debug]   no new skills to inject`);
        return;
      }

      const skillNames = newSkills.map(s => s.name).join(", ");
      const formatted = newSkills.map(s =>
        `<context-route name="${s.name}">\n${s.content.trim()}\n</context-route>`
      ).join("\n\n");

      const note = `<context-routes-loaded>\nThe following skills are already loaded in this system prompt: ${skillNames}\nDo NOT use the skill tool to load them again.\n</context-routes-loaded>`;

      output.system.push(`\n${note}\n${formatted}\n`);
      skillLog(`[inject] ${newSkills.length} skills into system prompt (${formatted.length} chars)`);
    },

    // ── Compaction persistence ──────────────────────────────────────
    "experimental.session.compacting": async (input, output) => {
      if (!config.persistAfterCompaction) return;

      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug, config.skillTTL, config.useMinification, config.useSummaries, config.skillSettings, config.analytics);

      const summary = mgr.getSkillsSummary();
      if (!summary) return;

      output.context.push(summary);
    },

    // ── Event handlers ──────────────────────────────────────────────
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        deleteSession(sessionID);

        // Clean up vector store for this session
        if (vectorStore) {
          try {
            await vectorStore.deleteBySession(sessionID);
            msgLog(`[cleanup] deleted vectors for session ${sessionID}`);
          } catch {}
        }

        if (config.analytics) {
          trackSessionEvent("session.deleted", sessionID);
        }
        return;
      }

      if (event.type === "file.watcher.updated") {
        const file = (event.properties as { file?: string }).file;
        if (!file) return;

        if (file.endsWith("context-router.jsonc") || file.endsWith("context-router.json")) {
          performReload(`config changed: ${file}`);
          return;
        }

        const isSkill = config.skillLocations.some(loc =>
          file.includes(".opencode/skills/") || file.includes(".opencode/agent/"),
        );
        if (isSkill) {
          loader.invalidateAll();
          if (config.scannerEnabled) {
            scannedIndex = scanSkillFiles(config, projectDir);
            resolver = new Resolver(config, scannedIndex);
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

          const budget = mgr.getBudgetStatus();
          const pct = budget.limit > 0 ? Math.round((budget.used / budget.limit) * 100) : 0;
          const barLen = 20;
          const filled = Math.round((pct / 100) * barLen);
          const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
          const budgetLine =
            `**Token Budget:** ${bar} ${pct}% (${budget.used} / ${budget.limit} tok · ${budget.loadedCount} skills)`;

          const active = mgr.getActiveSkills();
          const lines = [budgetLine, ""];

          if (active.length === 0) {
            lines.push("No context-routed skills.");
          } else {
            lines.push("### Active");
            lines.push("| Skill | Source | Priority | Tokens | Trigger |");
            lines.push("|-------|--------|----------|--------|---------|");
            for (const s of active) {
              const tok = mgr.estimateTokens(s.content);
              const triggerSrc = findSkillTrigger(s.name, scannedIndex);
              lines.push(`| ${s.name} | ${s.source} | ${s.priority} | ${tok} | ${triggerSrc} |`);
            }
          }

          // Semantic search status
          if (config.semanticWindow) {
            lines.push("", "### Semantic Search", "- **Status:** enabled", `- **Embedder:** ${config.embedder}`, `- **Model:** ${config.model}`, `- **Vector Store:** ${config.vectorStore}`);
          } else {
            lines.push("", "### Semantic Search", "- **Status:** disabled (`semanticWindow: false`)");
          }

          if (budget.dropped.length > 0) {
            lines.push("", "#### Dropped (budget exceeded)");
            for (const d of budget.dropped) {
              lines.push(`- ${d.name} (prio ${d.priority}, ${d.tokens} tok)`);
            }
          }

          return lines.join("\n");
        },
      },
    };
  }

  return hooks;
};

export const server = plugin;
export default plugin;

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ToolContextLike {
  sessionID: string;
}

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

function extractLatestUserMessage(
  messages: Array<{ info: { role: string; id: string }; parts: unknown[] }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "user") {
      const text = extractTextFromParts(msg.parts);
      if (text.length > 0) return text;
    }
  }
  return null;
}

function reorderMessages<T extends { info: { role: string; id: string }; parts: unknown[] }>(
  messages: T[],
  relevant: Array<{ messageID: string; score: number }>,
  options: { boostRecent: number },
): T[] {
  const { boostRecent } = options;
  if (relevant.length === 0) return messages;

  const relevantMap = new Map<string, number>();
  for (const r of relevant) {
    relevantMap.set(r.messageID, r.score);
  }

  const recentCutoff = messages.length - boostRecent;
  const recent = messages.slice(recentCutoff);
  const older = messages.slice(0, recentCutoff);

  const sorted = [...older].sort((a, b) => {
    const scoreA = relevantMap.get(a.info.id) ?? 0;
    const scoreB = relevantMap.get(b.info.id) ?? 0;
    return scoreB - scoreA;
  });

  const relevantOlder = sorted.filter((m) => relevantMap.has(m.info.id));
  const irrelevantOlder = sorted.filter((m) => !relevantMap.has(m.info.id));

  return [...relevantOlder, ...irrelevantOlder, ...recent];
}

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
