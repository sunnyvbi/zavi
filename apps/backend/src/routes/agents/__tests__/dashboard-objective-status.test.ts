import { describe, it, expect } from "vitest";
import {
  statusForObjective,
  triageState,
  deriveTriageReasons,
  isRevenueObjective,
  isUnprofitableCampaign,
  buildObjectiveGroups,
  combineOptimizationEvents,
  type CampaignLite,
} from "@/routes/agents/dashboard";

describe("deriveTriageReasons (the 'why' tags)", () => {
  const base = {
    objective_status: "hold" as const,
    is_revenue_objective: true,
    roas: 3 as number | null,
    spend_usd: 200,
    frequency: 1.5 as number | null,
    impressions: 5000,
    recent_daily_spend_usd: 7 as number | null,
    window_daily_avg_usd: 7 as number | null,
    active_daily_budget_usd: 10 as number | null,
    purchases: 30,
    tracking_degraded: false,
  };

  it("a clean, healthy campaign gets NO tags (never fabricates a reason)", () => {
    expect(deriveTriageReasons(base)).toEqual([]);
  });

  it("flags losing money on a revenue objective below 1x ROAS", () => {
    expect(deriveTriageReasons({ ...base, roas: 0.39 })).toContain("Losing money (0.39x ROAS)");
  });

  it("flags audience saturation only above the frequency floor AND impression floor", () => {
    expect(deriveTriageReasons({ ...base, frequency: 4.2, impressions: 5000 })).toContain(
      "Audience saturated (freq 4.2)",
    );
    expect(deriveTriageReasons({ ...base, frequency: 4.2, impressions: 500 })).not.toContain(
      "Audience saturated (freq 4.2)",
    );
  });

  it("flags a spend spike when recent burn >> window average", () => {
    expect(
      deriveTriageReasons({ ...base, recent_daily_spend_usd: 50, window_daily_avg_usd: 10 }),
    ).toContain("Spend spiking vs its recent baseline");
  });

  it("flags underspending on a strong winner that can't fill its cap", () => {
    expect(
      deriveTriageReasons({ ...base, roas: 16, active_daily_budget_usd: 80, recent_daily_spend_usd: 11 }),
    ).toContain("Underspending its budget — diagnose delivery, don't just raise it");
  });

  it("flags a thin sample on a revenue objective", () => {
    expect(deriveTriageReasons({ ...base, purchases: 3 })).toContain("Thin sample (n=3)");
  });

  it("flags tracking degraded", () => {
    expect(deriveTriageReasons({ ...base, tracking_degraded: true })).toContain(
      "Tracking degraded — treat ROAS as unverified",
    );
  });

  it("does NOT flag losing-money / thin-sample for a non-revenue (funnel) objective", () => {
    const r = deriveTriageReasons({ ...base, is_revenue_objective: false, roas: 0, purchases: 2 });
    expect(r).not.toContain("Thin sample (n=2)");
    expect(r.some((x) => x.startsWith("Losing money"))).toBe(false);
  });
});

describe("triageState (action-queue bucketing)", () => {
  const base = { has_pending_change: false, is_delivering: true, recently_changed: false };

  it("a pending agent proposal makes a campaign settling (already acted)", () => {
    expect(triageState({ ...base, objective_status: "cut", has_pending_change: true })).toBe("settling");
  });

  it("a paused-live campaign (not delivering) is settling, not a fresh decision", () => {
    expect(triageState({ ...base, objective_status: "cut", is_delivering: false })).toBe("settling");
  });

  it("a campaign whose budget/status was JUST changed is settling (let it settle)", () => {
    expect(triageState({ ...base, objective_status: "cut", recently_changed: true })).toBe("settling");
  });

  it("a delivering loser with no pending/recent change is act_now (low budget is NOT proof of handled)", () => {
    expect(triageState({ ...base, objective_status: "cut" })).toBe("act_now");
  });

  it("scale needs a decision now", () => {
    expect(triageState({ ...base, objective_status: "scale" })).toBe("act_now");
  });

  it("watch -> watch, hold -> ok", () => {
    expect(triageState({ ...base, objective_status: "watch" })).toBe("watch");
    expect(triageState({ ...base, objective_status: "hold" })).toBe("ok");
  });
});

describe("combineOptimizationEvents (campaign-row Optimization column)", () => {
  it("joins distinct events so a mixed-objective campaign shows both", () => {
    expect(combineOptimizationEvents(["Purchase", "InitCheckout"])).toBe(
      "Purchase + InitCheckout",
    );
  });

  it("de-dupes repeated events (multiple ad sets on the same event)", () => {
    expect(combineOptimizationEvents(["Purchase", "Purchase"])).toBe("Purchase");
  });

  it("drops null/blank events and returns null when nothing reports one", () => {
    expect(combineOptimizationEvents([null, "", undefined])).toBeNull();
    expect(combineOptimizationEvents([])).toBeNull();
    expect(combineOptimizationEvents([null, "Lead"])).toBe("Lead");
  });

  it("preserves first-seen order", () => {
    expect(combineOptimizationEvents(["Lead", "Purchase", "Lead"])).toBe("Lead + Purchase");
  });
});

