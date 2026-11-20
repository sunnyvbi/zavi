import { describe, it, expect, vi } from "vitest";

vi.mock("../plan-review", () => ({
  isPlanReviewEnabled: () => false,
  reviewAndRevisePlan: async () => { throw new Error("not in these tests"); },
}));

import { spineOf } from "../post-run";

const S = {
  north_star: { metric: "activation_rate", why: "signups stall" },
  constraint: { statement: "60% never finish setup", lever_family: "activation" },
  channel_bets: [{ channel_slug: "seo" }],
  goal: { objective: "Lift activation", target_metric: "activation_rate", target_value: 40 },
};

describe("spineOf — what acceptance is pinned to", () => {
  it("is unchanged by refinement, so an accepted strategy survives a brainstorm", () => {
    const refined = {
      ...S,
      north_star: { ...S.north_star, why: "a much better explanation" },
      channel_bets: [{ channel_slug: "email_marketing" }, { channel_slug: "seo" }],
      goal: { ...S.goal, target_value: 45 },
    };
    expect(spineOf(refined)).toBe(spineOf(S));
  });

  it("changes when the North Star or the constraint changes, forcing a fresh yes", () => {
    expect(spineOf({ ...S, north_star: { metric: "mrr" } })).not.toBe(spineOf(S));
    expect(
      spineOf({ ...S, constraint: { statement: "we have no demand at all" } }),
    ).not.toBe(spineOf(S));
  });

  it("ignores casing and surrounding whitespace", () => {
    expect(
      spineOf({
        ...S,
        north_star: { metric: "  Activation_Rate " },
        constraint: { statement: "60% Never Finish Setup  " },
      }),
    ).toBe(spineOf(S));
  });

  it("returns null when there is no usable spine", () => {
    expect(spineOf(null)).toBeNull();
    expect(spineOf({})).toBeNull();
    expect(spineOf({ north_star: { metric: "mrr" } })).toBeNull();
    expect(spineOf({ constraint: { statement: "x" } })).toBeNull();
    expect(spineOf({ ...S, north_star: { metric: "   " } })).toBeNull();
  });
});
