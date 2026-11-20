
import { describe, it, expect } from "vitest";
import {
  classifyGrowthStage,
  normalizeFunnelSteps,
  buildCurrentGrowthPlan,
  resolveExecTag,
  isScaleBudgetBet,
  isEarlyStage,
  type FunnelStep,
  type GrowthStage,
  type GrowthStageInput,
  type GrowthPlanBet,
} from "../current-growth-plan";

const AT = "2026-07-14T00:00:00.000Z";
function planBet(over: Partial<GrowthPlanBet> = {}): GrowthPlanBet {
  return {
    bet: "shift spend",
    lever: "budget",
    amount_usd: 40,
    amount_qualitative: false,
    suggested_dispatch: null,
    suggested_publish: null,
    evidence_text: "roas up",
    ...over,
  };
}

const step = (event: string, count: number): FunnelStep => ({
  event,
  count,
  conversion_from_top: null,
});

const signupsButNoPurchase: FunnelStep[] = [
  step("signup", 120),
  step("activation", 40),
  step("key_action", 8),
  step("purchase", 0),
];

const midFunnelDrop: FunnelStep[] = [
  step("signup", 500),
  step("activation", 90),
  step("key_action", 70),
  step("purchase", 40),
];

const allZeroSteps: FunnelStep[] = [
  step("signup", 0),
  step("activation", 0),
  step("key_action", 0),
  step("purchase", 0),
];

describe("classifyGrowthStage", () => {
  describe("I1 — no funnel source → data_not_ready", () => {
    it("returns data_not_ready when the diagnose call threw (sourceAvailable=false)", () => {
      expect(
        classifyGrowthStage({ sourceAvailable: false, steps: [] }),
      ).toBe("data_not_ready");
    });

    it("returns data_not_ready when source is unavailable even if stale steps linger", () => {
      expect(
        classifyGrowthStage({ sourceAvailable: false, steps: midFunnelDrop }),
      ).toBe("data_not_ready");
    });

    it("returns data_not_ready when normalized steps are empty (native has_data=false)", () => {
      expect(
        classifyGrowthStage({ sourceAvailable: true, steps: [] }),
      ).toBe("data_not_ready");
    });

    it("returns data_not_ready when the funnel is too thin to classify (<2 steps)", () => {
      expect(
        classifyGrowthStage({ sourceAvailable: true, steps: [step("signup", 300)] }),
      ).toBe("data_not_ready");
    });
  });

  describe("I2 — has_data:true but ALL step counts are 0 → data_not_ready", () => {
    it("does NOT classify an all-zero funnel as leaky_loop or pre_loop", () => {
      const stage = classifyGrowthStage({
        sourceAvailable: true,
        steps: allZeroSteps,
      });
      expect(stage).toBe("data_not_ready");
      expect(stage).not.toBe("leaky_loop");
      expect(stage).not.toBe("pre_loop");
    });
  });

  describe("pre_loop — signups exist, zero conversions", () => {
    it("returns pre_loop when top-of-funnel > 0 but the terminal step is 0", () => {
      expect(
        classifyGrowthStage({
          sourceAvailable: true,
          steps: signupsButNoPurchase,
        }),
      ).toBe("pre_loop");
    });

    it("returns pre_loop when upstream volume exists but nothing completes", () => {
      expect(
        classifyGrowthStage({
          sourceAvailable: true,
          steps: [step("signup", 75), step("purchase", 0)],
        }),
      ).toBe("pre_loop");
    });
  });

  describe("leaky_loop — completions exist + a mid-funnel drop", () => {
    it("returns leaky_loop when the terminal completion step has volume", () => {
      expect(
        classifyGrowthStage({ sourceAvailable: true, steps: midFunnelDrop }),
      ).toBe("leaky_loop");
    });

    it("returns leaky_loop for a two-step funnel that has completions", () => {
      expect(
        classifyGrowthStage({
          sourceAvailable: true,
          steps: [step("signup", 200), step("purchase", 30)],
        }),
      ).toBe("leaky_loop");
    });
  });

  describe("I7 — classifier only ever returns the 3 v1 stages (never scaling)", () => {
    const allowed: GrowthStage[] = ["data_not_ready", "pre_loop", "leaky_loop"];
    const cases: GrowthStageInput[] = [
      { sourceAvailable: false, steps: [] },
      { sourceAvailable: true, steps: [] },
      { sourceAvailable: true, steps: allZeroSteps },
      { sourceAvailable: true, steps: signupsButNoPurchase },
      { sourceAvailable: true, steps: midFunnelDrop },
      {
        sourceAvailable: true,
        steps: [step("signup", 50), step("purchase", 50)],
      },
    ];
    it.each(cases)("returns an allowed stage for %o", (input) => {
      const stage = classifyGrowthStage(input);
      expect(allowed).toContain(stage);
      expect(stage).not.toBe("scaling");
    });
  });
});

