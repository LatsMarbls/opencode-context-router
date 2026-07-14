# How Context Routing Works

The LLM API is **always stateless** — every call is one-shot with a `messages` array. This plugin doesn't change that. It enriches the **context that goes into** each stateless call.

- [Without Plugin: Each Prompt Is Isolated](#without-plugin-generic-responses)
- [With Plugin: Skills Injected Each Turn](#with-plugin-project-aware-responses)
- [The 4 Trigger Dimensions](#the-4-trigger-dimensions)
- [Where "State" Lives](#where-state-lives)

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

─── PROMPT 3: "create the controller" ────────────────────────────────
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

The plugin fires on `chat.message`, evaluates all 4 trigger dimensions, queued skills get injected into the **system prompt** of the next API call. The API remains stateless; the input is just richer.

```
─── PROMPT 1: "create a migration for users table" ─────────────────────
▶ PLUGIN EVALUATES:
   Trigger matches: keyword "migration", keyword "table"
   Queued skills:  [migration-rules (prio 10), php-conventions (prio 5)]

▶ API CALL (same stateless endpoint, enriched system prompt):
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<preloaded-skill name='migration-rules'>
       - Use Schema::create() not DB::statement()
       - Always add ->index() on foreign key columns
       - Table names are snake_case plural (pia_users, role_permissions)
       - Use ->timestamps() for created_at/updated_at
       </preloaded-skill>",

      "<preloaded-skill name='php-conventions'>
       - Namespace: App\\Models, App\\Http\\Controllers, etc.
       - PSR-4 autoloading
       - Type hints on all method signatures
       </preloaded-skill>"
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
▶ PLUGIN EVALUATES:
   Trigger matches: keyword "model", path src/Models/**
   Queued skills:  [model-rules (prio 7), model-trait-rules (prio 5),
                    php-conventions, migration-rules (from session)]

▶ API CALL:
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<preloaded-skill name='model-rules'>
       - Extend the base Model class
       - Use HasFactory trait
       - Table name derived from class name (snake_case plural)
       - $fillable or $guarded for mass assignment
       </preloaded-skill>",

      "<preloaded-skill name='model-trait-rules'>
       - PiaCore models use trait composition
       - Available: HasTimestamps, HasSlug, HasArchives, HasActivityLogs
       - Import via use App\\Models\\Traits\\HasTimestamps
       </preloaded-skill>",

      "<preloaded-skill name='php-conventions'>...</preloaded-skill>",
      "<preloaded-skill name='migration-rules'>...</preloaded-skill>"
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

─── PROMPT 3: "create the controller" ────────────────────────────────
▶ PLUGIN EVALUATES:
   Trigger matches: keyword "controller", path src/Controllers/**
   Queued skills:  [controller-rules (prio 7), crud-rules (prio 9),
                    php-conventions]

▶ API CALL:
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<preloaded-skill name='controller-rules'>
       - Extend ResourceController, not Controller
       - Methods: index, show, create, store, edit, update, destroy
       - Return Response or JsonResponse types
       </preloaded-skill>",

      "<preloaded-skill name='crud-rules'>
       - PiaCore uses Action classes per SCEUDRIX flag
       - ShowUserAction, CreateUserAction, EditUserAction, etc.
       - Actions are in App\\Actions\\User namespace
       </preloaded-skill>",

      "<preloaded-skill name='php-conventions'>...</preloaded-skill>"
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
▶ PLUGIN EVALUATES:
   SessionManager persisted request-rules through compaction.
   Queued skills:  [request-rules (from compaction), php-conventions]

▶ API CALL:
{
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: [
      "AGENTS.md instructions",

      "<preloaded-skill name='request-rules'>
       - Extend BaseFormRequest, not FormRequest
       - Validation rules in rules() method
       - Authorize in authorize() method
       - Custom error messages in messages() method
       </preloaded-skill>",

      "<preloaded-skill name='php-conventions'>...</preloaded-skill>"
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

**With plugin:** System prompt is **re-evaluated every turn**. Each API call gets the skills relevant to *that step*.

```
Turn 1 (migration):   system = [AGENTS.md + migration-rules + php-conventions]
Turn 2 (model):       system = [AGENTS.md + model-rules + model-trait-rules + php-conventions + migration-rules]
Turn 3 (controller):  system = [AGENTS.md + controller-rules + crud-rules + php-conventions]
Turn 4 (validation):  system = [AGENTS.md + request-rules + php-conventions]
```

The plugin never calls the LLM itself. It only enriches what goes *into* the next stateless call.

---

## The 4 Trigger Dimensions

| # | Trigger | Example Match | Loads |
|---|---------|---------------|-------|
| 1 | **File extension** | `.php` → php-conventions | Extension-based conventions |
| 2 | **Path patterns** | `src/Controllers/**` → controller-rules | Layer-specific rules |
| 3 | **Agent name** | Agent is `coder-lite` → be+fe conventions | Role-appropriate context |
| 4 | **Keywords** | Message contains "migration" → migration-rules | Intent-matched skills |

---

## Where "State" Lives

| Layer | Has Memory? | What It Holds |
|-------|-------------|---------------|
| **LLM API call** | ❌ No — one-shot, no history between calls | Nothing |
| **Plugin SessionManager** | ✅ Yes — per-session cache | Which skills are loaded, priority ranking, current budget, dropped skills |
| **Compaction survival** | ✅ Yes — persists across context trims | Skill summaries written into `output.context[]` survive OpenCode's token trimming |
| **System prompt injection** | ❌ No — every API call gets fresh injection | The enriched prompt exists only for that one call |

### Data Flow

```
User types message
       │
       ▼
┌─────────────────────────────────────────┐
│  HOOK 1: chat.message                   │
│  Evaluates 4 trigger dimensions         │
│  SessionManager queues matched skills   │
│  Subject to priority budget (maxTokens) │
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│  HOOK 2: system.transform               │
│  Flushes pending skills into            │
│  output.system[] via .push() (in-place) │
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
│  Persists skill summaries into          │
│  output.context[] to survive trim       │
└─────────────────────────────────────────┘
```

The plugin is a **context assembler**, not an LLM caller. It looks at what you're doing, figures out which skills are relevant, and injects them into the next API call's system prompt. The API call itself remains fully stateless.
