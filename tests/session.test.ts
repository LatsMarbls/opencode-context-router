import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../src/session.js";
import type { LoadedSkill } from "../src/loader.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSkill(name: string, content: string, priority: number = 5): LoadedSkill {
  return { name, content, source: "static-file", priority };
}

describe("SessionManager", () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager("test-session", 8000);
  });

  // ── Queuing ─────────────────────────────────────────────────────────

  describe("queueSkills", () => {
    it("queues a single skill", () => {
      mgr.queueSkills([makeSkill("php-conventions", "some rules")], "keyword");
      expect(mgr.hasSkill("php-conventions")).toBe(true);
    });

    it("deduplicates by name — higher priority wins", () => {
      mgr.queueSkills([makeSkill("rules", "low prio content", 3)], "keyword");
      mgr.queueSkills([makeSkill("rules", "high prio content", 10)], "keyword");
      mgr.flushPending();
      // Higher priority should replace lower
      const formatted = mgr.getFormattedSkills();
      expect(formatted).toContain("high prio content");
    });

    it("keeps existing if same-or-higher priority already queued", () => {
      mgr.queueSkills([makeSkill("rules", "original", 10)], "keyword");
      mgr.queueSkills([makeSkill("rules", "lower", 5)], "keyword");
      mgr.flushPending();
      const formatted = mgr.getFormattedSkills();
      expect(formatted).toContain("original");
      expect(formatted).not.toContain("lower");
    });
  });

  // ── Flush + Active ──────────────────────────────────────────────────

  describe("flushPending", () => {
    it("promotes pending skills to active", () => {
      mgr.queueSkills([makeSkill("a", "content a")], "keyword");
      expect(mgr.getActiveSkills()).toHaveLength(0); // not flushed yet
      mgr.flushPending();
      expect(mgr.getActiveSkills()).toHaveLength(1);
    });

    it("returns all active skills after flush", () => {
      mgr.queueSkills([makeSkill("a", "content a")], "kw");
      mgr.queueSkills([makeSkill("b", "content b")], "kw");
      const result = mgr.flushPending();
      expect(result).toHaveLength(2);
    });
  });

  // ── Formatting ──────────────────────────────────────────────────────

  describe("getFormattedSkills", () => {
    it("returns empty string when no skills loaded", () => {
      expect(mgr.getFormattedSkills()).toBe("");
    });

    it("formats skills as <context-route> blocks", () => {
      mgr.queueSkills([makeSkill("my-rules", "rule one\nrule two")], "keyword");
      mgr.flushPending();
      const formatted = mgr.getFormattedSkills();
      expect(formatted).toContain("<context-route name=\"my-rules\">");
      expect(formatted).toContain("rule one");
      expect(formatted).toContain("rule two");
      expect(formatted).toContain("</context-route>");
    });

    it("formats multiple skills", () => {
      mgr.queueSkills([
        makeSkill("a", "content a"),
        makeSkill("b", "content b"),
      ], "trigger");
      mgr.flushPending();
      const formatted = mgr.getFormattedSkills();
      expect(formatted).toContain("<context-route name=\"a\">");
      expect(formatted).toContain("<context-route name=\"b\">");
    });
  });

  // ── Token Budget ────────────────────────────────────────────────────

  describe("token budget", () => {
    it("drops lowest-priority skill when budget exceeded", () => {
      const smallMgr = new SessionManager("budget-test", 100);

      // ~200 chars / 4 = ~50 tokens each → 3×50=150 > 100, lowest dropped
      smallMgr.queueSkills([
        makeSkill("high", "a".repeat(200), 10),
        makeSkill("medium", "a".repeat(200), 5),
        makeSkill("low", "a".repeat(200), 1),
      ], "trigger");
      smallMgr.flushPending();

      const active = smallMgr.getActiveSkills();
      const names = active.map((s) => s.name);
      expect(names).toContain("high");
      expect(names).not.toContain("low"); // lowest priority dropped
    });

    it("high-priority skills survive budget cuts", () => {
      const smallMgr = new SessionManager("priority-test", 30);
      // Each skill is ~40 chars = ~10 tokens
      smallMgr.queueSkills([
        makeSkill("important", "important content here for testing", 100),
        makeSkill("noise", "some noise content that should be dropped", 1),
      ], "trigger");
      smallMgr.flushPending();

      const active = smallMgr.getActiveSkills();
      expect(active.some((s) => s.name === "important")).toBe(true);
    });

    it("getBudgetStatus reports used and dropped correctly", () => {
      const smallMgr = new SessionManager("budget-status", 250);
      smallMgr.queueSkills([
        makeSkill("a", "a".repeat(400), 10), // ~100 tok
        makeSkill("b", "a".repeat(400), 5),  // ~100 tok
        makeSkill("c", "a".repeat(400), 1),  // ~100 tok — dropped (100+100+100 > 250)
      ], "trigger");
      smallMgr.flushPending();
      smallMgr.getActiveSkills(); // triggers budget calculation

      const budget = smallMgr.getBudgetStatus();
      expect(budget.limit).toBe(250);
      expect(budget.loadedCount).toBeGreaterThan(0);
      expect(budget.dropped.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Summary ─────────────────────────────────────────────────────────

  describe("getSkillsSummary", () => {
    it("returns empty string when no skills", () => {
      expect(mgr.getSkillsSummary()).toBe("");
    });

    it("returns markdown summary of active skills", () => {
      mgr.queueSkills([makeSkill("php", "rules", 10)], "trigger");
      mgr.flushPending();
      mgr.getActiveSkills(); // calculate budget

      const summary = mgr.getSkillsSummary();
      expect(summary).toContain("## Preloaded Skills");
      expect(summary).toContain("**php**");
      expect(summary).toContain("static-file");
      expect(summary).toContain("priority 10");
    });
  });

  // ── State Management ────────────────────────────────────────────────

  describe("state management", () => {
    it("hasSkill checks both active and pending", () => {
      mgr.queueSkills([makeSkill("pending-skill", "content")], "trigger");
      expect(mgr.hasSkill("pending-skill")).toBe(true); // in pending queue
      mgr.flushPending();
      expect(mgr.hasSkill("pending-skill")).toBe(true); // now active
    });

    it("removeSkill removes from both queues", () => {
      mgr.queueSkills([makeSkill("doomed", "content")], "trigger");
      mgr.flushPending();
      mgr.removeSkill("doomed");
      expect(mgr.hasSkill("doomed")).toBe(false);
      expect(mgr.getActiveSkills()).toHaveLength(0);
    });

    it("clear empties all skills", () => {
      mgr.queueSkills([makeSkill("a", "1"), makeSkill("b", "2")], "trigger");
      mgr.flushPending();
      mgr.clear();
      expect(mgr.getActiveSkills()).toHaveLength(0);
    });
  });

  // ── Priority Sorting ────────────────────────────────────────────────

  describe("active skill ordering", () => {
    it("sorts by priority descending, then FIFO", () => {
      mgr.queueSkills([
        makeSkill("low", "content", 1),
        makeSkill("high", "content", 10),
        makeSkill("mid", "content", 5),
      ], "trigger");
      mgr.flushPending();
      const active = mgr.getActiveSkills();
      expect(active[0].name).toBe("high");
      expect(active[1].name).toBe("mid");
      expect(active[2].name).toBe("low");
    });
  });
});
