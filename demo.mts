/**
 * Live demo: context-router pipeline end-to-end.
 * Scans real skill files → resolves triggers → formats output.
 * Run: npx tsx demo.mts
 */

import { scanSkillFiles } from "./src/scanner.js";
import { Resolver } from "./src/resolver.js";
import { SessionManager } from "./src/session.js";
import { readFileSync } from "node:fs";

// ── 1. Config ────────────────────────────────────────────────
const config = {
  skills: [],
  fileTypeSkills: { ".php": ["php-conventions"] },
  agentSkills: { },
  pathPatterns: { "src/Models/**": [] },
  contentTriggers: { },
  groups: {},
  skillSettings: {},
  skillLocations: [
    "{project}/skills/{name}/SKILL.md",
  ],
  triggerIgnoreTags: ["node_modules", ".git", "vendor"],
  injectionMethod: "systemPrompt",
  maxTokens: 8000,
  useSummaries: false,
  useMinification: false,
  showToasts: false,
  enableTools: true,
  analytics: false,
  persistAfterCompaction: true,
  scannerEnabled: true,
  debug: false,
  priority: {},
};

// Create demo skill files
import { writeFileSync, mkdirSync } from "node:fs";

mkdirSync("skills/demo-skill", { recursive: true });
mkdirSync("skills/demo-skill2", { recursive: true });

writeFileSync("skills/demo-skill/SKILL.md", `---
name: php-rules
description: PHP conventions and best practices
triggers:
  extensions: [.php]
  paths: ["src/Models/", "app/"]
  keywords: ["eloquent", "migration"]
  agents: ["coder-lite"]
always: false
priority: 7
---
When working with PHP code:
- Use type hints on all methods
- Follow PSR-12 coding standards
- Use dependency injection over facades
`, "utf-8");

writeFileSync("skills/demo-skill2/SKILL.md", `---
name: vue-rules
description: Vue 3 component conventions
triggers:
  extensions: [.vue]
  agents: ["coder-lite"]
  keywords: ["component", "template"]
always: false
priority: 5
---
Vue 3 conventions:
- Use <script setup> composition API
- Use TypeScript for all components
- Use design tokens not hardcoded colors
`, "utf-8");

async function main() {
  // ── 2. Scan skill files ──────────────────────────────────
  console.log("\n─── SCAN ───────────────────────────────────────");
  const scanned = new Map(scanSkillFiles(config, process.cwd()));
  for (const [name, meta] of scanned) {
    console.log(`  Found skill: "${name}"`);
    console.log(`    triggers: ${JSON.stringify(meta.triggers)}`);
    console.log(`    priority: ${meta.priority}`);
    console.log(`    always:   ${meta.always}`);
  }

  // ── 3. Resolve triggers ─────────────────────────────────
  console.log("\n─── RESOLVE ───────────────────────────────────");
  const resolver = new Resolver(config, scanned);

  console.log(`  Open src/Models/User.php     → [${resolver.resolveFileTriggers("/project/src/Models/User.php").join(", ")}]`);
  console.log(`  Open Index.vue               → [${resolver.resolveFileTriggers("/project/resources/Index.vue").join(", ")}]`);
  console.log(`  Open README.md               → [${resolver.resolveFileTriggers("/project/README.md").join(", ")}]`);
  console.log(`  Agent "coder-lite"           → [${resolver.resolveAgentTriggers("coder-lite").join(", ")}]`);
  console.log(`  Msg "create a migration"     → [${resolver.resolveMessageTriggers("create a migration").join(", ")}]`);
  console.log(`  Msg "fix the component"      → [${resolver.resolveMessageTriggers("fix the component").join(", ")}]`);
  console.log(`  Msg "hello world"            → [${resolver.resolveMessageTriggers("hello world").join(", ")}]`);
  console.log(`  Priority sorted              → [${resolver.sortByPriority(["vue-rules", "php-rules"]).join(", ")}]`);

  // ── 4. Load & format skills ─────────────────────────────
  console.log("\n─── FORMAT ────────────────────────────────────");
  const session = new SessionManager("demo-session", 8000);

  const loadedSkills = [];
  for (const [name, meta] of scanned) {
    const text = readFileSync(meta.filePath, "utf-8");
    const parts = text.split("---");
    const content = parts.length >= 3 ? parts.slice(2).join("---").trim() : text.trim();
    loadedSkills.push({ name, content, source: meta.filePath, priority: meta.priority ?? 5 });
  }

  console.log(`  Loaded ${loadedSkills.length} skills`);
  session.queueSkills(loadedSkills, "demo");
  session.flushPending();
  console.log(`  Active: ${session.getActiveSkills().length}`);
  console.log(`  Has "php-rules"? ${session.hasSkill("php-rules")}`);

  const formatted = session.getFormattedSkills();
  console.log("\n" + formatted);

  // ── 5. Budget ───────────────────────────────────────────
  const budget = session.getBudgetStatus();
  console.log(`  Tokens: ${budget.used}/${budget.limit}`);

  // ── 6. Summary ──────────────────────────────────────────
  console.log("\n" + session.getSkillsSummary());
}

main().catch(console.error);
