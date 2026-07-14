import { describe, it, expect } from "vitest";
import { scanSkillFiles } from "../src/scanner.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PreloaderConfig } from "./config.js";

// ── Helper ────────────────────────────────────────────────────────────────

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
    triggerIgnoreTags: [],
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

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "context-router-test-"));
}

// ── Scanner Tests ─────────────────────────────────────────────────────────

describe("scanSkillFiles", () => {
  it("returns empty index when no skill files exist", () => {
    const projectDir = createTempProject();
    const cfg = makeConfig({
      skillLocations: ["{project}/.opencode/skills/{name}/SKILL.md"],
    });
    const index = scanSkillFiles(cfg, projectDir);
    expect(index.size).toBe(0);
  });

  it("discovers skills from dir-based layout with frontmatter", () => {
    const projectDir = createTempProject();
    const skillDir = join(projectDir, ".opencode", "skills", "php-rules");
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: php-rules
triggers:
  extensions: [".php"]
  keywords: ["php"]
priority: 8
---

# PHP Rules
- Use type hints
`,
    );

    const cfg = makeConfig({
      skillLocations: ["{project}/.opencode/skills/{name}/SKILL.md"],
    });
    const index = scanSkillFiles(cfg, projectDir);

    expect(index.size).toBe(1);
    expect(index.has("php-rules")).toBe(true);

    const meta = index.get("php-rules")!;
    expect(meta.name).toBe("php-rules");
    expect(meta.triggers.extensions).toEqual([".php"]);
    expect(meta.triggers.keywords).toEqual(["php"]);
    expect(meta.priority).toBe(8);
    expect(meta.always).toBeUndefined();
  });

  it("discovers skills from file-based (agent) layout", () => {
    const projectDir = createTempProject();
    const agentDir = join(projectDir, ".opencode", "agent");
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, "debug-rules.md"),
      `---
name: debug-rules
triggers:
  agents: ["debugger", "debugger-lite"]
priority: 7
---

# Debug Rules
`,
    );

    const cfg = makeConfig({
      skillLocations: ["{project}/.opencode/agent/{name}.md"],
    });
    const index = scanSkillFiles(cfg, projectDir);

    expect(index.size).toBe(1);
    expect(index.has("debug-rules")).toBe(true);
    expect(index.get("debug-rules")!.triggers.agents).toContain("debugger-lite");
  });

  it("parses always and groups from frontmatter", () => {
    const projectDir = createTempProject();
    const skillDir = join(projectDir, "skills", "always-skill");
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: always-skill
always: true
groups: ["core", "security"]
---

# Always
`,
    );

    const cfg = makeConfig({
      skillLocations: ["{project}/skills/{name}/SKILL.md"],
    });
    const index = scanSkillFiles(cfg, projectDir);

    const meta = index.get("always-skill")!;
    expect(meta.always).toBe(true);
    expect(meta.groups).toEqual(["core", "security"]);
  });

  it("uses filename as name when frontmatter has no name", () => {
    const projectDir = createTempProject();
    const agentDir = join(projectDir, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, "my-skill.md"),
      `---
triggers:
  keywords: ["test"]
---
`,
    );

    const cfg = makeConfig({
      skillLocations: ["{project}/agent/{name}.md"],
    });
    const index = scanSkillFiles(cfg, projectDir);

    expect(index.has("my-skill")).toBe(true);
  });

  it("skips files without frontmatter (no --- delimiter)", () => {
    const projectDir = createTempProject();
    const agentDir = join(projectDir, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(join(agentDir, "plain.md"), "# Just a heading\nNo frontmatter here.");

    const cfg = makeConfig({
      skillLocations: ["{project}/agent/{name}.md"],
    });
    const index = scanSkillFiles(cfg, projectDir);
    expect(index.size).toBe(0);
  });

  it("first location wins — deduplicates by name", () => {
    const projectDir = createTempProject();

    // Two locations with same skill name
    const dir1 = join(projectDir, "skills", "dup");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(
      join(dir1, "SKILL.md"),
      `---\nname: dup-skill\ntriggers:\n  keywords: ["first"]\n---\n`,
    );

    const dir2 = join(projectDir, "agent");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(dir2, "dup-skill.md"),
      `---\nname: dup-skill\ntriggers:\n  keywords: ["second"]\n---\n`,
    );

    const cfg = makeConfig({
      skillLocations: [
        "{project}/skills/{name}/SKILL.md",    // first — wins
        "{project}/agent/{name}.md",            // second — ignored
      ],
    });
    const index = scanSkillFiles(cfg, projectDir);

    expect(index.size).toBe(1);
    // Should have the first location's keywords
    expect(index.get("dup-skill")!.triggers.keywords).toContain("first");
  });
});
