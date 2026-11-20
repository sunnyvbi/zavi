import { describe, it, expect } from "vitest";
import { aggregateGaps, normalizeQuestion, questionHash, type GapEpisode } from "../gap-aggregate";

const ep = (over: Partial<GapEpisode>): GapEpisode => ({
  tenant_id: "t1",
  agent_slug: "ops",
  status: "failed",
  created_at: "2026-05-20T00:00:00Z",
  question: "how do I export payouts",
  ...over,
});

describe("normalizeQuestion", () => {
  it("lowercases + collapses whitespace", () => {
    expect(normalizeQuestion("  How   DO  I\nX ")).toBe("how do i x");
  });
});

describe("questionHash", () => {
  it("same normalized question → same hash; per-tenant distinct", () => {
    expect(questionHash("t1", "How do I X")).toBe(questionHash("t1", "how  do i x"));
    expect(questionHash("t1", "q")).not.toBe(questionHash("t2", "q"));
  });
});

describe("aggregateGaps", () => {
  it("keeps only groups at/above minCount, sorted desc", () => {
    const eps = [
      ep({ question: "export payouts" }),
      ep({ question: "Export  Payouts", agent_slug: "payouts", created_at: "2026-05-21T00:00:00Z" }),
      ep({ question: "one off question" }),
    ];
    const out = aggregateGaps(eps, 2);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
    expect(out[0].agents.sort()).toEqual(["ops", "payouts"]);
    expect(out[0].last_seen).toBe("2026-05-21T00:00:00Z");
  });

  it("ignores empty questions", () => {
    expect(aggregateGaps([ep({ question: "" }), ep({ question: "   " })], 1)).toHaveLength(0);
  });

  it("cross-tenant questions never merge", () => {
    const out = aggregateGaps([ep({ tenant_id: "t1" }), ep({ tenant_id: "t2" })], 1);
    expect(out).toHaveLength(2);
  });
});