describe("normalizeFunnelSteps", () => {
  it("extracts native funnel.steps and rounds conversion_from_top to 1dp", () => {
    const funnel = {
      has_data: true,
      steps: [
        { event: "signup", count: 100, conversion_from_top: 100 },
        { event: "purchase", count: 12, conversion_from_top: 12.3456 },
      ],
    };
    expect(normalizeFunnelSteps(funnel)).toEqual([
      { event: "signup", count: 100, conversion_from_top: 100 },
      { event: "purchase", count: 12, conversion_from_top: 12.3 },
    ]);
  });

  it("probes the operator-DB nested funnel.funnel.steps shape", () => {
    const funnel = {
      funnel: {
        steps: [{ event: "lead", count: 9 }],
      },
    };
    expect(normalizeFunnelSteps(funnel)).toEqual([
      { event: "lead", count: 9, conversion_from_top: null },
    ]);
  });

  it("preserves all-zero steps (so the I2 trap is visible to the classifier)", () => {
    const funnel = {
      has_data: true,
      steps: [
        { event: "signup", count: 0, conversion_from_top: null },
        { event: "purchase", count: 0, conversion_from_top: null },
      ],
    };
    const steps = normalizeFunnelSteps(funnel);
    expect(steps).toHaveLength(2);
    expect(classifyGrowthStage({ sourceAvailable: true, steps })).toBe(
      "data_not_ready",
    );
  });

  it("degrades to [] for a non-object / missing / malformed funnel", () => {
    expect(normalizeFunnelSteps(null)).toEqual([]);
    expect(normalizeFunnelSteps(undefined)).toEqual([]);
    expect(normalizeFunnelSteps("nope")).toEqual([]);
    expect(normalizeFunnelSteps({ steps: "not-an-array" })).toEqual([]);
    expect(normalizeFunnelSteps({})).toEqual([]);
  });

  it("drops malformed rows (missing event or non-finite count)", () => {
    const funnel = {
      steps: [
        { event: "signup", count: 100 },
        { count: 5 },
        { event: "bad", count: "NaN" },
        { event: "purchase", count: 20 },
      ],
    };
    expect(normalizeFunnelSteps(funnel)).toEqual([
      { event: "signup", count: 100, conversion_from_top: null },
      { event: "purchase", count: 20, conversion_from_top: null },
    ]);
  });
});

describe("resolveExecTag — sourced from the real bet/lever (I6, not hardcoded)", () => {
  it("connector-gap in evidence → needs-connector (wins over any lever rail)", () => {
    expect(
      resolveExecTag(planBet({ evidence_text: "stripe not connected" })),
    ).toBe("needs-connector");
    expect(
      resolveExecTag(planBet({ evidence_text: "operator_db_not_connected" })),
    ).toBe("needs-connector");
  });
  it("social bet with a publish channel → yes (social.publish.v2 rail)", () => {
    expect(
      resolveExecTag(planBet({ lever: "social", suggested_publish: "linkedin" })),
    ).toBe("yes");
  });
  it("valid Suggested dispatch → yes (dispatch rail); founder sentinel does not count", () => {
    expect(
      resolveExecTag(planBet({ suggested_dispatch: "performance-marketer.weekly-plan" })),
    ).toBe("yes");
    expect(
      resolveExecTag(
        planBet({
          suggested_dispatch: "founder (does it)",
          lever: "social",
          amount_usd: null,
          amount_qualitative: true,
          suggested_publish: null,
          evidence_text: "narrative",
        }),
      ),
    ).toBe("manual");
  });
  it("budget bet with a concrete amount → yes (reallocate-budget rail)", () => {
    expect(resolveExecTag(planBet({ lever: "budget", amount_usd: 40 }))).toBe("yes");
  });
  it("qualitative social bet with no rail → manual", () => {
    expect(
      resolveExecTag(
        planBet({
          lever: "social",
          amount_usd: null,
          amount_qualitative: true,
          suggested_publish: null,
          evidence_text: "narrative",
        }),
      ),
    ).toBe("manual");
  });
});

