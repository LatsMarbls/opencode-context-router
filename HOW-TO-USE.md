# How to Use Context Routing

Step-by-step guide — install, create skills, verify, use.

---

## 1. Install

```bash
git clone https://github.com/LatsMarbls/opencode-context-router.git
cd opencode-context-router
npm install
npm run build
```

Then add the plugin to your `opencode.json`:

```json
{
  "plugins": {
    "context-routing": {
      "path": "/absolute/path/to/opencode-context-router/dist/index.js"
    }
  }
}
```

Restart OpenCode. The plugin loads on next session start.

---

## 2. Create Your First Skill

A skill is a `.md` file with YAML frontmatter. Place it in one of these directories (checked in order):

| Location | Path Template |
|----------|---------------|
| Project-local | `{project}/.opencode/skills/{name}/SKILL.md` |
| Project-local (flat) | `{project}/.opencode/agent/{name}.md` |
| User-global | `{user}/.config/opencode/skills/{name}/SKILL.md` |
| User-global (flat) | `{user}/.config/opencode/agent/{name}.md` |

Create a minimal skill:

```markdown
---
name: migration-rules
triggers:
  extensions: [".php"]
  keywords: ["migration", "schema", "table"]
priority: 10
---

# Migration Rules

- Use `Schema::create()` not `DB::statement()`
- Always add `->index()` on foreign key columns
- Table names are snake_case plural
- Use `->timestamps()` for created_at/updated_at
```

The frontmatter fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique skill identifier |
| `triggers` | No | Nested map: `extensions`, `paths`, `agents`, `keywords` |
| `priority` | No | Higher = loaded first. Default: 5 |
| `always` | No | If `true`, inject every turn regardless of triggers |
| `groups` | No | Array of group names this skill belongs to |

**Default trigger discovery:** if you don't put `triggers` in frontmatter, the skill still loads — but only if it's named explicitly in a config trigger map. Frontmatter triggers are the recommended path.

---

## 3. Groups (Frontmatter-Only)

Groups bundle related skills so they load together. **All groups are defined in skill frontmatter** — there is no `config.groups` map.

### Declare membership in frontmatter

```markdown
---
name: migration-rules
groups: ["laravel-stack"]
---
```

A group "laravel-stack" exists iff at least one skill's frontmatter includes it. When any skill in the group loads, all siblings load too.

### Reference a group name in any trigger map

```jsonc
{
  "contentTriggers": {
    "laravel-stack": ["laravel-stack"]
  }
}
```

When the user types "laravel-stack", `expandGroups` finds all skills with `groups: ["laravel-stack"]` in frontmatter and loads them.

### Special: "always-on" loading

For always-load skills, set in either:

**Frontmatter:**
```markdown
---
name: coding-style
always: true
priority: 200
---
```

**Config `skillSettings`:**
```jsonc
{
  "skillSettings": {
    "coding-style": { "always": true, "priority": 200 }
  }
}
```

### Nested groups

If skill A has `groups: ["laravel"]` and skill B has `groups: ["backend", "laravel"]`, triggering "laravel" loads both. Up to 3 levels of nesting.

### Note on `config.groups` (v0.x)

Earlier versions used a `config.groups` map in the config file. **This is no longer supported.** If you're upgrading from v0.x:

- **Option A** (recommended): add `groups: [...]` to each member skill's frontmatter
- **Option B**: flatten `contentTriggers` to list skills directly (no group expansion needed)

---

## 4. Verify It Works

### Check a file path

```bash
npx context-routing check src/Models/User.php
```

Output:
```
File: src/Models/User.php

Extension triggers:  .php → migration-rules
Path triggers:       src/Models/** → (no path triggers)

Matched skills: migration-rules
Total estimated: 200 tokens
```

If the path is in `triggerIgnoreTags`, the CLI prints a warning and filters accordingly — matching the runtime behavior.

### View full skill matrix

```bash
npx context-routing
```

Shows all loaded skills grouped by trigger dimension, priority, and budget status.

### Check scan cache

```bash
# Cold start: re-reads all files, parses all YAML
rm ~/.config/opencode/plugins/context-routing/scan-cache.json
npx context-routing  # populate cache
# Warm start: only stats each file, reads only what changed
npx context-routing
```

