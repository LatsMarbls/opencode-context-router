import { describe, it, expect } from "vitest";
import { loadConfig, resolveSkillPath, DEFAULT_CONFIG } from "../src/config.js";

describe("stripJsoncComments (via loadConfig)", () => {
  it("loads config with // comments", () => {
    // We test via loadConfig indirectly — this exercises the stripe
    const cfg = loadConfig(".");
    expect(cfg).toBeDefined();
    expect(cfg.maxTokens).toBe(8000);
  });

  it("produces defaults when no config file exists", () => {
    const cfg = loadConfig("/nonexistent/path");
    expect(cfg.maxTokens).toBe(DEFAULT_CONFIG.maxTokens);
    expect(cfg.skills).toEqual([]);
    expect(cfg.scannerEnabled).toBe(true);
    expect(cfg.enableTools).toBe(true);
  });
});

describe("resolveSkillPath", () => {
  const projectDir = "/home/user/my-project";
  const skillName = "php-conventions";

  it("resolves {project} and {name} in path", () => {
    const result = resolveSkillPath(
      "{project}/.opencode/skills/{name}/SKILL.md",
      projectDir,
      skillName,
    );
    expect(result).toBe("/home/user/my-project/.opencode/skills/php-conventions/SKILL.md");
  });

  it("resolves user-global path", () => {
    const result = resolveSkillPath(
      "{user}/.config/opencode/agent/{name}.md",
      projectDir,
      skillName,
    );
    // {user} resolves to something like /home/user/.config/opencode
    expect(result).toContain(".config/opencode/agent/php-conventions.md");
  });

  it("handles multiple placeholders", () => {
    const result = resolveSkillPath(
      "{project}/skills/{name}/v1/{name}.md",
      projectDir,
      "test",
    );
    expect(result).toBe("/home/user/my-project/skills/test/v1/test.md");
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_CONFIG.maxTokens).toBe(8000);
    expect(DEFAULT_CONFIG.scannerEnabled).toBe(true);
    expect(DEFAULT_CONFIG.showToasts).toBe(true);
    expect(DEFAULT_CONFIG.enableTools).toBe(true);
    expect(DEFAULT_CONFIG.persistAfterCompaction).toBe(true);
    expect(DEFAULT_CONFIG.injectionMethod).toBe("systemPrompt");
    expect(DEFAULT_CONFIG.skillLocations).toHaveLength(4);
    expect(DEFAULT_CONFIG.triggerIgnoreTags).toContain("node_modules");
    expect(DEFAULT_CONFIG.triggerIgnoreTags).toContain(".git");
  });

  it("has valid skill location templates", () => {
    for (const loc of DEFAULT_CONFIG.skillLocations) {
      expect(loc).toContain("{name}");
      expect(loc).toMatch(/\{project\}|\{user\}/);
    }
  });
});
