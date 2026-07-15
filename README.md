```text
 ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗████████╗
██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝
██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝    ██║
██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗    ██║
╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗   ██║
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝

██████╗  ██████╗ ██╗   ██╗████████╗███████╗██████╗
██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝██╔══██╗
██████╔╝██║   ██║██║   ██║   ██║   █████╗  ██████╔╝
██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  ██╔══██╗
██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗██║  ██║
╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝

────────────────────────────────────────────────────────────────────

        Dynamic Context Injection for OpenCode

        Load only the skills that matter.
        Every turn. Every request. Zero wasted tokens.

────────────────────────────────────────────────────────────────────
```

> Context Router is an OpenCode plugin that dynamically injects relevant skill files into the next LLM request based on **what you're doing**, **where you're working**, and **what you're asking**.

---

## WHY CONTEXT ROUTER?

OpenCode plugins run every turn. Context Routing evaluates **what you're working on**, loads **only the relevant skill files** (from disk), and injects them into the system prompt of the *next* API call. The LLM stays stateless — the input just gets richer.

Without it, the LLM guesses generic patterns:
```
User: "create a controller"
  → Generic Controller class. Wrong base. No service layer.
```

With it:
```
User: "create a controller"
  → Plugin sees: agent=coder, keywords=[controller, crud], file=*.php
  → Queues: controller-rules, crud-rules, php-conventions
  → System prompt enriched before API call
  → LLM: class UserController extends ResourceController { ... }
```

## Quick Start

```bash
git clone <your-new-repo-url>
cd context-routing
npm install
npm run build
```

Then reference the build output in your `opencode.json`:

```json
{
  "plugins": {
    "context-routing": {
      "path": "path/to/context-routing/dist/index.js"
    }
  }
}
```

## Architecture

```
message/file event
       │
       ▼
  ┌─────────────┐     ┌──────────────┐     ┌────────────┐
  │  Resolver   │────▶│    Loader    │────▶│  Session   │
  │  (triggers) │     │  (backends)  │     │  (dedup,   │
  │  ext/path/  │     │  static-file │     │  priority, │
  │  agent/     │     │              │     │  budget)   │
  │  keyword/   │     │              │     │            │
  └─────────────┘     └──────────────┘     └─────┬──────┘
                                                  │
                                                  ▼
                                         ┌──────────────────┐
                                         │  System Prompt   │
                                         │  Injection       │
                                         │  (.push() in     │
                                         │  output.system)  │
                                         └──────────────────┘
```

4 hooks wired end-to-end:

| Hook | Purpose |
|------|---------|
| `chat.message` | Resolve agent + message + keyword triggers |
| `experimental.chat.system.transform` | Flush queued skills → inject into `output.system[]` |
| `experimental.session.compacting` | Persist active skill summaries across context trims |
| `event` (`session.deleted`) | Clean up session cache |

## The 4 Trigger Dimensions

A skill loads when **any** trigger group matches:

| # | Trigger | Example | Loads |
|---|---------|---------|-------|
| 1 | **File extension** | `.php` → php-conventions | Extension-based rules |
| 2 | **Path patterns** | `src/Controllers/**` → controller-rules | Layer-specific conventions |
| 3 | **Agent name** | Agent is `coder-lite` → BE+FE conventions | Role-appropriate context |
| 4 | **Message keywords** | User says "migration" → migration-rules | Intent-matched skills |

**File extension and path triggers fire at runtime** via the `tool.execute.after` hook — when a tool reads/writes/edits a file, the plugin checks the file path against extension and glob triggers and queues matching skills.

## Skill File Discovery (Scanner)

Skill files can declare their own triggers via YAML frontmatter:

```markdown
---
name: php-conventions
triggers:
  extensions: [".php"]
  paths: ["src/Models/**"]
  agents: ["coder", "coder-lite"]
  keywords: ["laravel", "php"]
priority: 10
always: false
groups: ["laravel-stack"]
---

# PHP Conventions
- PSR-4 autoloading
- Type hints on all method signatures
```

The scanner runs at init when `scannerEnabled: true` (default), reads all `.md` files in configured `skillLocations`, and registers their declared triggers automatically. Config-file triggers still work and override scanned triggers for the same skill name.

