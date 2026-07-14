import { describe, it, expect } from "vitest";
import { Resolver } from "../src/resolver.js";
import type { PreloaderConfig } from "../src/config.js";
import type { ScannedSkillIndex } from "../src/scanner.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PreloaderConfig> = {}): PreloaderConfig {
  return {
    skills: [],
    fileTypeSkills: {},
    agentSkills: {},
    pathPatterns: {},
    contentTriggers: {},
    groups: {},
    skillSettings: {},
    skillLocations: [],
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
    ...overrides,
  };
}

function makeScannedIndex(entries: ScannedSkillIndex): ScannedSkillIndex {
  return entries;
}

// ── File Triggers ─────────────────────────────────────────────────────────

describe("Resolver — file triggers", () => {
  it("matches by extension from config", () => {
    const r = new Resolver(makeConfig({
      fileTypeSkills: { ".php": ["php-conventions"] },
    }));
    expect(r.resolveFileTriggers("/project/src/User.php")).toEqual(["php-conventions"]);
  });

  it("matches extension without leading dot", () => {
    const r = new Resolver(makeConfig({
      fileTypeSkills: { php: ["php-conventions"] },
    }));
    expect(r.resolveFileTriggers("/project/src/User.php")).toEqual(["php-conventions"]);
  });

  it("matches by path pattern from config", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "src/Models/**": ["model-rules"] },
    }));
    expect(r.resolveFileTriggers("/project/src/Models/User.php")).toContain("model-rules");
  });

  it("returns empty for no match", () => {
    const r = new Resolver(makeConfig());
    expect(r.resolveFileTriggers("/project/README.md")).toEqual([]);
  });

  it("ignores paths matching triggerIgnoreTags", () => {
    const r = new Resolver(makeConfig({
      fileTypeSkills: { ".php": ["php-conventions"] },
    }));
    expect(r.resolveFileTriggers("/project/node_modules/pkg/index.php")).toEqual([]);
  });

  it("normalizes Windows backslashes for path matching", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "src/Models/**": ["model-rules"] },
    }));
    expect(r.resolveFileTriggers("C:\\project\\src\\Models\\User.php")).toContain("model-rules");
  });

  it("matches multiple triggers on same file", () => {
    const r = new Resolver(makeConfig({
      fileTypeSkills: { ".php": ["php-conventions"] },
      pathPatterns: { "src/Models/**": ["model-rules"] },
    }));
    const result = r.resolveFileTriggers("/project/src/Models/User.php");
    expect(result).toContain("php-conventions");
    expect(result).toContain("model-rules");
  });

  it("matches from scanned index", () => {
    const scanned = new Map();
    scanned.set("my-skill", {
      name: "my-skill",
      filePath: "/skills/my-skill/SKILL.md",
      triggers: { extensions: [".vue"] },
    });
    const r = new Resolver(makeConfig(), scanned);
    expect(r.resolveFileTriggers("/project/src/App.vue")).toContain("my-skill");
  });

  it("scanned extension triggers are case-insensitive", () => {
    const scanned = new Map();
    scanned.set("ts-rules", {
      name: "ts-rules",
      filePath: "/skills/ts-rules/SKILL.md",
      triggers: { extensions: [".ts"] },
    });
    const r = new Resolver(makeConfig(), scanned);
    expect(r.resolveFileTriggers("/project/src/app.TS")).toContain("ts-rules");
  });
});

// ── Agent Triggers ────────────────────────────────────────────────────────

describe("Resolver — agent triggers", () => {
  it("matches agent name from config", () => {
    const r = new Resolver(makeConfig({
      agentSkills: { "coder-lite": ["coding-conventions"] },
    }));
    expect(r.resolveAgentTriggers("coder-lite")).toContain("coding-conventions");
  });

  it("matches agent name from scanned index", () => {
    const scanned = new Map();
    scanned.set("debug-rules", {
      name: "debug-rules",
      filePath: "/skills/debug/SKILL.md",
      triggers: { agents: ["debugger", "debugger-lite"] },
    });
    const r = new Resolver(makeConfig(), scanned);
    expect(r.resolveAgentTriggers("debugger-lite")).toContain("debug-rules");
  });

  it("returns empty for unknown agent", () => {
    const r = new Resolver(makeConfig());
    expect(r.resolveAgentTriggers("unknown")).toEqual([]);
  });
});

// ── Keyword Triggers ──────────────────────────────────────────────────────

