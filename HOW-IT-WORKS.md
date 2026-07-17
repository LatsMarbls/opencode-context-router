# How Context Routing Works

The LLM API is **always stateless** — every call is one-shot with a `messages` array. This plugin doesn't change that. It enriches the **context that goes into** each stateless call.

- [Without Plugin: Each Prompt Is Isolated](#without-plugin-generic-responses)
- [With Plugin: Project-Aware Responses](#with-plugin-project-aware-responses)
- [The 4 Trigger Dimensions](#the-4-trigger-dimensions)
- [Where "State" Lives](#where-state-lives)
- [Architecture: New Flow](#architecture-new-flow)

---

## Without Plugin — Generic Responses

Every API call only knows about `AGENTS.md` + conversation history. Project conventions are absent, so the LLM guesses generic patterns. You have to correct it repeatedly.

```
─── PROMPT 1: "create a migration for users table" ─────────────────────
▶ API CALL (stateless):
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: "AGENTS.md instructions" },
    { role: "user", content: "create a migration for users table" }
  ]
}
◀ RESPONSE:
    Schema::create('users', function ($table) {
        $table->id();
        $table->string('name');
        $table->timestamps();
    });
    // Generic. No snake_case. No PiaCore conventions.

─── PROMPT 2: "now create the User model" ─────────────────────────────
▶ API CALL (stateless):
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: "AGENTS.md instructions" },
    { role: "assistant", content: "Schema::create('users', ...);" },
    { role: "user", content: "now create the User model" }
  ]
}
◀ RESPONSE:
    class User extends Model {
        use HasFactory;
    }
    // Generic. No HasTimestamps. No HasArchives. No trait pattern.

─── PROMPT 3: "create the controller" ───────────────────────────────
▶ API CALL (stateless):
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: "AGENTS.md instructions" },
    ...  // 3 messages deep now
    { role: "user", content: "create the controller" }
  ]
}
◀ RESPONSE:
    class UserController extends Controller {
        public function index() { return User::all(); }
    }
    // Wrong base class (Controller vs ResourceController).
    // No service layer. No action classes.

─── PROMPT 4: "add validation rules" ─────────────────────────────────
▶ API CALL (stateless):
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: "AGENTS.md instructions" },
    ...  // 4 messages deep — context getting tight
    { role: "user", content: "add validation rules" }
  ]
}
◀ RESPONSE:
    $request->validate(['name' => 'required']);
    // Inline validation. Should be a FormRequest class.
```

**Net result** — every response is generic, project-agnostic, and you'll spend turns correcting the LLM.

---

## With Plugin — Project-Aware Responses

The plugin fires on `chat.message`, evaluates all 4 trigger dimensions, loads relevant skills, and injects them into the system prompt. The API remains stateless; the input is just richer.

```
─── PROMPT 1: "create a migration for users table" ─────────────────────
▶ PLUGIN EVALUATES (chat.message hook):
   Trigger matches: keyword "migration", keyword "table"
   Queued skills:  [migration-rules (prio 10), php-conventions (prio 5)]

▶ API CALL (same stateless endpoint, enriched system prompt):
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<context-routes-loaded>
       The following skills are already loaded in this system prompt:
       migration-rules, php-conventions
       Do NOT use the skill tool to load them again.
       </context-routes-loaded>",

      "<context-route name='migration-rules'>
       - Use Schema::create() not DB::statement()
       - Always add ->index() on foreign key columns
       - Table names are snake_case plural (pia_users, role_permissions)
       - Use ->timestamps() for created_at/updated_at
       </context-route>",

      "<context-route name='php-conventions'>
       - Namespace: App\\Models, App\\Http\\Controllers, etc.
       - PSR-4 autoloading
       - Type hints on all method signatures
       </context-route>"
    ]},
    { role: "user", content: "create a migration for users table" }
  ]
}
◀ RESPONSE:
    Schema::create('pia_users', function ($table) {
        $table->id();
        $table->string('name');
        $table->foreignId('role_id')->constrained()->index();
        $table->timestamps();
    });
    // All conventions followed. No corrections needed.

─── PROMPT 2: "now create the User model" ─────────────────────────────
▶ PLUGIN EVALUATES (chat.message hook):
   Trigger matches: keyword "model", path src/Models/**
   Loaded skills:  [model-rules (prio 7), model-trait-rules (prio 5)]
   Session carries: [php-conventions, migration-rules] (deduped by content hash)

▶ API CALL:
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<context-routes-loaded>
       The following skills are already loaded in this system prompt:
       model-rules, model-trait-rules, php-conventions, migration-rules
       </context-routes-loaded>",

      "<context-route name='model-rules'>...</context-route>",
      "<context-route name='model-trait-rules'>...</context-route>",
      "<context-route name='php-conventions'>...</context-route>",
      "<context-route name='migration-rules'>...</context-route>"
    ]},
    { role: "assistant", content: "Schema::create('pia_users', ...)" },
    { role: "user", content: "now create the User model" }
  ]
}
◀ RESPONSE:
    class User extends Model {
        use HasFactory, HasTimestamps, HasSlug;

        protected $table = 'pia_users';
        protected $fillable = ['name', 'role_id'];

        public function role(): BelongsTo
        {
            return $this->belongsTo(Role::class);
        }
    }
    // Correct trait pattern. Correct table name. Relationship defined.

─── PROMPT 3: "create the controller" ───────────────────────────────
▶ PLUGIN EVALUATES (chat.message hook):
   Trigger matches: keyword "controller", path src/Controllers/**
   Loaded skills:  [controller-rules (prio 7), crud-rules (prio 9)]
   Session carries: [php-conventions] (others dropped by budget / not relevant)

▶ API CALL:
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<context-routes-loaded>controller-rules, crud-rules, php-conventions</context-routes-loaded>",

      "<context-route name='controller-rules'>...</context-route>",
      "<context-route name='crud-rules'>...</context-route>",
      "<context-route name='php-conventions'>...</context-route>"
    ]},
    ...
    { role: "user", content: "create the controller" }
  ]
}
◀ RESPONSE:
    class UserController extends ResourceController {
        use HasActivityLogs;

        public function index(): Response
        {
            return UserService::index();
        }

        public function store(StoreUserRequest $request): Response
        {
            return CreateUserAction::run($request->validated());
        }
    }
    // Correct base class. Service layer. Action class. FormRequest injected.

─── PROMPT 4: "add validation rules" ─────────────────────────────────
▶ PLUGIN EVALUATES (chat.message hook):
   SessionManager persisted request-rules through compaction.
   Loaded skills:  [request-rules]
   Session carries: [php-conventions]

▶ API CALL:
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<context-routes-loaded>request-rules, php-conventions</context-routes-loaded>",

      "<context-route name='request-rules'>...</context-route>",
      "<context-route name='php-conventions'>...</context-route>"
    ]},
    ...
    { role: "user", content: "add validation rules" }
  ]
}
◀ RESPONSE:
    class StoreUserRequest extends BaseFormRequest {
        public function authorize(): bool
        {
            return auth()->check();
        }

        public function rules(): array
        {
            return [
                'name'     => ['required', 'string', 'max:255'],
                'email'    => ['required', 'email', 'unique:pia_users,email'],
                'role_id'  => ['required', 'exists:roles,id'],
            ];
        }

        public function messages(): array
        {
            return [
                'name.required' => 'The name field is required.',
                'email.unique'  => 'This email is already taken.',
            ];
        }
    }
    // FormRequest class. Not inline. Correct base class. Authorization check.
```

---

## What Changes Between Turns

**Without plugin:** Only conversation history grows. System prompt stays the same every turn.

```
Turn 1 (migration):   system = [AGENTS.md]
Turn 2 (model):       system = [AGENTS.md] (same)
Turn 3 (controller):  system = [AGENTS.md] (same)
Turn 4 (validation):  system = [AGENTS.md] (same — but now competing with 4 turns of history)
```

**With plugin:** System prompt is **re-evaluated every turn**. Each API call gets the skills relevant to *that step*. The plugin never calls the LLM itself — it only enriches what goes *into* each stateless call.

```
Turn 1 (migration):   system = [AGENTS.md + migration-rules + php-conventions]
Turn 2 (model):       system = [AGENTS.md + model-rules + model-trait-rules + php-conventions + migration-rules]
Turn 3 (controller):  system = [AGENTS.md + controller-rules + crud-rules + php-conventions]
Turn 4 (validation):  system = [AGENTS.md + request-rules + php-conventions]
```

---

## The 4 Trigger Dimensions

| # | Trigger | Example Match | Loads |
|---|---------|---------------|-------|
| 1 | **File extension** | `.php` → php-conventions | Extension-based conventions |
| 2 | **Path patterns** | `src/Controllers/**` → controller-rules | Layer-specific rules |
| 3 | **Agent name** | Agent is `coder-lite` → be+fe conventions | Role-appropriate context |
| 4 | **Keywords** | Message contains "migration" → migration-rules | Intent-matched skills |

**All trigger resolution happens synchronously in `chat.message`:**
- At init: scanner discovers skill files with YAML frontmatter and registers their declared triggers (and group memberships, priorities)
- At runtime: file paths are extracted from user message text (e.g., `src/Models/User.php`) and matched against extension and path triggers

**Group expansion:** when a trigger resolves to a group name (e.g., `laravel-stack`), all skills with `groups: ["laravel-stack"]` in frontmatter load. Up to 3 levels of nesting.

---

## Skill File Discovery (Scanner)

Skill files can declare their own triggers via YAML frontmatter — no need to manually configure every skill in the config file:

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

The scanner runs at init when `scannerEnabled: true` (default), reads all `.md` files in configured `skillLocations`, and registers them automatically.

**Scan cache:** parsed frontmatter is cached at `~/.config/opencode/plugins/context-routing/scan-cache.json`. Subsequent runs skip files whose mtime + size haven't changed. Cold scan ~35ms for 50 skills → warm scan ~25ms (1.4x speedup). Cache invalidates on `skillLocations` change, on file mtime/size change, or manually by deleting the file.

Config-file triggers still work — and override scanned triggers for the same skill name.

---

## Where "State" Lives

| Layer | Has Memory? | What It Holds |
|-------|-------------|----------------|
| **LLM API call** | ❌ No — one-shot, no history between calls | Nothing |
| **Plugin SessionManager** | ✅ Yes — per-session cache | Active skills (deduped by content hash), priority ranking, current budget, dropped skills |
| **Scan cache** | ✅ Yes — disk file (scan-cache.json) | Per-project frontmatter cache, invalidated by mtime/size |
| **Compaction survival** | ✅ Yes — persists across context trims | Skill summaries written into `output.context[]` survive OpenCode's token trimming |
| **System prompt injection** | ❌ No — every API call gets fresh injection | The enriched prompt exists only for that one call |

### Data Flow

```
User types message (text + file paths)
       │
       ▼
┌──────────────────────────────────────────────────┐
│  HOOK 1: chat.message                             │
│  • Reset per-turn injection dedup Set             │
│  • Check for global reload signal file           │
│  • Extract message text from output.parts         │
│  • Resolver evaluates all 4 triggers:             │
│    - Agent name → agentSkills                    │
│    - Message text keywords → contentTriggers      │
│    - File paths in message → fileTypeSkills       │
│    - File paths in message → pathPatterns         │
│    - Always-on skills from skillSettings          │
│  • Expand group names → member skills            │
│  • Load new skills (loader reads from disk)      │
│  • Dedup against active set                      │
│  • Queue + flush to active                       │
│  • If injectionMethod === chatMessage: inject    │
│    as new system message in output.parts         │
└──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│  HOOK 2: system.transform               │
│  • If injectionMethod !== systemPrompt: │
│    skip (chatMessage already injected)  │
│  • Flush pending to active              │
│  • filterNewForInjection (content-hash   │
│    Set) returns new skills only         │
│  • Push <context-route> blocks to       │
│    output.system via .push()            │
└─────────────────────────────────────────┘
       │
       ▼
OpenCode builds API payload with enriched system prompt
       │
       ▼
LLM API — one-shot, stateless — returns project-aware response
       │
       ▼
┌─────────────────────────────────────────┐
│  HOOK 3: session.compacting (if fires)  │
│  Persist skill summaries into          │
│  output.context[] to survive trim       │
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│  HOOK 4: event (file.watcher.updated)   │
│  • Project config changed → full        │
│    reload (config + re-scan)           │
│  • Project skill file changed →         │
│    invalidate loader cache + re-scan   │
└─────────────────────────────────────────┘
```

The plugin is a **context assembler**, not an LLM caller. It looks at what you're doing, figures out which skills are relevant, and injects them into the API call's system prompt. The API call itself remains fully stateless.

---

## Why chat.message + system.transform (not messages.transform)?

In the original design, `experimental.chat.messages.transform` did the resolution + injection. The problem: OpenCode's hook invocation order between `messages.transform` and `system.transform` is undocumented. If `system.transform` fired first, skills resolved in `messages.transform` never got injected that turn.

**Fix:** moved resolution to `chat.message`, which fires before both transform hooks. `chat.message` has access to `output.parts` (the message text), so it can resolve triggers and load skills. Then `system.transform` just injects from the active skill set.

Result: same-turn visibility, every turn, regardless of internal hook order.

---

## Token Budget Enforcement

The plugin enforces a token budget (default 8,000) on the system prompt. When active skills exceed the budget, lowest-priority skills drop.

**Token count:** uses `gpt-tokenizer` (cl100k_base encoding) for accurate counting. Replaces the old `chars/4` heuristic. ~0.01ms per 1KB.

**Budget calculation:**
- Iterate active skills sorted by priority descending
- Sum tokens (BPE-encoded)
- When sum + next skill tokens > budget, drop next skill
- Track dropped for the dashboard (`/context_routes` shows them)

**Skill priority tiers:**
- Project-local `{project}/.opencode/`: implicit 100
- User-global `{user}/.config/opencode/`: implicit 75
- Config `priority` map: explicit per-skill
- Default: 5

**When `accumulateSkills: false`:** the injection dedup Set clears each turn. Skills that were active previously are NOT carried over. The injection hash Set is cleared at `chat.message` so the same skills re-inject each turn (not skipped as duplicates).
