import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted() — creates mocks before vi.mock factories ───────────────────

const mockQueueSkills = vi.hoisted(() => vi.fn());
const mockFlushPending = vi.hoisted(() => vi.fn());
const mockGetFormattedSkills = vi.hoisted(() => vi.fn());
const mockGetActiveSkills = vi.hoisted(() => vi.fn());
const mockHasSkill = vi.hoisted(() => vi.fn());
const mockGetBudgetStatus = vi.hoisted(() => vi.fn());
const mockGetSkillsSummary = vi.hoisted(() => vi.fn());
const mockDeleteSession = vi.hoisted(() => vi.fn());
const mockLoadStaticSkill = vi.hoisted(() => vi.fn());

const mockResolveFileTriggers = vi.hoisted(() => vi.fn());
const mockResolveAgentTriggers = vi.hoisted(() => vi.fn());
const mockResolveMessageTriggers = vi.hoisted(() => vi.fn());
const mockGetAlwaysOnSkills = vi.hoisted(() => vi.fn());

// ── Default mock config (hoisted so vi.mock can use it) ─────────────────────

const DEFAULT_MOCK_CONFIG = vi.hoisted(() => ({
  skills: [],
  fileTypeSkills: {},
  agentSkills: {},
  pathPatterns: {},
  contentTriggers: {},
  groups: {},
  skillSettings: {},
  skillLocations: ["{project}/skills/{name}/SKILL.md"],
  triggerIgnoreTags: ["node_modules", ".git", "vendor"],
  injectionMethod: "systemPrompt" as const,
  maxTokens: 8000,
  useSummaries: false,
  useMinification: false as const,
  showToasts: false,
  enableTools: true,
  analytics: false,
  persistAfterCompaction: true,
  scannerEnabled: true,
  debug: false,
  priority: {},
}));

// ── Manual mock factories ───────────────────────────────────────────────────

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => ({ ...DEFAULT_MOCK_CONFIG })),
}));

vi.mock("../src/scanner.js", () => ({
  scanSkillFiles: vi.fn(() => new Map()),
}));

// CRITICAL: Use regular functions (not arrow) so `new` works
vi.mock("../src/loader.js", () => ({
  SkillLoader: function() { return { loadStaticSkill: mockLoadStaticSkill }; },
}));

vi.mock("../src/resolver.js", () => ({
  Resolver: function() {
    return {
      resolveFileTriggers: mockResolveFileTriggers,
      resolveAgentTriggers: mockResolveAgentTriggers,
      resolveMessageTriggers: mockResolveMessageTriggers,
      expandGroups: vi.fn((names: string[]) => names),
      getAlwaysOnSkills: mockGetAlwaysOnSkills,
    };
  },
}));

vi.mock("../src/session.js", () => ({
  getOrCreateSession: vi.fn(() => ({
    queueSkills: mockQueueSkills,
    flushPending: mockFlushPending,
    getFormattedSkills: mockGetFormattedSkills,
    getActiveSkills: mockGetActiveSkills,
    hasSkill: mockHasSkill,
    getBudgetStatus: mockGetBudgetStatus,
    getSkillsSummary: mockGetSkillsSummary,
  })),
  deleteSession: mockDeleteSession,
}));

// Module under test
import plugin from "../src/index.js";
import { loadConfig } from "../src/config.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build mock config by merging overrides atop defaults. Prevents
 *  partial-object contamination that crashes later tests. */
function makeConfig(overrides: Partial<typeof DEFAULT_MOCK_CONFIG> = {}): typeof DEFAULT_MOCK_CONFIG {
  return { ...DEFAULT_MOCK_CONFIG, ...overrides };
}

function makeClient() {
  return { tui: { showToast: vi.fn() } };
}

function makeContext(sessionID = "test-session") {
  return { sessionID };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("plugin entry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns hooks object with expected keys", async () => {
    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    expect(hooks).toHaveProperty("chat.message");
    expect(hooks).toHaveProperty("experimental.chat.system.transform");
    expect(hooks).toHaveProperty("experimental.session.compacting");
    expect(hooks).toHaveProperty("event");
    expect(hooks).toHaveProperty("tool.execute.after");
    expect(hooks).toHaveProperty("tool");
    expect(hooks.tool).toHaveProperty("preload_skills");
  });

  it("loads config and scans skills on init", async () => {
    await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    expect(vi.mocked(loadConfig)).toHaveBeenCalledWith("/tmp/project");
  });
});

