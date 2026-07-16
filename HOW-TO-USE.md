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

---

## 3. Groups

Groups bundle related skills so they load together. Two ways to use:

### Config groups (define + reference by name)

```jsonc
{
  "groups": {
    "laravel-stack": ["php-conventions", "migration-rules", "model-rules"]
  },
  "contentTriggers": {
    "laravel": ["laravel-stack"]  // triggers all 3 skills
  }
}
```

Reference a group name in any trigger map (`contentTriggers`, `fileTypeSkills`, `pathPatterns`, `agentSkills`) and all members load.

### Frontmatter groups (declare membership)

```markdown
---
name: migration-rules
groups: ["laravel-stack"]
---
```

When any skill in a group loads, all siblings load too. Good for declaring relationships in the skill file itself.

### Special: "always" group

Members load every turn regardless of triggers:

```jsonc
{ "groups": { "always": ["coding-style", "security-rules"] } }
```

### Nested groups

Groups can reference other groups (up to 3 levels deep):

```jsonc
{
  "groups": {
    "core": ["php-conventions"],
    "laravel-stack": ["core", "migration-rules", "model-rules"]
  }
}
```

Triggering `laravel-stack` expands to `core`, which expands to `php-conventions`. No infinite loops — expansion stops after 3 passes or when no new names are added.

### Caveat

If a skill name matches a config group name, the group wins. E.g., a skill named `laravel-stack` won't load independently if a group `laravel-stack` exists.

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

### View full skill matrix

```bash
npx context-routing
```

Shows all loaded skills grouped by trigger dimension, priority, and budget status.

---

## 5. Use in Session

Once the plugin is active, skills inject automatically. Trigger types:

| Trigger | When It Fires |
|---------|---------------|
| `keywords` | Message text contains a matching word |
| `extensions` | Tool reads/writes a file with matching extension |
| `paths` | Tool operates on a file matching a glob pattern |
| `agents` | Current agent name matches |
| `always` | Every turn, no condition |

### Check loaded skills in-session

Type `/context_routes` or `/skills` in the chat. Shows the same dashboard as the CLI — budget bar, active skills, dropped skills.

---

## 6. Configuration (Optional)

The scanner auto-discovers skills via frontmatter. Config overrides are only needed when you want to:

- Force-load skills without frontmatter
- Override a scanned skill's priority
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
    "laravel": ["laravel-patterns"],
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
| `maxTokens` | 8000 | Token budget. Lower = fewer skills loaded |
| `scannerEnabled` | true | Auto-discover skills from frontmatter |
| `showToasts` | true | Show skill-change toasts in chat |
| `enableTools` | true | Enable `/context_routes` tool |
| `debug` | false | Log trigger evaluations to console |

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
| `/context_routes` | In-session skill dashboard |