describe("Resolver — keyword triggers", () => {
  it("matches keyword from config as substring", () => {
    const r = new Resolver(makeConfig({
      contentTriggers: { migration: ["migration-rules"] },
    }));
    expect(r.resolveMessageTriggers("create a migration for users")).toContain("migration-rules");
  });

  it("matches keyword as regex from config", () => {
    const r = new Resolver(makeConfig({
      contentTriggers: { "\\bcreate\\b": ["creation-rules"] },
    }));
    expect(r.resolveMessageTriggers("please create a model")).toContain("creation-rules");
  });

  it("regex failure falls back to substring", () => {
    // contentTriggers with invalid regex should fall back
    const r = new Resolver(makeConfig({
      contentTriggers: { "[invalid": ["fallback-skill"] },
    }));
    expect(r.resolveMessageTriggers("this is [invalid pattern")).toContain("fallback-skill");
  });

  it("matches keyword from scanned index", () => {
    const scanned = new Map();
    scanned.set("controller-rules", {
      name: "controller-rules",
      filePath: "/skills/controller/SKILL.md",
      triggers: { keywords: ["controller"] },
    });
    const r = new Resolver(makeConfig(), scanned);
    expect(r.resolveMessageTriggers("create the controller")).toContain("controller-rules");
  });

  it("is case-insensitive for scanned keywords", () => {
    const scanned = new Map();
    scanned.set("controller-rules", {
      name: "controller-rules",
      filePath: "/skills/controller/SKILL.md",
      triggers: { keywords: ["Controller"] },
    });
    const r = new Resolver(makeConfig(), scanned);
    expect(r.resolveMessageTriggers("create a controller")).toContain("controller-rules");
  });

  it("returns empty for no keyword match", () => {
    const r = new Resolver(makeConfig());
    expect(r.resolveMessageTriggers("hello world")).toEqual([]);
  });

  it("matches multiple keywords to different skills", () => {
    const r = new Resolver(makeConfig({
      contentTriggers: {
        migration: ["migration-rules"],
        controller: ["controller-rules"],
      },
    }));
    const result = r.resolveMessageTriggers("create a migration and controller");
    expect(result).toContain("migration-rules");
    expect(result).toContain("controller-rules");
  });
});

// ── Always-On Skills ──────────────────────────────────────────────────────

describe("Resolver — always-on skills", () => {
  it("returns skills with always:true from config skillSettings", () => {
    const r = new Resolver(makeConfig({
      skillSettings: { "always-rules": { always: true } },
    }));
    expect(r.getAlwaysOnSkills()).toContain("always-rules");
  });

  it("returns skills with always:true from scanned index", () => {
    const scanned = new Map();
    scanned.set("always-skill", {
      name: "always-skill",
      filePath: "/skills/always/SKILL.md",
      triggers: {},
      always: true,
    });
    const r = new Resolver(makeConfig(), scanned);
    expect(r.getAlwaysOnSkills()).toContain("always-skill");
  });
});

// ── Priority Resolution ───────────────────────────────────────────────────

describe("Resolver — priority", () => {
  it("default priority is 5", () => {
    const r = new Resolver(makeConfig());
    expect(r.resolvePriority("unknown")).toBe(5);
  });

  it("config priority overrides scanned priority", () => {
    const scanned = new Map();
    scanned.set("my-skill", {
      name: "my-skill",
      filePath: "/skills/my/SKILL.md",
      triggers: {},
      priority: 3,
    });
    const r = new Resolver(
      makeConfig({ priority: { "my-skill": 10 } }),
      scanned,
    );
    expect(r.resolvePriority("my-skill")).toBe(10);
  });

  it("skillSettings priority overrides default but not config priority", () => {
    const r = new Resolver(makeConfig({
      skillSettings: { "my-skill": { priority: 7 } },
      priority: { "my-skill": 10 },
    }));
    // priority map wins over skillSettings
    expect(r.resolvePriority("my-skill")).toBe(10);
  });

  it("scanned priority used when no config override", () => {
    const scanned = new Map();
    scanned.set("scanned-skill", {
      name: "scanned-skill",
      filePath: "/skills/s/SKILL.md",
      triggers: {},
      priority: 9,
    });
    const r = new Resolver(makeConfig(), scanned);
    expect(r.resolvePriority("scanned-skill")).toBe(9);
  });

  it("sortByPriority sorts descending", () => {
    const r = new Resolver(makeConfig({
      priority: { a: 1, b: 5, c: 10 },
    }));
    expect(r.sortByPriority(["a", "b", "c"])).toEqual(["c", "b", "a"]);
  });

  it("sortByPriority deduplicates", () => {
    const r = new Resolver(makeConfig({
      priority: { a: 5, b: 3 },
    }));
    expect(r.sortByPriority(["a", "b", "a", "b"])).toEqual(["a", "b"]);
  });

  it("sortByPriority breaks ties alphabetically", () => {
    const r = new Resolver(makeConfig({
      priority: { zed: 5, alpha: 5, beta: 5 },
    }));
    expect(r.sortByPriority(["zed", "beta", "alpha"])).toEqual(["alpha", "beta", "zed"]);
  });
});

