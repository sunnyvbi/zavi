import { describe, it, expect } from "vitest";
import {
  BUSINESS_CONTROL_DEFAULTS as defaults,
  businessPolicySchema,
  judgeBusinessResult,
  recommendBusinessPolicy,
  type BusinessEvidence,
} from "../business-control-policy";
import {
  assessExperiment,
  experimentScope,
  experimentSpendReading,
  experimentSpent,
  type ControlledObject,
  type Experiment,
} from "../experiment-controls";
import {
  businessEvidence,
  experimentStopState,
} from "../business-control-runtime";
import type { AdObject } from "../ad-spend-controller";
const now = new Date("2026-10-09T12:00:00Z");
const policy = {
  ...defaults,
  enabled: true,
  automatic_stops: true,
  revision: 1,
  updated_at: now.toISOString(),
};
const evidence: BusinessEvidence = {
  spend: 250,
  results: 10,
  revenue: 250,
  age_days: 7,
  fresh: true,
  tracking_ok: true,
  matches_goal: true,
  brand: false,
};
const object: ControlledObject = {
  platform: "meta",
  account_id: "act_1",
  object_id: "s1",
  level: "ad_set",
  campaign_id: "c1",
  name: "test",
  budget_kind: "daily",
  budget_usd: 10,
  status: "ACTIVE",
  currency: "USD",
  as_of: now.toISOString(),
};
const experiment: Experiment = {
  id: "e1",
  decision_id: null,
  name: "test",
  hypothesis: "test",
  platform: "meta",
  account_id: "act_1",
  object_id: "s1",
  level: "ad_set",
  budget_usd: 100,
  stop_on_loss: false,
  baseline: { date: "2026-10-08", amounts: { "s1:2026-10-08": 50 } },
  started_at: "2026-10-08T12:00:00Z",
  ends_at: "2026-10-15T12:00:00Z",
  policy_revision: 1,
  spent_usd: 0,
  spend_highwater: {},
  exposure_usd: 0,
  state: "monitoring",
  reason: null,
  pause_action_id: null,
  checked_at: null,
  stopped_at: null,
  stop_requested_at: null,
};
describe("owner business limits", () => {
  it("prefills editable recommendations without granting authority", () => {
    const r = recommendBusinessPolicy([]);
    expect(r.policy).toEqual(defaults);
    expect(
      businessPolicySchema.parse({ ...r.policy, max_cpa_usd: 13, min_roas: 2 }),
    ).toMatchObject({ max_cpa_usd: 13, min_roas: 2, automatic_stops: false });
  });
  it("uses eligible measured purchase costs rather than a market benchmark", () =>
    expect(
      recommendBusinessPolicy([
        { ...evidence, spend: 120 },
        { ...evidence, spend: 200 },
        { ...evidence, spend: 10000, tracking_ok: false },
      ]).policy.max_cpa_usd,
    ).toBe(20));
  it.each([
    { max_cpa_usd: NaN },
    { min_roas: 0 },
    { exploration_percent: 101 },
    { min_results: 1.5 },
    { reporting_delay_hours: 0 },
    { automatic_stops: "yes" },
    { enabled: null },
  ])("rejects invalid settings %j", (override) =>
    expect(
      businessPolicySchema.safeParse({ ...defaults, ...override }).success,
    ).toBe(false),
  );
  it("accepts the CPA threshold and cuts only over it", () => {
    expect(judgeBusinessResult(policy, evidence).kind).toBe("winner");
    expect(
      judgeBusinessResult(policy, { ...evidence, spend: 250.01 }).kind,
    ).toBe("loser");
  });
  it("uses purchase revenue for ROAS", () => {
    expect(
      judgeBusinessResult({ ...policy, metric: "roas" }, evidence).kind,
    ).toBe("winner");
    expect(
      judgeBusinessResult(
        { ...policy, metric: "roas" },
        { ...evidence, revenue: 249 },
      ).kind,
    ).toBe("loser");
    expect(
      judgeBusinessResult(
        { ...policy, metric: "roas" },
        { ...evidence, revenue: null },
      ).kind,
    ).toBe("unknown");
  });
  it.each([
    { results: null },
    { fresh: false },
    { tracking_ok: false },
    { matches_goal: false },
    { spend: NaN },
    { age_days: NaN },
  ])("holds unread evidence %j", (e) =>
    expect(judgeBusinessResult(policy, { ...evidence, ...e }).kind).toBe(
      "unknown",
    ),
  );
  it.each([{ age_days: 6.99 }, { results: 9 }, { spend: 49.99 }])(
    "waits for minimum evidence %j",
    (e) =>
      expect(judgeBusinessResult(policy, { ...evidence, ...e }).kind).toBe(
        "immature",
      ),
  );
  it("does not wait forever for zero results but respects twice the saved CPA", () => {
    expect(
      judgeBusinessResult(
        { ...policy, max_cpa_usd: 40 },
        { ...evidence, results: 0, spend: 79.99 },
      ).kind,
    ).toBe("immature");
    expect(
      judgeBusinessResult(
        { ...policy, max_cpa_usd: 40 },
        { ...evidence, results: 0, spend: 80 },
      ).kind,
    ).toBe("loser");
  });
  it("protects brand and never substitutes clicks for unread purchases", () => {
    expect(judgeBusinessResult(policy, { ...evidence, brand: true }).kind).toBe(
      "protected",
    );
    expect(
      businessEvidence(
        {
          spend7d_usd: 100,
          results7d: 100,
          result_kind: "conversions",
          created_at: "2026-09-01",
        } as AdObject,
        true,
        now,
        true,
        true,
      ).results,
    ).toBeNull();
  });

});
describe("experiment accounting and stop confirmation", () => {
  it("subtracts pre-test spend and counts late corrections monotonically", () => {
    const first = experimentSpendReading(experiment, [
      { object_id: "s1", spend_date: "2026-10-08", amount_usd: 70 },
    ]);
    expect(first.spent_usd).toBe(20);
    const second = experimentSpendReading({ ...experiment, ...first }, [
      { object_id: "s1", spend_date: "2026-10-08", amount_usd: 55 },
      { object_id: "s1", spend_date: "2026-10-09", amount_usd: 10 },
    ]);
    expect(second.spent_usd).toBe(30);
    expect(experimentSpent({ ...experiment, ...second }, [])).toBe(30);
  });
  it("rejects duplicate or corrupt ledger rows", () => {
    const r = { object_id: "s1", spend_date: "2026-10-09", amount_usd: 1 };
    expect(() => experimentSpent(experiment, [r, r])).toThrow();
    expect(() =>
      experimentSpent(experiment, [{ ...r, amount_usd: "bad" }]),
    ).toThrow();
  });
  it("counts every CBO child and rejects shared or lifetime budgets", () => {
    const campaign = {
      ...object,
      object_id: "c1",
      level: "campaign" as const,
      campaign_id: null,
    };
    expect(
      experimentScope(campaign, [
        campaign,
        object,
        { ...object, object_id: "s2" },
      ]),
    ).toHaveLength(2);
    for (const budget_kind of ["shared", "lifetime", "campaign_level"])
      expect(() =>
        experimentScope({ ...object, budget_kind }, [object]),
      ).toThrow(/separate daily/);
  });
  it("reserves delayed spend plus the next hourly check before hitting the cap", () => {
    const r = assessExperiment(experiment, object, 80, policy, now);
    expect(r.stop).toBe(true);
    expect(r.exposure_usd).toBe(100.84);
    expect(r.reason).toMatch(/reporting delay/);
  });
  it("stops at deadline even with no observed spend", () =>
    expect(
      assessExperiment(
        { ...experiment, ends_at: now.toISOString() },
        object,
        0,
        policy,
        now,
      ).stop,
    ).toBe(true));
  it("does not mistake stale paused inventory for a confirmed stop", () => {
    const a = assessExperiment(
      experiment,
      { ...object, status: "PAUSED", as_of: "2026-10-09T06:00:00Z" },
      0,
      policy,
      now,
    );
    expect(a.stop).toBe(true);
    expect(a.paused).toBe(false);
  });
  it("never un-latches a requested stop after a failed read or correction", () =>
    expect(
      assessExperiment(
        {
          ...experiment,
          state: "needs_attention",
          stop_requested_at: now.toISOString(),
        },
        object,
        0,
        policy,
        now,
      ).stop,
    ).toBe(true));
  it("waits for queued actions and readback newer than execution", () => {
    const action = {
      id: "a1",
      exec_status: "queued",
      executed_at: null,
      exec_claimed_at: null,
      exec_payload: { object_id: "s1" },
    };
    const e = { ...experiment, pause_action_id: "a1" };
    expect(experimentStopState(e, object, { paused: true }, [action])).toEqual({
      confirmed: false,
      wait: true,
    });
    expect(
      experimentStopState(e, object, { paused: true }, [
        { ...action, exec_status: "executed", executed_at: now.toISOString() },
      ]),
    ).toEqual({ confirmed: false, wait: true });
    expect(
      experimentStopState(e, object, { paused: true }, [
        {
          ...action,
          exec_status: "executed",
          executed_at: "2026-10-09T11:59:00Z",
        },
      ]),
    ).toEqual({ confirmed: true, wait: false });
  });
  it("retains an unknown pause and retries a failed pause only after readback", () => {
    const e = { ...experiment, pause_action_id: "missing" };
    expect(experimentStopState(e, object, { paused: false }, []).wait).toBe(
      true,
    );
    expect(
      experimentStopState(e, object, { paused: false }, [
        {
          id: "missing",
          exec_status: "failed",
          exec_claimed_at: "2026-10-09T11:59:00Z",
          executed_at: null,
          exec_payload: { object_id: "s1" },
        },
      ]).wait,
    ).toBe(false);
  });
});