describe("chat.message hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default returns so .forEach doesn't crash on undefined
    mockResolveMessageTriggers.mockReturnValue([]);
    mockGetAlwaysOnSkills.mockReturnValue([]);
    mockHasSkill.mockReturnValue(false);
  });

  it("loads skills from agent triggers", async () => {
    mockResolveAgentTriggers.mockReturnValue(["php-rules"]);
    mockLoadStaticSkill.mockReturnValue({
      name: "php-rules", content: "# PHP", source: "static-file", priority: 5,
    });

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1", agent: "coder-lite" };
    const output = { parts: [{ type: "text", text: "fix the query" }] };
    await hooks["chat.message"]!(input as any, output as any);

    expect(mockQueueSkills).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "php-rules" })]),
      "chat.message",
    );
  });

  it("loads skills from content keyword triggers", async () => {
    mockResolveMessageTriggers.mockReturnValue(["migration-rules"]);
    mockLoadStaticSkill.mockReturnValue({
      name: "migration-rules", content: "# Migrations", source: "static-file", priority: 5,
    });

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1" };
    const output = { parts: ["create a migration table"] };
    await hooks["chat.message"]!(input as any, output as any);

    expect(mockQueueSkills).toHaveBeenCalled();
  });

  it("skips loading if skill is already active", async () => {
    mockResolveAgentTriggers.mockReturnValue(["php-rules"]);
    mockHasSkill.mockReturnValue(true);

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1", agent: "coder-lite" };
    const output = { parts: [] };
    await hooks["chat.message"]!(input as any, output as any);

    expect(mockLoadStaticSkill).not.toHaveBeenCalled();
    expect(mockQueueSkills).not.toHaveBeenCalled();
  });

  it("shows toast when showToasts is enabled", async () => {
    vi.mocked(loadConfig).mockReturnValueOnce(makeConfig({ showToasts: true }));
    mockResolveAgentTriggers.mockReturnValue(["php-rules"]);
    mockLoadStaticSkill.mockReturnValue({
      name: "php-rules", content: "# PHP", source: "static-file", priority: 5,
    });

    const client = makeClient();
    const hooks = await plugin({
      client: client as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1", agent: "coder-lite" };
    const output = { parts: [] };
    await hooks["chat.message"]!(input as any, output as any);

    expect(client.tui.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ variant: "info" }) }),
    );
  });
});

describe("system.transform hook", () => {
  beforeEach(() => vi.clearAllMocks());

  it("injects formatted skills into system prompt", async () => {
    mockGetFormattedSkills.mockReturnValue("## Loaded Skills\n- PHP rules\n- Vue rules\n");

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1" };
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(input as any, output as any);

    expect(mockFlushPending).toHaveBeenCalled();
    expect(output.system[0]).toContain("## Loaded Skills");
  });

  it("does nothing when no skills are formatted", async () => {
    mockGetFormattedSkills.mockReturnValue(null);

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1" };
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(input as any, output as any);

    expect(output.system).toHaveLength(0);
  });
});

describe("session.compacting hook", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds skill summary to compaction context", async () => {
    mockGetSkillsSummary.mockReturnValue("Active skills: php-rules, vue-rules");

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1" };
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!(input as any, output as any);

    expect(output.context).toContain("Active skills: php-rules, vue-rules");
  });

  it("skips when persistAfterCompaction is false", async () => {
    vi.mocked(loadConfig).mockReturnValueOnce(makeConfig({ persistAfterCompaction: false }));

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1" };
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!(input as any, output as any);

    expect(output.context).toHaveLength(0);
  });
});

describe("event hook", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cleans up session on session.deleted", async () => {
    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    await hooks.event!({
      event: { type: "session.deleted", properties: { info: { id: "sess-1" } } },
    } as any);

    expect(mockDeleteSession).toHaveBeenCalledWith("sess-1");
  });
});

describe("tool.execute.after hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset shared mock to clear stale returnValueOnce queue from chat tests
    mockLoadStaticSkill.mockReset();
    mockResolveFileTriggers.mockReset();
  });

  it("loads skills based on file path triggers", async () => {
    mockResolveFileTriggers.mockReturnValue(["php-rules", "laravel-rules"]);
    mockLoadStaticSkill
      .mockReturnValueOnce({
        name: "php-rules", content: "# PHP", source: "static-file", priority: 5,
      })
      .mockReturnValueOnce({
        name: "laravel-rules", content: "# Laravel", source: "static-file", priority: 5,
      });

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1", tool: "read", args: { path: "/project/src/User.php" } };
    const output = {};
    await hooks["tool.execute.after"]!(input as any, output as any);

    expect(mockQueueSkills).toHaveBeenCalled();
  });

  it("ignores files in triggerIgnoreTags", async () => {
    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = {
      sessionID: "sess-1",
      tool: "read",
      args: { path: "/project/node_modules/pkg/index.js" },
    };
    const output = {};
    await hooks["tool.execute.after"]!(input as any, output as any);

    expect(mockResolveFileTriggers).not.toHaveBeenCalled();
  });

  it("skips when path is missing from args", async () => {
    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const input = { sessionID: "sess-1", tool: "read", args: { file: "no-path-arg" } };
    const output = {};
    await hooks["tool.execute.after"]!(input as any, output as any);

    expect(mockResolveFileTriggers).not.toHaveBeenCalled();
  });
});

describe("preload_skills tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBudgetStatus.mockReturnValue({ used: 0, limit: 8000, loadedCount: 0, dropped: [] });
    mockGetActiveSkills.mockReturnValue([]);
  });

  it("returns budget info and empty state", async () => {
    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const result = await hooks.tool!.preload_skills.execute!({}, makeContext() as any);

    expect(result).toContain("Token Budget");
    expect(result).toContain("No skills preloaded");
  });

  it("returns active skills table when skills are loaded", async () => {
    mockGetActiveSkills.mockReturnValue([
      { name: "php-rules", content: "# PHP rules", source: "file", priority: 5 },
      { name: "vue-rules", content: "# Vue rules", source: "file", priority: 3 },
    ]);
    mockGetBudgetStatus.mockReturnValue({
      used: 100, limit: 8000, loadedCount: 2, dropped: [],
    });

    const hooks = await plugin({
      client: makeClient() as any,
      project: "test-project",
      directory: "/tmp/project",
    });

    const result = await hooks.tool!.preload_skills.execute!({}, makeContext() as any);

    expect(result).toContain("php-rules");
    expect(result).toContain("vue-rules");
    expect(result).toContain("2 skills");
  });
});
