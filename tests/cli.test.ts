import { describe, it, expect } from "vitest";
import { cmdMatrix, cmdCheck, cmdConfig, cmdHelp } from "../src/cli.js";
import type { PreloaderConfig } from "../src/config.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

describe("cmdHelp", () => {
  it("returns help text with available commands", () => {
    const help = cmdHelp();
    expect(help).toContain("context-routing");
    expect(help).toContain("matrix");
    expect(help).toContain("check");
    expect(help).toContain("config");
    expect(help).toContain("help");
  });
});

describe("cmdConfig", () => {
  it("shows token budget and skill counts", () => {
    const cfg = makeConfig({
      maxTokens: 5000,
      showToasts: false,
      skills: ["a", "b"],
      fileTypeSkills: { ".php": ["php-rules"] },
      pathPatterns: { "src/**": ["model-rules"] },
    });
    const output = cmdConfig(cfg);

    expect(output).toContain("5000");
    expect(output).toContain("2");
    expect(output).toContain("1");
    expect(output).toContain("Show toasts");
  });

  it("lists skill locations when configured", () => {
    const cfg = makeConfig({
      skillLocations: ["{project}/skills/{name}/SKILL.md", "{user}/agent/{name}.md"],
    });
    const output = cmdConfig(cfg);

    expect(output).toContain("SKILL.md");
    expect(output).toContain("agent/{name}.md");
  });
});

describe("cmdCheck", () => {
  it("returns no skills for unmatched file", () => {
    const cfg = makeConfig({
      fileTypeSkills: { ".php": ["php-rules"] },
    });
    const output = cmdCheck("index.js", cfg);

    expect(output).toContain("No skills trigger");
  });

  it("matches by file extension", () => {
    const cfg = makeConfig({
      fileTypeSkills: { ".php": ["php-rules"], ".vue": ["vue-rules"] },
    });
    const output = cmdCheck("src/UserController.php", cfg);

    expect(output).toContain("php-rules");
    expect(output).toContain("extension .php");
    expect(output).not.toContain("vue-rules");
  });

  it("matches by path pattern", () => {
    const cfg = makeConfig({
      fileTypeSkills: {},
      pathPatterns: { "src/Models/**": ["model-rules"] },
    });
    const output = cmdCheck("src/Models/User.php", cfg);

    expect(output).toContain("model-rules");
    expect(output).toContain("path src/Models/**");
  });

  it("matches multiple triggers for same file", () => {
    const cfg = makeConfig({
      fileTypeSkills: { ".php": ["php-rules"] },
      pathPatterns: { "src/Models/**": ["model-rules"] },
    });
    const output = cmdCheck("src/Models/User.php", cfg);

    expect(output).toContain("php-rules");
    expect(output).toContain("model-rules");
  });
});

describe("cmdMatrix", () => {
  it("returns 'No skills' message when none configured", () => {
    const cfg = makeConfig({});
    const output = cmdMatrix(cfg);
    expect(output).toContain("No skills");
  });

  it("lists skills from fileTypeSkills", () => {
    const cfg = makeConfig({
      fileTypeSkills: {
        ".php": ["php-rules", "laravel-rules"],
        ".vue": ["vue-rules"],
      },
    });
    const output = cmdMatrix(cfg);

    expect(output).toContain("php-rules");
    expect(output).toContain("laravel-rules");
    expect(output).toContain("vue-rules");
    expect(output).toContain("Per Extension");
    expect(output).toContain(".php");
    expect(output).toContain(".vue");
  });

  it("integrates scanned skills into matrix", () => {
    const cfg = makeConfig({
      fileTypeSkills: {},
      pathPatterns: {},
      agentSkills: {},
      contentTriggers: {},
    });

    const scannedIndex = new Map([
      ["scanned-rules", {
        name: "scanned-rules",
        filePath: "/tmp/skills/scanned/SKILL.md",
        triggers: { extensions: [".ts"], keywords: ["typescript"] },
        priority: 7,
        always: true,
      }],
    ]);

    const output = cmdMatrix(cfg, scannedIndex);

    expect(output).toContain("scanned-rules");
    expect(output).toContain("always");
  });

  it("sorts by priority descending", () => {
    const cfg = makeConfig({
      priority: { "low": 1, "high": 10, "med": 5 },
      fileTypeSkills: {
        ".php": ["high", "med", "low"],
      },
    });
    const output = cmdMatrix(cfg);

    const highIdx = output.indexOf("high");
    const medIdx = output.indexOf("med");
    const lowIdx = output.indexOf("low");

    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });
});