The scan cache (`scan-cache.json`) lives in the same directory as `debug.log` and `analytics.jsonl`.

### Measure scan perf

```bash
npx context-routing benchmark
```

Creates 50 synthetic skills, runs cold + warm scans, reports timings.

---

## 5. Use in Session

Once the plugin is active, skills inject automatically. Trigger types:

| Trigger | When It Fires |
|---------|---------------|
| `keywords` | Message text contains a matching keyword (whole-word, with digit suffix support) |
| `extensions` | Message text contains a file path with matching extension |
| `paths` | Message text contains a file path matching a glob pattern |
| `agents` | Current agent name matches (glob supported) |
| `always` | Every turn, no condition |

### Check loaded skills in-session

Type `/context_routes` or `/skills` in the chat. Shows budget bar, active skills, dropped skills, and scan cache status.

### Hot reload during development

**Project-local files** (in `{project}/.opencode/`) — auto-reload on save. No restart.

**Global files** (in `~/.config/opencode/`) — run the reload signal after editing:

```bash
npx context-routing reload
```

The plugin picks it up on the next `chat.message`, reloads, then deletes the signal. No OpenCode restart.

---

## 6. Configuration (Optional)

The scanner auto-discovers skills via frontmatter. Config overrides are only needed when you want to:

- Force-load skills without frontmatter (`skills` array)
- Override a scanned skill's priority (`priority` map)
- Set global options

Create `.opencode/context-router.jsonc` in your project root:

```jsonc
{
  // Override a scanned skill's priority
  "priority": {
    "migration-rules": 100
  },

  // Force-load skills without frontmatter
  "skills": ["php-conventions"],

  // Keyword triggers not in any frontmatter
  "contentTriggers": {
    "laravel": ["php-conventions", "laravel-rules"],
    "inertia": ["inertia-rules"]
  },

  // Global options
  "maxTokens": 8000,
  "showToasts": true,
  "debug": false
}
```

### Config merge order

Later overrides earlier:

1. `~/.config/opencode/plugins/context-routing/context-router.jsonc` (defaults)
2. `~/.config/opencode/context-router.jsonc` (user-global)
3. `.opencode/context-router.jsonc` (project-local — highest priority)

### Key options

| Option | Default | Description |
|--------|---------|-------------|
| `maxTokens` | 8000 | Token budget. Lower = fewer skills loaded. Uses real BPE counting (`gpt-tokenizer`). |
| `scannerEnabled` | true | Auto-discover skills from frontmatter. |
| `accumulateSkills` | true | Keep skills across turns (false = fresh evaluation each turn). |
| `skillTTL` | 600000 | Skill cache TTL in ms (0 = **never evict**, not instant expiry). |
| `cacheFileTTL` | 60000 | How long skill file reads are cached before re-reading. |
| `showToasts` | true | Show skill-change toasts in chat. |
| `enableTools` | true | Enable `/context_routes` tool. |
| `injectionMethod` | `systemPrompt` | `systemPrompt` (preferred) or `chatMessage` (fallback). |
| `debug` | false | Log trigger evaluations + scan cache hits/misses. |

---

## 7. Advanced: Without Frontmatter

If you prefer config-only (no scanner), set `scannerEnabled: false` and define everything in config:

```jsonc
{
  "scannerEnabled": false,
  "skills": ["php-conventions"],
  "fileTypeSkills": {
    ".php": ["php-conventions", "laravel-rules"],
    ".vue": ["vue-conventions"]
  },
  "pathPatterns": {
    "src/Models/**": ["model-rules"],
    "src/Controllers/**": ["controller-rules"]
  },
  "agentSkills": {
    "coder-lite": ["coding-conventions"]
  },
  "contentTriggers": {
    "migration": ["migration-rules"],
    "controller": ["controller-rules"]
  }
}
```

Config-file triggers and frontmatter triggers merge — config wins for the same skill name.

---

## Quick Reference

| Command | What It Does |
|---------|--------------|
| `npx context-routing` | Show skill matrix |
| `npx context-routing check <file>` | Check triggers for a file |
| `npx context-routing config` | Show resolved config |
| `npx context-routing cache` | Show skill file cache stats |
| `npx context-routing benchmark` | Measure scanner cold/warm perf |
| `npx context-routing reload` | Hot-reload after editing global files |
| `/context_routes` | In-session skill dashboard |
