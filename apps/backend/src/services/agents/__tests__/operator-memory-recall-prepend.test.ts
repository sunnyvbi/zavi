
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isMemoryRecallAsk,
  MEMORY_RECALL_PATTERNS,
} from "../is-memory-recall-ask";

const DISPATCHER_TS = readFileSync(
  join(__dirname, "..", "generic-dispatcher.ts"),
  "utf-8",
);

describe("isMemoryRecallAsk — pattern set (T7 memory-recall classifier)", () => {
  describe("recall category", () => {
    it.each([
      "Based on what you know about our marketing",
      "based on previous conversations, what should I do",
      "given everything you know about the team",
      "what do you remember about our pricing",
      "recap our last discussion",
      "where did we leave off",
    ])("matches: %s", (text) => {
      const r = isMemoryRecallAsk(text);
      expect(r.matched).toBe(true);
      expect(r.category).toBe("recall");
    });
  });

  describe("priorities category", () => {
    it.each([
      "What are my priorities this week?",
      "What is on my plate today",
      "What should I work on next?",
      "What should I focus on this quarter",
      "What should I prioritize first",
    ])("matches: %s", (text) => {
      const r = isMemoryRecallAsk(text);
      expect(r.matched).toBe(true);
      expect(r.category).toBe("priorities");
    });
  });

  describe("prior-decisions category", () => {
    it.each([
      "What did we decide about the pricing",
      "Remind me about the cap table",
      "Remind me of the launch date",
    ])("matches: %s", (text) => {
      const r = isMemoryRecallAsk(text);
      expect(r.matched).toBe(true);
      expect(r.category).toBe("prior-decisions");
    });
  });

  describe("active-work category", () => {
    it.each([
      "What's active right now",
      "What's in flight on the onboarding",
      "What is in progress on payments",
      "Where are we on the migration",
      "Where were we on the host approval flow",
    ])("matches: %s", (text) => {
      const r = isMemoryRecallAsk(text);
      expect(r.matched).toBe(true);
      expect(r.category).toBe("active-work");
    });
  });

  describe("non-matches (workspace-signal / unrelated)", () => {
    it.each([
      "How many bookings did we have last week?",
      "Show me the latest Stripe disputes",
      "What's our current GMV?",
      "Help me draft a marketing email",
      "Fix the bug in checkout flow",
    ])("does NOT match: %s", (text) => {
      const r = isMemoryRecallAsk(text);
      expect(r.matched).toBe(false);
    });

    it("does NOT match empty / non-string inputs", () => {
      expect(isMemoryRecallAsk("").matched).toBe(false);
      // @ts-expect-error testing runtime guard
      expect(isMemoryRecallAsk(null).matched).toBe(false);
      // @ts-expect-error testing runtime guard
      expect(isMemoryRecallAsk(undefined).matched).toBe(false);
    });
  });

  it("exports MEMORY_RECALL_PATTERNS as a frozen single source of truth", () => {
    expect(Array.isArray(MEMORY_RECALL_PATTERNS)).toBe(true);
    expect(MEMORY_RECALL_PATTERNS.length).toBeGreaterThanOrEqual(12);
    for (const p of MEMORY_RECALL_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});

describe("generic-dispatcher.ts — memory-recall probe expansion patch (T7)", () => {
  it("imports isMemoryRecallAsk from the canonical flat path", () => {
    expect(DISPATCHER_TS).toMatch(/from\s+["']\.\/is-memory-recall-ask["']/);
    expect(DISPATCHER_TS).toContain("isMemoryRecallAsk");
  });

  it("gates the expansion on agent.slug === 'operator'", () => {
    expect(DISPATCHER_TS).toMatch(
      /ctx\.agent\.slug\s*===\s*["']operator["']\s*\?\s*isMemoryRecallAsk\(/,
    );
  });

  it("expands the probe with the locked workspace-domain term list when matched", () => {
    expect(DISPATCHER_TS).toContain("recent conversations");
    expect(DISPATCHER_TS).toContain("priorities");
    expect(DISPATCHER_TS).toContain("current projects");
    expect(DISPATCHER_TS).toContain("prior decisions");
    expect(DISPATCHER_TS).toContain("stalled approvals");
  });

  it("non-match path returns the raw probe unchanged (no expansion side-effect)", () => {
    expect(DISPATCHER_TS).toMatch(
      /recallCheck\.matched[\s\S]*?:\s*rawProbe/,
    );
  });
});
