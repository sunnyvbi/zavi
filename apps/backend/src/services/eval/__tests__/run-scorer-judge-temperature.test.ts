import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
}));

import { judgeSamplingOpts, judgeMaxTokens } from "../run-scorer";

describe("judgeSamplingOpts", () => {
  it("omits temperature for the default judge (gpt-5.5 is fixed-temperature)", () => {
    expect(judgeSamplingOpts("gpt-5.5")).toEqual({});
  });

  it("omits temperature for o-series judges", () => {
    expect(judgeSamplingOpts("o3-mini")).toEqual({});
    expect(judgeSamplingOpts("o4-mini")).toEqual({});
  });

  it("requests temperature 0 when the judge model CAN honor it", () => {
    expect(judgeSamplingOpts("gpt-4o")).toEqual({ temperature: 0 });
  });

  it("never returns a temperature the fixed-temperature families would reject", () => {
    for (const m of ["gpt-5.5", "gpt-5-turbo-2099", "o1-preview", "o3", "o7-mini"]) {
      expect(judgeSamplingOpts(m)).not.toHaveProperty("temperature");
    }
  });
});

describe("judgeMaxTokens", () => {
  it("gives reasoning models room for the reasoning pass", () => {
    expect(judgeMaxTokens("gpt-5.5")).toBeGreaterThan(300);
    expect(judgeMaxTokens("o3")).toBeGreaterThan(300);
  });

  it("leaves non-reasoning judges byte-identical at 300", () => {
    expect(judgeMaxTokens("gpt-4o")).toBe(300);
    expect(judgeMaxTokens("claude-sonnet-4-6")).toBe(300);
  });

  it("agrees with judgeSamplingOpts on which models are reasoning models", () => {
    for (const m of ["gpt-5.5", "o3", "gpt-4o", "claude-sonnet-4-6"]) {
      const reasoningPerTemp = judgeSamplingOpts(m).temperature === undefined;
      const reasoningPerTokens = judgeMaxTokens(m) > 300;
      expect(reasoningPerTokens, `mismatch for ${m}`).toBe(reasoningPerTemp);
    }
  });
});
