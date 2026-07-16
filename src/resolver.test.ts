import { describe, it, expect } from "vitest";
import { Resolver } from "./resolver.js";
import type { PreloaderConfig } from "./config.js";
import type { ScannedSkillIndex } from "./scanner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<PreloaderConfig>): PreloaderConfig {
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
    maxTokens: 8_000,
    useSummaries: false,
    useMinification: false,
    showToasts: false,
    enableTools: false,
    analytics: false,
    persistAfterCompaction: false,
    accumulateSkills: true,
    scannerEnabled: false,
    debug: false,
    priority: {},
    skillTTL: 600_000,
    cacheFileTTL: 60_000,
    ...overrides,
  };
}

function makeResolver(
  contentTriggers: Record<string, string[]>,
  scannedIndex?: ScannedSkillIndex,
): Resolver {
  const cfg = makeConfig({ contentTriggers });
  return new Resolver(cfg, scannedIndex ?? new Map());
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveMessageTriggers", () => {
  describe("config keyword triggers", () => {
    it("matches exact keyword", () => {
      const r = makeResolver({ typescript: ["ts-rules"] });
      expect(r.resolveMessageTriggers("use typescript here")).toEqual(["ts-rules"]);
    });

    it("does NOT match substring in hyphenated word", () => {
      const r = makeResolver({ typescript: ["ts-rules"] });
      expect(r.resolveMessageTriggers("typescript-rule")).toEqual([]);
    });

    it("does NOT match substring inside another word", () => {
      const r = makeResolver({ typescript: ["ts-rules"] });
      expect(r.resolveMessageTriggers("typescripting is fun")).toEqual([]);
    });

    it("does NOT match 'its' for keyword 'ts'", () => {
      const r = makeResolver({ ts: ["ts-rules"] });
      expect(r.resolveMessageTriggers("its working now")).toEqual([]);
    });

    it("matches standalone 'ts'", () => {
      const r = makeResolver({ ts: ["ts-rules"] });
      expect(r.resolveMessageTriggers("use ts for types")).toEqual(["ts-rules"]);
    });

    it("handles multi-word phrases", () => {
      const r = makeResolver({ "vue component": ["vue-conventions"] });
      expect(r.resolveMessageTriggers("create a vue component")).toEqual(["vue-conventions"]);
    });

    it("does NOT match partial multi-word", () => {
      const r = makeResolver({ "vue component": ["vue-conventions"] });
      expect(r.resolveMessageTriggers("vuex components")).toEqual([]);
    });

    it("is case-insensitive", () => {
      const r = makeResolver({ typescript: ["ts-rules"] });
      expect(r.resolveMessageTriggers("Use TypeScript here")).toEqual(["ts-rules"]);
    });

    it("matches at start of message", () => {
      const r = makeResolver({ controller: ["ctrl-rules"] });
      expect(r.resolveMessageTriggers("controller for users")).toEqual(["ctrl-rules"]);
    });

    it("matches at end of message", () => {
      const r = makeResolver({ migration: ["mig-rules"] });
      expect(r.resolveMessageTriggers("create a migration")).toEqual(["mig-rules"]);
    });

    it("matches with punctuation adjacent", () => {
      const r = makeResolver({ controller: ["ctrl-rules"] });
      expect(r.resolveMessageTriggers("create controller!")).toEqual(["ctrl-rules"]);
    });

    it("returns multiple matches", () => {
      const r = makeResolver({
        controller: ["ctrl-rules"],
        migration: ["mig-rules"],
      });
      const result = r.resolveMessageTriggers("create controller and migration");
      expect(result).toContain("ctrl-rules");
      expect(result).toContain("mig-rules");
    });

    it("returns empty for no match", () => {
      const r = makeResolver({ python: ["py-rules"] });
      expect(r.resolveMessageTriggers("create a controller")).toEqual([]);
    });

    it("keyword 'controller' does NOT match 'controllers' alone", () => {
      const r = makeResolver({ controller: ["ctrl-rules"] });
      // "controllers" has 'controller' as prefix but \b won't match after 's'
      expect(r.resolveMessageTriggers("list controllers")).toEqual([]);
    });

    it("handles regex special chars in keyword safely", () => {
      const r = makeResolver({ "c++": ["cpp-rules"] });
      expect(r.resolveMessageTriggers("write c++ code")).toEqual(["cpp-rules"]);
    });
  });

  describe("scanned keyword triggers", () => {
    const scannedIndex: ScannedSkillIndex = new Map([
      ["ts-rules", {
        name: "ts-rules",
        filePath: "/skills/ts-rules/SKILL.md",
        triggers: { keywords: ["typescript"] },
      }],
      ["vue-conventions", {
        name: "vue-conventions",
        filePath: "/skills/vue-conventions/SKILL.md",
        triggers: { keywords: ["vue component"] },
      }],
    ]);

    it("matches exact keyword", () => {
      const r = makeResolver({}, scannedIndex);
      expect(r.resolveMessageTriggers("use typescript")).toEqual(["ts-rules"]);
    });

    it("does NOT match hyphenated substring", () => {
      const r = makeResolver({}, scannedIndex);
      expect(r.resolveMessageTriggers("typescript-rule")).toEqual([]);
    });

    it("does NOT match inside another word", () => {
      const r = makeResolver({}, scannedIndex);
      expect(r.resolveMessageTriggers("typescripting")).toEqual([]);
    });

    it("handles multi-word scanned keyword", () => {
      const r = makeResolver({}, scannedIndex);
      expect(r.resolveMessageTriggers("build a vue component")).toEqual(["vue-conventions"]);
    });

    it("does NOT match partial multi-word scanned", () => {
      const r = makeResolver({}, scannedIndex);
      expect(r.resolveMessageTriggers("vuex components")).toEqual([]);
    });
  });
});