describe("buildCurrentGrowthPlan — living plan shape + I3 filter", () => {
  it("data_not_ready → now is the get-data action; bets demoted to later", () => {
    const plan = buildCurrentGrowthPlan({
      stage: "data_not_ready",
      bets: [planBet({ bet: "scale google" }), planBet({ bet: "cut meta" })],
      updatedAt: AT,
    });
    expect(plan.stage).toBe("data_not_ready");
    expect(plan.now?.exec).toBe("needs-connector");
    expect(plan.next).toHaveLength(0);
    expect(plan.later).toEqual([]);
    expect(plan.updated_at).toBe(AT);
  });

  it("data_not_ready (default / no connected source) → connect CTA + needs-connector", () => {
    const plan = buildCurrentGrowthPlan({
      stage: "data_not_ready",
      bets: [],
      updatedAt: AT,
    });
    expect(plan.now?.exec).toBe("needs-connector");
    expect(plan.now?.action).toContain("/settings");
    expect(plan.now?.action).toMatch(/connect your/i);
  });

  it("data_not_ready + hasConnectedGrowthDataSource=true → 'too thin' message + needs-data", () => {
    const plan = buildCurrentGrowthPlan({
      stage: "data_not_ready",
      bets: [],
      updatedAt: AT,
      hasConnectedGrowthDataSource: true,
    });
    expect(plan.now?.exec).toBe("needs-data");
    expect(plan.now?.action).toMatch(/too thin|thin/i);
    expect(plan.now?.action).not.toContain("/settings");
    expect(plan.now?.action).not.toMatch(/connect your/i);
  });

  it("data_not_ready + hasConnectedGrowthDataSource=false → connect CTA (explicit false)", () => {
    const plan = buildCurrentGrowthPlan({
      stage: "data_not_ready",
      bets: [],
      updatedAt: AT,
      hasConnectedGrowthDataSource: false,
    });
    expect(plan.now?.exec).toBe("needs-connector");
    expect(plan.now?.action).toContain("/settings");
  });

  it("pre_loop drops scale-budget bets from the plan actions (I3)", () => {
    const plan = buildCurrentGrowthPlan({
      stage: "pre_loop",
      bets: [
        planBet({ lever: "budget", bet: "scale google" }),
        planBet({ lever: "lifecycle", bet: "win-back drip", evidence_text: "churn" }),
      ],
      updatedAt: AT,
    });
    expect(plan.now?.action).toBe("win-back drip");
    expect(plan.now?.exec).toBe("yes");
  });

  it("leaky_loop keeps budget bets; now/next/later split is top-3-then-backlog", () => {
    const bets = ["a", "b", "c", "d"].map((b) =>
      planBet({ lever: "budget", bet: b }),
    );
    const plan = buildCurrentGrowthPlan({ stage: "leaky_loop", bets, updatedAt: AT });
    expect(plan.now?.action).toBe("a");
    expect(plan.next.map((n) => n.action)).toEqual(["b", "c"]);
    expect(plan.later).toEqual(["d"]);
  });

  it("no bets → now is null (leaky_loop), plan still valid", () => {
    const plan = buildCurrentGrowthPlan({ stage: "leaky_loop", bets: [], updatedAt: AT });
    expect(plan.now).toBeNull();
    expect(plan.next).toEqual([]);
    expect(plan.later).toEqual([]);
  });
});

describe("stage-gate predicates", () => {
  it("isScaleBudgetBet is true ONLY for budget-lever bets", () => {
    expect(isScaleBudgetBet({ lever: "budget" })).toBe(true);
    expect(isScaleBudgetBet({ lever: "lifecycle" })).toBe(false);
    expect(isScaleBudgetBet({ lever: "social" })).toBe(false);
  });
  it("isEarlyStage covers data_not_ready + pre_loop, not leaky_loop", () => {
    expect(isEarlyStage("data_not_ready")).toBe(true);
    expect(isEarlyStage("pre_loop")).toBe(true);
    expect(isEarlyStage("leaky_loop")).toBe(false);
  });
});
