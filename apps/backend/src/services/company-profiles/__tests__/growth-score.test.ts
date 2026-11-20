import { describe, expect, it } from "vitest";
import { computeGrowthScore } from "../growth-score";

function pairs(rows: Record<string, { latest: number; previous: number }>) {
  return new Map(Object.entries(rows));
}

describe("computeGrowthScore", () => {
  it("returns null until two comparable metrics exist", () => {
    expect(computeGrowthScore(pairs({ stripe_mrr: { latest: 120, previous: 100 } }))).toBeNull();
  });

  it("maps no-change to 50 and names the inputs", () => {
    expect(
      computeGrowthScore(
        pairs({
          stripe_mrr: { latest: 100, previous: 100 },
          weekly_signups: { latest: 10, previous: 10 },
        }),
      ),
    ).toEqual({ score: 50, note: "MRR + signups" });
  });

  it("treats a CPA drop as positive", () => {
    const scored = computeGrowthScore(
      pairs({
        stripe_mrr: { latest: 100, previous: 100 },
        ads_cpa_7d: { latest: 20, previous: 40 },
      }),
    );
    expect(scored?.score).toBeGreaterThan(50);
    expect(scored?.note).toContain("CPA");
  });

  it("skips a zero previous so it never divides by zero", () => {
    expect(
      computeGrowthScore(
        pairs({
          stripe_mrr: { latest: 100, previous: 0 },
          weekly_signups: { latest: 12, previous: 10 },
        }),
      ),
    ).toBeNull();
  });
});
