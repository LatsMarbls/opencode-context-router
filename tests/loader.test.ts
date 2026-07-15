import { describe, it, expect, beforeEach } from "vitest";
import { SkillLoader } from "../src/loader.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PreloaderConfig } from "../src/config.js";

// ── Helper ──────────────────────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SkillLoader", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "loader-test-"));
  });

  describe("loadStaticSkill", () => {
    it("loads an existing skill from disk", () => {
      const skillDir = join(projectDir, "skills", "my-rules");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# My Rules\n- rule 1");

      const cfg = makeConfig({
        skillLocations: ["{project}/skills/{name}/SKILL.md"],
      });
      const loader = new SkillLoader(cfg, projectDir);
      const skill = loader.loadStaticSkill("my-rules");

      expect(skill).not.toBeNull();
      expect(skill!.name).toBe("my-rules");
      expect(skill!.content).toContain("My Rules");
      expect(skill!.source).toBe("static-file");
    });

    it("returns null for missing skill", () => {
      const cfg = makeConfig({
        skillLocations: ["{project}/skills/{name}/SKILL.md"],
      });
      const loader = new SkillLoader(cfg, projectDir);
      const skill = loader.loadStaticSkill("nonexistent");

      expect(skill).toBeNull();
    });

    it("tries multiple locations in order, returns first hit", () => {
      const v1 = join(projectDir, "v1", "shared-rules");
      mkdirSync(v1, { recursive: true });
      writeFileSync(join(v1, "SKILL.md"), "# V1 Rules");

      const v2 = join(projectDir, "v2", "shared-rules");
      mkdirSync(v2, { recursive: true });
      writeFileSync(join(v2, "SKILL.md"), "# V2 Rules");

      const cfg = makeConfig({
        skillLocations: [
          "{project}/v1/{name}/SKILL.md",
          "{project}/v2/{name}/SKILL.md",
        ],
      });
      const loader = new SkillLoader(cfg, projectDir);
      const skill = loader.loadStaticSkill("shared-rules");

      expect(skill).not.toBeNull();
      expect(skill!.content).toContain("V1 Rules");
    });

    it("caches file content after first read", () => {
      const skillDir = join(projectDir, "skills", "cached");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Cached");

      const cfg = makeConfig({
        skillLocations: ["{project}/skills/{name}/SKILL.md"],
      });
      const loader = new SkillLoader(cfg, projectDir);

      // Load once
      const skill1 = loader.loadStaticSkill("cached");
      expect(skill1).not.toBeNull();

      // Modify the file on disk
      writeFileSync(join(skillDir, "SKILL.md"), "# Modified");

      // Load again — should get cached version
      const skill2 = loader.loadStaticSkill("cached");
      expect(skill2!.content).toContain("Cached");
      expect(skill2!.content).not.toContain("Modified");
    });
  });

  describe("priority resolution", () => {
    it("uses config.priority as highest priority source", () => {
      const skillDir = join(projectDir, "skills", "prio-rules");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Rules");

      const cfg = makeConfig({
        skillLocations: ["{project}/skills/{name}/SKILL.md"],
        priority: { "prio-rules": 9 },
        skillSettings: { "prio-rules": { priority: 3 } },
      });
      const loader = new SkillLoader(cfg, projectDir);
      const skill = loader.loadStaticSkill("prio-rules");

      expect(skill!.priority).toBe(9);
    });

    it("falls back to skillSettings.priority", () => {
      const skillDir = join(projectDir, "skills", "rules");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Rules");

      const cfg = makeConfig({
        skillLocations: ["{project}/skills/{name}/SKILL.md"],
        priority: {},
        skillSettings: { rules: { priority: 7 } },
      });
      const loader = new SkillLoader(cfg, projectDir);
      const skill = loader.loadStaticSkill("rules");

      expect(skill!.priority).toBe(7);
    });

    it("defaults to 5 when no priority is set", () => {
      const skillDir = join(projectDir, "skills", "rules");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Rules");

      const cfg = makeConfig({
        skillLocations: ["{project}/skills/{name}/SKILL.md"],
      });
      const loader = new SkillLoader(cfg, projectDir);
      const skill = loader.loadStaticSkill("rules");

      expect(skill!.priority).toBe(5);
    });
  });

  describe("resolveGroup", () => {
    it("returns skill names for a configured group", () => {
      const cfg = makeConfig({
        groups: {
          "backend": ["php-rules", "laravel-rules"],
          "frontend": ["vue-rules"],
        },
      });
      const loader = new SkillLoader(cfg, projectDir);

      expect(loader.resolveGroup("backend")).toEqual(["php-rules", "laravel-rules"]);
      expect(loader.resolveGroup("frontend")).toEqual(["vue-rules"]);
    });

    it("returns empty array for undefined group", () => {
      const cfg = makeConfig({ groups: {} });
      const loader = new SkillLoader(cfg, projectDir);

      expect(loader.resolveGroup("nonexistent")).toEqual([]);
    });
  });

  describe("getAlwaysOnSkills", () => {
    it("returns skills with always:true in settings", () => {
      const cfg = makeConfig({
        skillSettings: {
          "security-rules": { always: true },
          "php-rules": { always: false },
          "config-rules": { always: true },
        },
      });
      const loader = new SkillLoader(cfg, projectDir);
      const always = loader.getAlwaysOnSkills();

      expect(always).toContain("security-rules");
      expect(always).toContain("config-rules");
      expect(always).not.toContain("php-rules");
    });

    it("returns empty array when no always-on skills exist", () => {
      const cfg = makeConfig({ skillSettings: {} });
      const loader = new SkillLoader(cfg, projectDir);

      expect(loader.getAlwaysOnSkills()).toEqual([]);
    });
  });
});