describe("isRevenueObjective", () => {
  it("is true only for the purchase-revenue objectives", () => {
    expect(isRevenueObjective("renter_bookings")).toBe(true);
    expect(isRevenueObjective("remarketing")).toBe(true);
    expect(isRevenueObjective("expansion_metros")).toBe(true);
    expect(isRevenueObjective("renter_signups")).toBe(false);
    expect(isRevenueObjective("host_supply")).toBe(false);
    expect(isRevenueObjective("uncategorized")).toBe(false);
  });
});

describe("statusForObjective", () => {
  it("REGRESSION: a signup campaign with spend + purchase-ROAS 0 is watch, NOT cut", () => {
    expect(
      statusForObjective({ objective: "renter_signups", spend_usd: 50, roas: 0, primary_result_count: 30, purchases: 0 }),
    ).toBe("watch");
  });

  it("REGRESSION: a host-supply campaign with spend + ROAS 0 is watch, NOT cut", () => {
    expect(
      statusForObjective({ objective: "host_supply", spend_usd: 50, roas: 0, primary_result_count: 12, purchases: 0 }),
    ).toBe("watch");
  });

  it("pins the zero-result pause edge for soft objectives (must not regress to watch)", () => {
    expect(
      statusForObjective({ objective: "renter_signups", spend_usd: 25, roas: 0, primary_result_count: 0, purchases: 0 }),
    ).toBe("pause");
    expect(
      statusForObjective({ objective: "host_supply", spend_usd: 25, roas: null, primary_result_count: 0, purchases: 0 }),
    ).toBe("pause");
  });

  it("still cuts a genuinely-bleeding REVENUE campaign (ROAS < 1)", () => {
    expect(
      statusForObjective({ objective: "renter_bookings", spend_usd: 50, roas: 0.4, primary_result_count: 5, purchases: 5 }),
    ).toBe("cut");
    expect(
      statusForObjective({ objective: "remarketing", spend_usd: 50, roas: 0.5, primary_result_count: 3, purchases: 3 }),
    ).toBe("cut");
    expect(
      statusForObjective({ objective: "expansion_metros", spend_usd: 50, roas: 0.4, primary_result_count: 2, purchases: 2 }),
    ).toBe("cut");
  });

  it("pauses a revenue campaign with real spend and zero results", () => {
    expect(
      statusForObjective({ objective: "renter_bookings", spend_usd: 25, roas: null, primary_result_count: 0, purchases: 0 }),
    ).toBe("pause");
  });

  it("scales a strong booking campaign (purchases >= 10 && ROAS >= 1.5)", () => {
    expect(
      statusForObjective({ objective: "renter_bookings", spend_usd: 200, roas: 1.8, primary_result_count: 12, purchases: 12 }),
    ).toBe("scale");
  });

  it("does NOT scale a thin-sample booking campaign even at high ROAS (-> hold)", () => {
    expect(
      statusForObjective({ objective: "renter_bookings", spend_usd: 30, roas: 2.0, primary_result_count: 3, purchases: 3 }),
    ).toBe("hold");
  });

  it("does NOT cut an uncategorized campaign at ROAS < 1 (-> hold)", () => {
    expect(
      statusForObjective({ objective: "uncategorized", spend_usd: 30, roas: 0.5, primary_result_count: 4, purchases: 0 }),
    ).toBe("hold");
  });

  it("does NOT scale a winner that is underspending its daily cap (-> hold)", () => {
    expect(
      statusForObjective({
        objective: "renter_bookings",
        spend_usd: 346,
        roas: 16.4,
        primary_result_count: 27,
        purchases: 27,
        active_daily_budget_usd: 80,
        recent_daily_spend_usd: 11.5,
      }),
    ).toBe("hold");
  });

  it("DOES scale a winner that is fully spending its daily cap", () => {
    expect(
      statusForObjective({
        objective: "renter_bookings",
        spend_usd: 2400,
        roas: 1.8,
        primary_result_count: 30,
        purchases: 30,
        active_daily_budget_usd: 80,
        recent_daily_spend_usd: 80,
      }),
    ).toBe("scale");
  });

  it("DOES scale a recently-raised winner now filling its new cap (recent != window-avg)", () => {
    expect(
      statusForObjective({
        objective: "renter_bookings",
        spend_usd: 460,
        roas: 1.8,
        primary_result_count: 18,
        purchases: 18,
        active_daily_budget_usd: 80,
        recent_daily_spend_usd: 78,
      }),
    ).toBe("scale");
  });

  it("holds a would-be winner with ZERO recent delivery (absent from last_7d => $0)", () => {
    expect(
      statusForObjective({
        objective: "renter_bookings",
        spend_usd: 346,
        roas: 16.4,
        primary_result_count: 27,
        purchases: 27,
        active_daily_budget_usd: 80,
        recent_daily_spend_usd: 0,
      }),
    ).toBe("hold");
  });

  it("does NOT trigger the underspend gate when the daily cap is unknown (-> scale)", () => {
    expect(
      statusForObjective({
        objective: "renter_bookings",
        spend_usd: 346,
        roas: 16.4,
        primary_result_count: 27,
        purchases: 27,
        active_daily_budget_usd: null,
        recent_daily_spend_usd: 11.5,
      }),
    ).toBe("scale");
  });

  it("does NOT trigger the underspend gate when recent spend is unknown (-> scale)", () => {
    expect(
      statusForObjective({
        objective: "renter_bookings",
        spend_usd: 346,
        roas: 16.4,
        primary_result_count: 27,
        purchases: 27,
        active_daily_budget_usd: 80,
        recent_daily_spend_usd: null,
      }),
    ).toBe("scale");
  });

  it("scales a winner just above the utilization floor (no false trigger)", () => {
    expect(
      statusForObjective({
        objective: "renter_bookings",
        spend_usd: 56,
        roas: 2.2,
        primary_result_count: 14,
        purchases: 14,
        active_daily_budget_usd: 10,
        recent_daily_spend_usd: 8,
      }),
    ).toBe("scale");
  });
});