Set `scannerEnabled: false` to disable auto-discovery and rely entirely on config-file trigger maps.

## Static File Backend

| Backend | Behavior |
|---------|----------|
| **static** | Read local `.md` files. Always available, offline-friendly. |

All skills produce the same `LoadedSkill` type — dedup and priority sort work uniformly.

## Priority & Token Budget

Skills scored by priority. When estimated tokens exceed `maxTokens` (default 8,000), lowest-priority skills drop:

**Default priority tiers:**
- Project-level (`{project}/.opencode/`): implicit **100**
- User-global (`{user}/.config/opencode/`): implicit **75**
- Config `priority` map: explicit **per-skill**
- Default: **5**

Configured via `priority` map in config:

```jsonc
{
  "priority": {
    "controller-rules": 100,
    "migration-rules": 80,
    "php-conventions": 50
  }
}
```

## How It Loads — Turn by Turn

```
User: "create a migration"
  → chat.message fires → Resolver: keyword "migration" → queue migration-rules
  → system.transform fires → push migration-rules + php-conventions into system
  → API call enriched → correct conventions followed

User: opens src/Models/User.php
  → tool.execute.after fires → extension .php + path src/Models/** match
  → queue: model-rules, php-conventions (deferred to next inject)

User: "now create the model"
  → chat.message fires → Resolver: keyword "model" → queue model-rules
  → system.transform fires → model-rules + migration-rules (persisted) + php-conventions
  → SessionManager persists across compaction

User: "create the controller"
  → chat.message fires → Resolver: keyword "controller" → queue controller-rules + crud-rules
  → system.transform fires → controller-rules + crud-rules + php-conventions
  → migration-rules naturally dropped (budget / no longer relevant)
```

Group expansion runs after trigger resolution. If a triggered skill name is a group key, all members load. If a triggered skill belongs to a group (via frontmatter `groups` field), all siblings load. Nested groups expand up to 3 levels.

The system prompt is **re-evaluated every turn**. The LLM gets relevant context for *that step*, not stale history.

## Configuration

Config file: `context-router.jsonc`

Located at (merged in order, later overrides earlier):
1. `~/.config/opencode/plugins/context-routing/context-router.jsonc` — plugin defaults
2. `~/.config/opencode/context-router.jsonc` — user-global overrides
3. `.opencode/context-router.jsonc` — project-local overrides (highest priority)

### Full schema

```jsonc
{
  // ── Always-loaded skills ──
  "skills": ["php-conventions"],

  // ── File extension triggers ──
  "fileTypeSkills": {
    ".php": ["php-conventions", "laravel-rules"],
    ".vue": ["vue-conventions"]
  },

  // ── Path pattern triggers ──
  "pathPatterns": {
    "src/Models/**": ["model-rules"],
    "src/Controllers/**": ["controller-rules"],
    "database/migrations/**": ["migration-rules"]
  },

  // ── Agent name triggers ──
  "agentSkills": {
    "coder-lite": ["coding-conventions"],
    "researcher": ["research-rules"]
  },

  // ── Message keyword triggers ──
  "contentTriggers": {
    "migration": ["migration-rules"],
    "controller": ["controller-rules"],
    "vue component": ["vue-conventions"]
  },

  // ── Skill locations (order = priority) ──
  "skillLocations": [
    "{project}/.opencode/skills/{name}/SKILL.md",
    "{project}/.opencode/agent/{name}.md",
    "{user}/.config/opencode/skills/{name}/SKILL.md",
    "{user}/.config/opencode/agent/{name}.md"
  ],

  // ── Priority map ──
  "priority": {
    "controller-rules": 100,
    "migration-rules": 80,
    "php-conventions": 50
  },

  // ── Per-skill settings ──
  "skillSettings": {
    "always-on-rules": { "always": true, "priority": 200 },
    "summarized-skill": { "useSummary": true }
  },

  // ── Named groups ──
  "groups": {
    "laravel-stack": ["php-conventions", "migration-rules", "model-rules", "controller-rules"]
  },

  // ── Global options ──
  "maxTokens": 8000,
  "scannerEnabled": true,
  "useSummaries": false,
  "useMinification": false,
  "showToasts": true,
  "enableTools": true,
  "persistAfterCompaction": true,
  "debug": false
}
```

