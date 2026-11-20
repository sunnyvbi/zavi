import { describe, it, expect } from "vitest";
import {
  smartTruncateToolResult,
  TRUNCATED_RESULT_INSTRUCTION,
} from "../smart-truncate";

const CAP = 2 * 1024;
const bytes = (s: string) => Buffer.byteLength(s, "utf-8");

describe("smartTruncateToolResult", () => {
  it("returns content unchanged when under the cap", () => {
    const small = JSON.stringify({ issues: [{ key: "ENG-1" }], total: 1 });
    expect(smartTruncateToolResult(small, CAP)).toBe(small);
  });

  it("never exceeds the byte cap (the Tier-1 contract)", () => {
    const big = JSON.stringify({
      issues: Array.from({ length: 500 }, (_, i) => ({
        key: `SCRUM-${i}`,
        summary: "x".repeat(80),
        status: "In Progress",
      })),
      total: 500,
    });
    const out = smartTruncateToolResult(big, CAP);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
  });

  it("keeps the result parseable and self-describing on truncation", () => {
    const big = JSON.stringify({
      issues: Array.from({ length: 500 }, (_, i) => ({
        key: `SCRUM-${i}`,
        summary: "lorem ipsum ".repeat(10),
      })),
      total: 500,
    });
    const out = smartTruncateToolResult(big, CAP);
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed._total).toBe(500);
    expect(parsed._returned).toBeGreaterThan(0);
    expect(parsed._returned).toBeLessThan(500);
    expect(typeof parsed._hint).toBe("string");
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(parsed.issues[0]).toHaveProperty("key", "SCRUM-0");
  });

  it("preserves small sibling metadata (Jira total + agent_hints) on truncation", () => {
    const jiraShaped = JSON.stringify({
      issues: Array.from({ length: 200 }, (_, i) => ({
        key: `SCRUM-${i}`,
        summary: "ticket ".repeat(8),
        status: "To Do",
      })),
      total: 287,
      agent_hints: {
        truncated: true,
        total: 287,
        suggestion:
          "Results capped. Total is 287. Use a more specific JQL or paginate.",
      },
    });
    const out = smartTruncateToolResult(jiraShaped, CAP);
    const parsed = JSON.parse(out);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(parsed.total).toBe(287);
    expect(parsed.agent_hints?.total).toBe(287);
    expect(parsed.agent_hints?.suggestion).toContain("287");
    expect(parsed._truncated).toBe(true);
  });

  it("handles a bare top-level array", () => {
    const arr = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({ id: i, blob: "y".repeat(50) })),
    );
    const out = smartTruncateToolResult(arr, CAP);
    const parsed = JSON.parse(out);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(parsed._truncated).toBe(true);
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it("falls back to a pure envelope when a single item blows the budget", () => {
    const huge = JSON.stringify({
      issues: [{ key: "BIG-1", body: "z".repeat(5000) }],
      total: 1,
    });
    const out = smartTruncateToolResult(huge, CAP);
    const parsed = JSON.parse(out);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(parsed._truncated).toBe(true);
    expect(parsed._returned).toBe(0);
  });

  it("slims a large non-list JSON object and stays under cap", () => {
    const obj = JSON.stringify({
      id: "abc",
      count: 42,
      ok: true,
      nested: { huge: "q".repeat(4000) },
      longStr: "w".repeat(4000),
    });
    const out = smartTruncateToolResult(obj, CAP);
    const parsed = JSON.parse(out);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(parsed._truncated).toBe(true);
    expect(parsed.id).toBe("abc");
    expect(parsed.count).toBe(42);
  });

  it("count instruction encodes the three-case rule (regression guard)", () => {
    const t = TRUNCATED_RESULT_INSTRUCTION.toLowerCase();
    expect(t).toContain("jira__count");
    expect(t).toContain("total_count");
    expect(t).toContain("_total");
    expect(t).toContain("at least n");
    expect(t).toContain("do not claim you cannot count");
    expect(t).toContain("never present a capped page count as the answer");
  });

  it("byte-slices non-JSON content with a human note", () => {
    const md = "# Big doc\n" + "paragraph ".repeat(1000);
    const out = smartTruncateToolResult(md, CAP);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(out).toContain("[truncated:");
    expect(out).toContain("persisted server-side");
  });

  it("preserves _dropped_identity (id+name) for rows past the page cap", () => {
    const TARGET = "Bay Area Rentals 2026-04-29";
    const campaigns = Array.from({ length: 25 }, (_, i) => ({
      id: `c_${i.toString().padStart(3, "0")}`,
      name: i === 14 ? TARGET : `Campaign ${i}`,
      spend: i * 10,
      blob: "x".repeat(180),
    }));
    const big = JSON.stringify({ campaigns, total: 25 });
    const out = smartTruncateToolResult(big, CAP);
    const parsed = JSON.parse(out);

    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(parsed._truncated).toBe(true);

    expect(Array.isArray(parsed._dropped_identity)).toBe(true);
    expect(parsed._dropped_identity.length).toBeGreaterThan(0);

    const keptHasIt = (parsed.campaigns as Array<Record<string, unknown>>).some(
      (c) => c?.name === TARGET,
    );
    const droppedHasIt = (
      parsed._dropped_identity as Array<Record<string, unknown>>
    ).some((c) => c?.name === TARGET);
    expect(keptHasIt || droppedHasIt).toBe(true);

    const first = parsed._dropped_identity[0] as Record<string, unknown>;
    expect(first.id).toBeDefined();
    expect(first.name).toBeDefined();
    expect(first).not.toHaveProperty("blob");
    expect(first).not.toHaveProperty("spend");
  });

  it("_dropped_identity never breaks the byte cap", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: `id_${i}`,
      name: "name ".repeat(40) + i,
      body: "y".repeat(200),
    }));
    const out = smartTruncateToolResult(
      JSON.stringify({ items, total: 500 }),
      CAP,
    );
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    if (Array.isArray(parsed._dropped_identity)) {
      expect(parsed._dropped_identity.length).toBeLessThan(500);
    }
  });

  it("omits _dropped_identity when no rows were dropped", () => {
    const small = JSON.stringify({
      campaigns: [{ id: "c_1", name: "Solo" }],
      total: 1,
    });
    const out = smartTruncateToolResult(small, CAP);
    expect(out).toBe(small);
    const parsed = JSON.parse(out);
    expect(parsed._dropped_identity).toBeUndefined();
  });

  it("omits identity rows for items with no IDENTITY_KEYS present", () => {
    const items = Array.from({ length: 200 }, () => ({
      blob: "z".repeat(80),
      payload: { nested: true },
    }));
    const out = smartTruncateToolResult(
      JSON.stringify({ items, total: 200 }),
      CAP,
    );
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    if (parsed._dropped_identity !== undefined) {
      expect(parsed._dropped_identity.length).toBe(0);
    }
  });

  it("safety net preserves _dropped_identity on pathological sibling overflow (grok round 2)", () => {
    const cap = 1024;
    const TARGET = "BAY-AREA-RENTALS-2026-04-29";
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `c_${i.toString().padStart(3, "0")}`,
      name: i === 5 ? TARGET : `Campaign ${i}`,
      blob: "z".repeat(60),
    }));
    const out = smartTruncateToolResult(
      JSON.stringify({ campaigns: items, total: 50 }),
      cap,
    );
    expect(bytes(out)).toBeLessThanOrEqual(cap);
    const parsed = JSON.parse(out);
    const keptHas = Array.isArray(parsed.campaigns)
      ? (parsed.campaigns as Array<Record<string, unknown>>).some(
          (c) => c?.name === TARGET,
        )
      : false;
    const dropHas = Array.isArray(parsed._dropped_identity)
      ? (parsed._dropped_identity as Array<Record<string, unknown>>).some(
          (c) => c?.name === TARGET,
        )
      : false;
    expect(keptHas || dropHas).toBe(true);
  });

  it("identity loop's per-row trial accounts for full-output overhead (grok round 2)", () => {
    const cap = 1024;
    const items = Array.from({ length: 80 }, (_, i) => ({
      id: `id_${i}`,
      name: `Long item name padding ${i}`,
      blob: "p".repeat(40),
    }));
    const out = smartTruncateToolResult(
      JSON.stringify({
        items,
        total: 80,
        agent_hints: { truncated: true, suggestion: "narrow it" },
      }),
      cap,
    );
    expect(bytes(out)).toBeLessThanOrEqual(cap);
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
  });

  it("O(n) item-fill keeps a byte-bounded prefix and never exceeds cap", () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: `row_${i}`,
      summary: "s".repeat(20 + (i % 7)),
    }));
    for (const cap of [512, 1024, 2048, 4096]) {
      const out = smartTruncateToolResult(
        JSON.stringify({ items, total: items.length }),
        cap,
      );
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      const parsed = JSON.parse(out) as { items?: unknown[]; _truncated?: boolean };
      expect(parsed._truncated).toBe(true);
      const keptCount = Array.isArray(parsed.items) ? parsed.items.length : 0;
      if (cap >= 1024) expect(keptCount).toBeGreaterThan(0);
    }
  });

  it("truncates a LARGE list result well within an event-loop-safe time budget", () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({
      id: `id_${i}`,
      name: `Item ${i}`,
      body: "x".repeat(120),
    }));
    const payload = JSON.stringify({ items, total: items.length });
    const start = process.hrtime.bigint();
    const out = smartTruncateToolResult(payload, 2 * 1024);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(bytes(out)).toBeLessThanOrEqual(2 * 1024);
    expect(elapsedMs).toBeLessThan(150);
  });

  it("instruction mentions _dropped_identity + bans 'deleted' from truncated source", () => {
    const t = TRUNCATED_RESULT_INSTRUCTION.toLowerCase();
    expect(t).toContain("_dropped_identity");
    expect(t).toContain("never claim");
    expect(t).toContain("deleted");
    expect(t).toContain("_truncated");
  });
});