describe("isUnprofitableCampaign (attention feed gate)", () => {
  it("does NOT flag a funnel campaign with ROAS 0 as unprofitable", () => {
    expect(isUnprofitableCampaign({ objective_key: "renter_signups", spend_usd: 50, roas: 0 })).toBe(false);
    expect(isUnprofitableCampaign({ objective_key: "host_supply", spend_usd: 50, roas: 0 })).toBe(false);
  });
  it("flags a revenue campaign below break-even", () => {
    expect(isUnprofitableCampaign({ objective_key: "renter_bookings", spend_usd: 50, roas: 0.4 })).toBe(true);
  });
  it("ignores tiny spend and missing/healthy ROAS", () => {
    expect(isUnprofitableCampaign({ objective_key: "renter_bookings", spend_usd: 3, roas: 0.4 })).toBe(false);
    expect(isUnprofitableCampaign({ objective_key: "renter_bookings", spend_usd: 50, roas: null })).toBe(false);
    expect(isUnprofitableCampaign({ objective_key: "renter_bookings", spend_usd: 50, roas: 1.2 })).toBe(false);
  });
});

function makeCampaign(over: Partial<CampaignLite>): CampaignLite {
  return {
    channel: "meta",
    campaign_id: "c1",
    campaign_name: "Test",
    spend_usd: 0,
    conversions: 0,
    revenue_usd: 0,
    roas: null,
    cpa_usd: null,
    impressions: 0,
    clicks: 0,
    ctr_percent: null,
    cpc_usd: null,
    cpm_usd: null,
    frequency: null,
    purchases: 0,
    sign_ups: 0,
    leads: 0,
    cost_per_booking_usd: null,
    active_daily_budget_usd: null,
    is_delivering: true,
    pending_change: null,
    recent_daily_spend_usd: null,
    triage_state: "ok",
    triage_reasons: [],
    objective_key: "uncategorized",
    objective_label: "Uncategorized",
    primary_result_label: "conversions",
    primary_result_count: 0,
    primary_cost_label: null,
    primary_cost_usd: null,
    objective_status: "hold",
    confidence_reasons: [],
    manage_url: null,
    ...over,
  };
}

describe("buildObjectiveGroups (aggregate status inherits the gated cut logic)", () => {
  it("a renter_signups group with aggregate purchase-ROAS 0 is watch, NEVER cut", () => {
    const groups = buildObjectiveGroups(
      [
        makeCampaign({ campaign_id: "s1", objective_key: "renter_signups", spend_usd: 30, revenue_usd: 0, sign_ups: 40 }),
        makeCampaign({ campaign_id: "s2", objective_key: "renter_signups", spend_usd: 30, revenue_usd: 0, sign_ups: 25 }),
      ],
      null,
    );
    const signups = groups.find((g) => g.objective_key === "renter_signups");
    expect(signups).toBeDefined();
    expect(signups?.status).toBe("watch");
    expect(signups?.status).not.toBe("cut");
  });

  it("a bleeding renter_bookings group (aggregate ROAS < 1) is still cut", () => {
    const groups = buildObjectiveGroups(
      [makeCampaign({ campaign_id: "b1", objective_key: "renter_bookings", spend_usd: 100, revenue_usd: 40, purchases: 4 })],
      null,
    );
    const bookings = groups.find((g) => g.objective_key === "renter_bookings");
    expect(bookings?.status).toBe("cut");
  });
});
