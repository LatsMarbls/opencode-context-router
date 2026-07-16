/**
 * Plugin entry point — hooks registration for OpenCode.
 *
 * Architecture:
 *   tool.execute.after → resolve file triggers → queue skills
 *   chat.message       → resolve agent + content triggers → queue skills
 *   system.transform   → flush queue → inject into system prompt
 *   session.compacting → persist skill list across compaction
 *   event              → cleanup on session deleted
 */
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { SkillLoader, type LoadedSkill } from "./loader.js";
import { Resolver } from "./resolver.js";
import { scanSkillFiles, type ScannedSkillIndex } from "./scanner.js";
import { getOrCreateSession, deleteSession } from "./session.js";
import type { PreloaderConfig } from "./config.js";

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

  if (config.debug) {
    console.log(`[context-routing] Initialized (project: ${projectDir})`);
  }

  // 3. Build hooks object (conditional tool property to avoid spread issues)
  const hooks: Hooks = {
    // ── Chat hooks ────────────────────────────────────────────────────

    "chat.message": async (input, output) => {
      const sessionID = input.sessionID;
      const mgr = getOrCreateSession(sessionID, config.maxTokens, config.debug, config.skillTTL);

      const skillNames = new Set<string>();

      // Agent-based triggers
      if (input.agent) {
        resolver.resolveAgentTriggers(input.agent).forEach((n) => skillNames.add(n));
      }

      // Message content triggers
      const messageText = extractTextFromParts(output.parts);
      if (messageText) {
        resolver.resolveMessageTriggers(messageText).forEach((n) => skillNames.add(n));
      }

      // Always-on skills
      config.skills.forEach((n) => skillNames.add(n));
      if (config.groups["always"]) {
        config.groups["always"].forEach((n) => skillNames.add(n));
      }
      resolver.getAlwaysOnSkills().forEach((n) => skillNames.add(n));

      // Expand group names → member skills
      const expanded = resolver.expandGroups(Array.from(skillNames));
      expanded.forEach((n) => skillNames.add(n));

      if (skillNames.size === 0) return;

      // Dedup against already-loaded skills
      const toLoad = Array.from(skillNames).filter((n) => !mgr.hasSkill(n));
      if (toLoad.length === 0) return;

      // Load skills
      const loaded: LoadedSkill[] = [];
      for (const name of toLoad) {
        const skill = loader.loadStaticSkill(name);
        if (skill) loaded.push(skill);
      }

      if (loaded.length > 0) {
        mgr.queueSkills(loaded, "chat.message");
        if (config.showToasts) {
          client.tui.showToast({
            body: {
              message: `Preloaded: ${loaded.map((s) => s.name).join(", ")}`,
              variant: "info",
              duration: 3_000,
            },
          });
        }
      }
    },

    // ── System prompt injection ───────────────────────────────────────

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;

      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug, config.skillTTL);

      // Flush pending → active
      mgr.flushPending();

      const formatted = mgr.getFormattedSkills();
      if (!formatted) return;

      // IMPORTANT: Must mutate output.system in place
      output.system.push(formatted);

      if (config.debug) {
        const count = mgr.getActiveSkills().length;
        console.log(`[context-routing] Injected ${count} skills into system prompt`);
      }
    },

    // ── Compaction persistence ────────────────────────────────────────

    "experimental.session.compacting": async (input, output) => {
      if (!config.persistAfterCompaction) return;

      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug, config.skillTTL);

      const summary = mgr.getSkillsSummary();
      if (!summary) return;

      output.context.push(summary);
    },

    // ── Event handlers ────────────────────────────────────────────────

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        deleteSession(sessionID);
        if (config.debug) {
          console.log(`[context-routing] Cleaned up session ${sessionID}`);
        }
      }
    },

    // ── Tool hooks (file/extension triggers) ─────────────────────────

    "tool.execute.after": async (input, output) => {
      // Only fire on file-operation tools
      const filePath = input.args?.path;
      if (!filePath || typeof filePath !== "string") return;

      // Skip ignored paths
      if (config.triggerIgnoreTags.some(tag =>
        filePath.replace(/\\/g, "/").toLowerCase().includes(tag.toLowerCase())
      )) return;

      const mgr = getOrCreateSession(input.sessionID, config.maxTokens, config.debug);

      const skillNames = resolver.resolveFileTriggers(filePath);
      if (skillNames.length === 0) return;

      // Expand group names → member skills
      const expanded = resolver.expandGroups(skillNames);
      const toLoad = expanded.filter(n => !mgr.hasSkill(n));
      if (toLoad.length === 0) return;

      const loaded: LoadedSkill[] = [];
      for (const name of toLoad) {
        const skill = loader.loadStaticSkill(name);
        if (skill) loaded.push(skill);
      }

      if (loaded.length > 0) {
        mgr.queueSkills(loaded, `tool:${input.tool} → ${filePath}`);
        if (config.showToasts) {
          client.tui.showToast({
            body: {
              message: `Preloaded: ${loaded.map((s) => s.name).join(", ")}`,
              variant: "info",
              duration: 3_000,
            },
          });
        }
      }
    },
  } satisfies Hooks;

  // Add custom tool conditionally (avoids spread with ternary issue)
  if (config.enableTools) {
    hooks.tool = {
      preload_skills: {
        description: "Show all loaded skills grouped by file extension with budget usage",
        args: {} as Record<string, never>,
        async execute(_args: Record<string, never>, context: any) {
          const mgr = getOrCreateSession(
            context.sessionID,
            config.maxTokens,
            config.debug,
            config.skillTTL,
          );

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
            return `${budgetLine}\n\nNo skills preloaded.`;
          }

          const tableHeader = "| Skill | Source | Priority | Tokens | Trigger |";
          const tableSep   = "|-------|--------|----------|--------|---------|";
          const tableRows = active.map((s) => {
            const tok = Math.ceil(s.content.length / 4);
            // Find trigger source from config
            const triggerSrc = findSkillTrigger(s.name, config, context);
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
            `## Preloaded Skills`,
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
  cfg: PreloaderConfig,
  context: any,
): string {
  // Check config trigger maps for which group catches this skill
  for (const [ext, names] of Object.entries(cfg.fileTypeSkills)) {
    if (names.includes(skillName)) return `file ${ext}`;
  }
  for (const [, names] of Object.entries(cfg.pathPatterns)) {
    if (names.includes(skillName)) return "path pattern";
  }
  for (const [, names] of Object.entries(cfg.agentSkills)) {
    if (names.includes(skillName)) return "agent match";
  }
  for (const [, names] of Object.entries(cfg.contentTriggers)) {
    if (names.includes(skillName)) return "keyword";
  }
  if (cfg.skillSettings[skillName]?.always) return "always-on";
  return "config";
}

export default plugin;

// ── Helpers ─────────────────────────────────────────────────────────────────

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
