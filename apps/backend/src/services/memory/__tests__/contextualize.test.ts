
import { describe, it, expect } from "vitest";
import {
  buildChunkContextPrefix,
  contextualizeChunks,
  CHUNK_CONTEXT_MAX_CHARS,
} from "../contextualize";

describe("buildChunkContextPrefix", () => {
  it("builds [note_type] title — for a typed, titled note", () => {
    expect(
      buildChunkContextPrefix({ note_type: "operator_preference", title: "Weekend host payout timing" }),
    ).toBe("[operator_preference] Weekend host payout timing — ");
  });

  it("defaults a missing/empty note_type to 'untyped' (matches the write path default)", () => {
    expect(buildChunkContextPrefix({ title: "Driver credit threshold" })).toBe(
      "[untyped] Driver credit threshold — ",
    );
    expect(buildChunkContextPrefix({ note_type: "", title: "X" })).toBe("[untyped] X — ");
    expect(buildChunkContextPrefix({ note_type: null, title: "X" })).toBe("[untyped] X — ");
  });

  it("drops an empty/whitespace title — yields just [type] — ", () => {
    expect(buildChunkContextPrefix({ note_type: "anchor", title: "" })).toBe("[anchor] — ");
    expect(buildChunkContextPrefix({ note_type: "anchor", title: "   " })).toBe("[anchor] — ");
    expect(buildChunkContextPrefix({ note_type: "anchor" })).toBe("[anchor] — ");
  });

  it("collapses internal whitespace + trims the title (stable across phrasings)", () => {
    expect(buildChunkContextPrefix({ note_type: "tenant_reference", title: "  a   b\tc  " })).toBe(
      "[tenant_reference] a b c — ",
    );
  });

  it("is deterministic — same input → same prefix", () => {
    const a = buildChunkContextPrefix({ note_type: "correction", title: "MVR points limit" });
    const b = buildChunkContextPrefix({ note_type: "correction", title: "MVR points limit" });
    expect(a).toBe(b);
  });

  it("hard-caps a pathologically long title so token cost is bounded", () => {
    const huge = "x".repeat(5000);
    const prefix = buildChunkContextPrefix({ note_type: "untyped", title: huge });
    expect(prefix.length).toBeLessThanOrEqual(CHUNK_CONTEXT_MAX_CHARS);
  });

  it("never exceeds the bound regardless of input", () => {
    for (const title of ["", "short", "y".repeat(300), "z".repeat(10000)]) {
      const p = buildChunkContextPrefix({ note_type: "operator_preference", title });
      expect(p.length).toBeLessThanOrEqual(CHUNK_CONTEXT_MAX_CHARS);
    }
  });
});

describe("contextualizeChunks", () => {
  const ctx = { note_type: "operator_preference", title: "Weekend host payout timing" };
  const prefix = "[operator_preference] Weekend host payout timing — ";

  it("prepends the SAME prefix to every chunk of a note (situates each in its parent)", () => {
    const out = contextualizeChunks(["chunk one", "chunk two"], ctx);
    expect(out).toHaveLength(2);
    expect(out[0].contextualized).toBe(`${prefix}chunk one`);
    expect(out[1].contextualized).toBe(`${prefix}chunk two`);
  });

  it("keeps body UNCHANGED (raw chunk persists for display/snippet/rerank)", () => {
    const out = contextualizeChunks(["released within 11 business hours"], ctx);
    expect(out[0].body).toBe("released within 11 business hours");
    expect(out[0].contextualized).toBe(`${prefix}released within 11 business hours`);
    expect(out[0].contextualized.toLowerCase()).toContain("weekend");
    expect(out[0].contextualized.toLowerCase()).toContain("payout");
  });

  it("returns [] for an empty chunk list", () => {
    expect(contextualizeChunks([], ctx)).toEqual([]);
  });

  it("is deterministic — identical (chunks, ctx) → identical output (idempotency contract)", () => {
    const a = contextualizeChunks(["a", "b"], ctx);
    const b = contextualizeChunks(["a", "b"], ctx);
    expect(a).toEqual(b);
  });

  it("matches the backfill's reconstructed value: prefix + body === contextualized", () => {
    const body = "MVR points limit is 2 in the last 3 years";
    const [c] = contextualizeChunks([body], ctx);
    expect(c.contextualized).toBe(`${buildChunkContextPrefix(ctx)}${body}`);
  });
});
