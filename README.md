```
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

> Context Router is an OpenCode plugin that dynamically injects relevant skill files into the LLM request based on **what you're doing**, **where you're working**, and **what you're asking**.

---

## WHY CONTEXT ROUTER?

OpenCode plugins run every turn. Context Routing evaluates **what you're working on**, loads **only the relevant skill files** (from disk), and injects them into the system prompt of the API call. The LLM stays stateless — the input just gets richer.

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
git clone https://github.com/LatsMarbls/opencode-context-router.git
cd opencode-context-router
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

5 hooks wired end-to-end:

| Hook | Purpose |
|------|---------|
| `chat.message` | Resolve agent + message + keyword triggers, load skills, flush to active set. Also handles `chatMessage` injection mode as fallback. |
| `experimental.chat.messages.transform` | No-op (resolution moved to `chat.message` which fires first). |
| `experimental.chat.system.transform` | Read active skill set, dedup via content hash, push to `output.system[]`. Primary injection path. |
| `experimental.session.compacting` | Persist active skill summaries across context trims. |
| `event` (`session.deleted`) | Clean up session cache. |
| `event` (`file.watcher.updated`) | Hot reload for project-local skill + config files. |

## The 4 Trigger Dimensions

A skill loads when **any** trigger group matches:

| # | Trigger | Example | Loads |
|---|---------|---------|-------|
| 1 | **File extension** | `.php` → php-conventions | Extension-based rules |
| 2 | **Path patterns** | `src/Controllers/**` → controller-rules | Layer-specific conventions |
| 3 | **Agent name** | Agent is `coder-lite` → BE+FE conventions | Role-appropriate context |
| 4 | **Message keywords** | User says "migration" → migration-rules | Intent-matched skills |

**All trigger resolution happens synchronously** in the `chat.message` hook. When you type a message, the plugin extracts file paths from the text (e.g., `src/Models/User.php`) and checks them against extension and glob triggers. The new architecture decouples resolution from injection — the resolution always happens before any transform hook fires, so new skills inject same-turn regardless of OpenCode's internal transform ordering.

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

The scanner runs at init when `scannerEnabled: true` (default), reads all `.md` files in configured `skillLocations`, parses their frontmatter, and registers triggers, priority, and group membership automatically.

**Scan cache:** parsed frontmatter is cached at `~/.config/opencode/plugins/context-routing/scan-cache.json`. Subsequent startups skip re-reading + re-parsing files whose mtime + size haven't changed. On a 50-skill setup: cold ~35ms → warm ~25ms.

Set `scannerEnabled: false` to disable auto-discovery and rely entirely on config-file trigger maps.

## Group Membership (Frontmatter-Driven)

Groups are defined **solely by frontmatter**. A group "laravel-stack" exists iff at least one skill's frontmatter has `groups: ["laravel-stack", ...]`.

**Two directions:**
1. A name in a trigger map (e.g. `contentTriggers: { "laravel-stack": ["laravel-stack"] }`) → loads all skills with `groups: ["laravel-stack"]` in frontmatter
2. A skill with `groups: [...]` in frontmatter → loads all sibling skills sharing any of those group names

**Reference a group name in any trigger map** (`contentTriggers`, `fileTypeSkills`, `pathPatterns`, `agentSkills`) and all frontmatter-declared members load. Up to 3 levels of nesting.

**Why frontmatter-only:** single source of truth, lives next to the skill. No duplicate config.

**Migration note:** earlier versions used a `config.groups` map. This is no longer supported — group definitions now live exclusively in skill frontmatter.

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

**Token estimation** uses `gpt-tokenizer` (cl100k_base) for accurate budget enforcement. Replaces the old `chars/4` heuristic. Falls back to `chars/4` on encoder error. ~0.01ms per 1KB — negligible runtime cost. BPE data loads from `node_modules` at runtime, not bundled.

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

## Hot Reload

The plugin re-reads skill files + config when they change. Two reload paths:

**Project-local files** (in `{project}/.opencode/`) — automatic. OpenCode's `EventFileWatcherUpdated` fires when files change. The plugin handles it, re-scans, invalidates loader cache, rebuilds resolver.

**Global files** (in `~/.config/opencode/`) — manual via CLI:

```bash
npx context-routing reload
```

This writes a signal file. The plugin checks for it on each `chat.message`, reloads, then deletes the signal. No OpenCode restart needed.

The reload does:
- Re-merge config (3-layer)
- Re-scan skills (uses cache, fast)
- Invalidate loader cache
- Rebuild resolver

## How It Loads — Turn by Turn

```
User: "create a migration"
  → chat.message fires → Resolver: keyword "migration" → load migration-rules
  → system.transform fires → inject migration-rules + php-conventions
  → API call enriched → correct conventions followed

User: "now create the model (src/Models/User.php)"
  → chat.message fires → Resolver: keyword "model" + path src/Models/**
  → load model-rules + php-conventions
  → system.transform fires → model-rules + php-conventions (deduped)
  → SessionManager persists across compaction

User: "create the controller"
  → chat.message fires → Resolver: keyword "controller" → load controller-rules
  → system.transform fires → controller-rules + php-conventions
  → migration-rules naturally dropped (no longer relevant)
```

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

  // ── Global options ──
  "maxTokens": 8000,
  "scannerEnabled": true,
  "useSummaries": false,
  "useMinification": false,
  "showToasts": true,
  "enableTools": true,
  "persistAfterCompaction": true,
  "accumulateSkills": true,   // false = fresh evaluation each turn
  "skillTTL": 600000,         // ms — skills evicted after inactivity (0 = NEVER evict)
  "cacheFileTTL": 60000,      // ms — how long skill file reads are cached
  "debug": false,

  // ── Token injection target ──
  "injectionMethod": "systemPrompt"  // or "chatMessage" (fallback)
}
```

> **Note on `skillTTL: 0`:** This means "never evict" (skills live for session lifetime), NOT "instant expiry". If you want skills to drop after each turn, set `accumulateSkills: false` instead.

### Trigger reference

| Field | Type | Behavior |
|-------|------|----------|
| `fileTypeSkills` | `Record<ext, string[]>` | Matches `.ext` |
| `pathPatterns` | `Record<glob, string[]>` | Glob patterns relative to project root |
| `agentSkills` | `Record<agent, string[]>` | Matches current agent name (glob supported) |
| `contentTriggers` | `Record<keyword, string[]>` | Whole-word match in message text. Digit suffix allowed (`vue` matches `vue3`). |

## CLI

```bash
npx context-routing              # Show full skill matrix
npx context-routing check User.php  # Check triggers for a file
npx context-routing config       # Show resolved config
npx context-routing cache        # Show skill file cache stats
npx context-routing benchmark    # Measure scanner cold vs warm cache
npx context-routing reload       # Signal the running plugin to hot-reload
npx context-routing help         # Show all commands
```

### `matrix` (default)

Shows all skills from all trigger maps grouped by dimension, with extension groups and budget. Output:

```
## Context Routes
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

If the path is in `triggerIgnoreTags`, you'll see a warning and the runtime behavior matches the CLI output.

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

### `cache`

Shows file-read cache stats (hit rate, cached paths).

### `benchmark`

Creates 50 synthetic skills, measures cold + warm scan times, then cleans up. Useful for verifying the cache is working in your environment.

```
Scan benchmark (50 skills, 1 run):
  Cold cache:  34.8ms  (50 file reads + 50 YAML parses)
  Warm cache:  25.0ms  (50 stat calls + cached frontmatter)
  Speedup:     1.4x
```

### `reload`

Writes a signal file. The running plugin picks it up on the next `chat.message`, reloads config + skills, deletes the signal. Use after editing files in `~/.config/opencode/`.

### `help`

Shows all commands and flags.

## Built-in Tool

When `enableTools: true` (default), a `/context_routes` (or `/skills`) tool is exposed. Shows budget bar, active skills, dropped skills, and scan cache status. Available in-session without leaving the chat.

## Token Survival

OpenCode compacts sessions periodically, dropping stale tool outputs. Context Routing persists through compaction via the `experimental.session.compacting` hook — active skill summaries written to `output.context[]` restore on the next `system.transform`.

## Reuses Existing Agent Files

The default `skillLocations` reads `{user}/.config/opencode/agent/*.md` directly — no parallel skill directory needed. If you already have agent skill files, they load automatically when triggers match.

## Key Constraints Enforced

- **`output.system` mutated in place** — uses `.push()` not reassignment (reassignment is a silent no-op in OpenCode)
- **Plugin input is `{ client, project, directory, $ }`** — destructured correctly
- **Hooks typed via `satisfies Hooks`** — no type widening
- **`triggerIgnoreTags` matches path SEGMENTS, not substrings** — `dist` won't accidentally skip `src/distribution/Foo.php`
- **Keyword matching is whole-word, with digit suffix** — `vue` matches `vue3` but not `vuex`; `vue` does not match `vueing`
- **Token count is real BPE** — budget accurate within ~10% across LLM families
- **Dedup is O(1) per skill per turn** — content hash Set, not string scan

## Breaking Changes from v0.x

- **`config.groups` removed** (hard break). Groups are now defined exclusively via skill frontmatter `groups: [...]`. Skill packs that previously used `config.groups: { laravel: [...] }` need to either:
  - Add `groups: ["laravel"]` to each member skill's frontmatter, OR
  - Flatten `contentTriggers` to list skills directly (e.g. `contentTriggers: { laravel: ["php-conventions", "model-rules", ...] }`)

## Development

```bash
npm install
npm run build        # tsup — one-shot
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

Output: `dist/index.js` (plugin entry) + `dist/cli.js` (CLI bin).

## See Also

- [`HOW-TO-USE.md`](./HOW-TO-USE.md) — Step-by-step setup guide
- [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) — Full API payload comparison across 4-turn scenario