### Trigger reference

| Field | Type | Behavior |
|-------|------|----------|
| `fileTypeSkills` | `Record<ext, string[]>` | Matches `.ext` |
| `pathPatterns` | `Record<glob, string[]>` | Glob patterns relative to project root |
| `agentSkills` | `Record<agent, string[]>` | Matches current agent name |
| `contentTriggers` | `Record<keyword, string[]>` | Case-insensitive substring in message |

## CLI

The plugin ships a CLI to inspect what would load:

```bash
npx context-routing              # Show full skill matrix
npx context-routing check User.php  # Check triggers for a file
npx context-routing config       # Show resolved config
```

### `matrix` (default)

Shows all skills from all trigger maps grouped by dimension, with extension groups and budget. Output:

```
## Preloaded Skills
**Token Budget:** ███░░░░░░░░░░░░░░░░░ 15% (1200 / 8000 tok · 4 skills)

### Active
| Skill | Source | Priority | Tokens | Trigger |
|-------|--------|----------|--------|---------|
| php-conventions | static-file | 5 | ~400 | file .php |
| migration-rules | static-file | 80 | ~600 | keyword |
| model-rules | static-file | 5 | ~500 | keyword |
| controller-rules | static-file | 100 | ~1200 | path pattern |

### Per Extension
`.php` — **php-conventions**, **migration-rules**, **model-rules**

### Dropped (budget exceeded)
- seeder-rules (prio 5, ~300 tok)
```

### `check <file>`

```
$ npx context-routing check src/Models/User.php

File: src/Models/User.php

Extension triggers:  .php → php-conventions, laravel-rules
Path triggers:       src/Models/** → model-rules

Matched skills: php-conventions, laravel-rules, model-rules
Total estimated: 1800 tokens
```

### `config`

```
Resolved configuration:

  maxTokens:     8000
  showToasts:    true
  enableTools:   true
  debug:         false

  skillLocations:
    {project}/.opencode/skills/{name}/SKILL.md
    {project}/.opencode/agent/{name}.md
    {user}/.config/opencode/skills/{name}/SKILL.md
    {user}/.config/opencode/agent/{name}.md

  skills:        php-conventions, laravel-rules
  fileTypeSkills: .php (4), .vue (2)
  pathPatterns:  3 patterns
  agentSkills:   2 agents
  contentTriggers: 4 keywords
```

### `help`

Shows all commands and flags.

## Built-in Tool

When `enableTools: true` (default), a `/skills` (or `preload_skills`) tool is exposed:

```
/preload_skills
```

Shows the same dashboard as the CLI: budget bar, active table, per-extension groups, dropped list. Available in-session without leaving the chat.

## Token Survival

OpenCode compacts sessions periodically, dropping stale tool outputs. Context Routing persists through compaction via the `experimental.session.compacting` hook — active skill summaries written to `output.context[]` restore on the next `system.transform`.

## Reuses Existing Agent Files

The default `skillLocations` reads `{user}/.config/opencode/agent/*.md` directly — no parallel skill directory needed. If you already have agent skill files, they load automatically when triggers match.

## Key Constraints Enforced

- **`output.system` mutated in place** — uses `.push()` not reassignment (reassignment is a silent no-op in OpenCode)
- **Plugin input is `{ client, project, directory, $ }`** — destructured correctly
- **Hooks typed via `satisfies Hooks`** — no type widening
- **Zero runtime npm deps** — only `@opencode-ai/plugin` as dev dep for types
- **~23KB output** for the plugin, ~8.5KB for the CLI, plus a shared chunk

## Development

```bash
npm install
npm run build        # tsup — one-shot
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit
```

Output: `dist/index.js` (plugin entry) + `dist/cli.js` (CLI bin).

## See Also

- [`HOW-TO-USE.md`](./HOW-TO-USE.md) — Step-by-step setup guide: install, create skills, verify, configure
- [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) — Full API payload comparison across 4-turn scenario (with/without plugin), JSON request/response bodies at each step
- [`context-router.jsonc`](./context-router.jsonc) — Default config example