// ── Group Expansion ───────────────────────────────────────────────────────

describe("Resolver — group expansion", () => {
  it("expands config group key into member skills", () => {
    const r = new Resolver(makeConfig({
      groups: { "laravel-stack": ["php", "migration", "model"] },
    }));
    expect(r.expandGroups(["laravel-stack"])).toContain("php");
    expect(r.expandGroups(["laravel-stack"])).toContain("migration");
  });

  it("preserves original names plus expansion", () => {
    const r = new Resolver(makeConfig({
      groups: { "full-stack": ["fe", "be"] },
    }));
    const result = r.expandGroups(["full-stack", "extra"]);
    expect(result).toContain("full-stack");
    expect(result).toContain("fe");
    expect(result).toContain("be");
    expect(result).toContain("extra");
  });

  it("expands frontmatter group membership to siblings", () => {
    const scanned = new Map();
    scanned.set("migration-rules", {
      name: "migration-rules",
      filePath: "/skills/m/SKILL.md",
      triggers: {},
      groups: ["laravel-stack"],
    });
    const r = new Resolver(
      makeConfig({ groups: { "laravel-stack": ["php", "model", "controller"] } }),
      scanned,
    );
    const result = r.expandGroups(["migration-rules"]);
    expect(result).toContain("migration-rules");
    expect(result).toContain("php");
    expect(result).toContain("model");
    expect(result).toContain("controller");
  });

  it("nested groups expand up to 3 levels", () => {
    const r = new Resolver(makeConfig({
      groups: {
        core: ["php"],
        stack: ["core", "migration"],
        full: ["stack", "vue"],
      },
    }));
    // "full" → ["stack", "vue"] → ["core", "migration", "vue"] → ["php", "migration", "vue"]
    const result = r.expandGroups(["full"]);
    expect(result).toContain("php");
    expect(result).toContain("migration");
    expect(result).toContain("vue");
    expect(result).toContain("stack");
    expect(result).toContain("core");
  });

  it("no infinite loop on circular group reference", () => {
    const r = new Resolver(makeConfig({
      groups: {
        a: ["b"],
        b: ["c"],
        c: ["a"], // circular
      },
    }));
    const result = r.expandGroups(["a"]);
    // Should terminate after 3 passes, no infinite loop
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).toContain("c");
    expect(result).toHaveLength(3);
  });

  it("group name wins over skill with same name", () => {
    const r = new Resolver(makeConfig({
      groups: { "my-group": ["skill-a"] },
    }));
    // "my-group" is a group, not a skill — it should expand
    expect(r.expandGroups(["my-group"])).toContain("skill-a");
  });
});

// ── Glob Matching (internal) ──────────────────────────────────────────────

describe("Resolver — glob matching (via path pattern resolution)", () => {
  it("matches **/ prefix pattern", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "**/Controllers/**": ["ctrl-rules"] },
    }));
    expect(r.resolveFileTriggers("/project/src/Controllers/UserController.php")).toContain("ctrl-rules");
  });

  it("matches /** suffix pattern", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "src/Controllers/**": ["ctrl-rules"] },
    }));
    expect(r.resolveFileTriggers("/project/src/Controllers/UserController.php")).toContain("ctrl-rules");
  });

  it("matches single * wildcard", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "src/*/User.php": ["user-rules"] },
    }));
    expect(r.resolveFileTriggers("/project/src/Models/User.php")).toContain("user-rules");
  });

  it("does not match single * across path separators", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "src/*.php": ["php-rules"] },
    }));
    expect(r.resolveFileTriggers("/project/src/sub/file.php")).not.toContain("php-rules");
  });

  it("matches by directory prefix (pattern ending in /)", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "database/migrations/": ["mig-rules"] },
    }));
    expect(r.resolveFileTriggers("/project/database/migrations/2024_01_01_create_users_table.php")).toContain("mig-rules");
  });

  it("matches by contains (no wildcard)", () => {
    const r = new Resolver(makeConfig({
      pathPatterns: { "User.php": ["user-rules"] },
    }));
    expect(r.resolveFileTriggers("/project/src/Models/User.php")).toContain("user-rules");
  });
});
