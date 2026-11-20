
import { describe, it, expect } from "vitest";
import {
  budgetDelta,
  activeWindowContext,
  reversibility,
  type CampaignContextRow,
} from "../decisionSupport";

describe("budgetDelta — budget changes (exact only)", () => {
  it("raise: exact daily + monthly projection, signed", () => {
    const d = budgetDelta("meta_ads.update_ad_set_budget", {
      daily_budget_usd: 144,
      expected_current_daily_budget_usd: 72,
    });
    expect(d.kind).toBe("raise");
    expect(d.dailyDeltaUsd).toBe(72);
    expect(d.dailyLabel).toBe("+$72/day");
    expect(d.monthlyLabel).toBe("+$2,160/mo");
    expect(d.impactLine).toContain("more spend");
  });

  it("lower: signed down", () => {
    const d = budgetDelta("meta_ads.update_ad_set_budget_review", {
      daily_budget_usd: 50,
      expected_current_daily_budget_usd: 100,
    });
    expect(d.kind).toBe("lower");
    expect(d.dailyDeltaUsd).toBe(-50);
    expect(d.dailyLabel).toBe("−$50/day");
    expect(d.monthlyLabel).toBe("−$1,500/mo");
    expect(d.impactLine).toContain("cuts");
  });

  it("no-op delta → empty (no dollar line)", () => {
    const d = budgetDelta("meta_ads.update_ad_set_budget", {
      daily_budget_usd: 80,
      expected_current_daily_budget_usd: 80,
    });
    expect(d.kind).toBeNull();
    expect(d.dailyLabel).toBeNull();
  });

  it("missing from/to → empty (never fabricates)", () => {
    const d = budgetDelta("meta_ads.update_ad_set_budget", { daily_budget_usd: 80 });
    expect(d.kind).toBeNull();
    expect(d.dailyLabel).toBeNull();
    expect(d.monthlyLabel).toBeNull();
  });
});

describe("budgetDelta — pauses (exact freed daily only)", () => {
  it("pause with exact current daily budget → freed $/day + /mo", () => {
    const d = budgetDelta("meta_ads.set_status", {
      status: "PAUSED",
      expected_current_daily_budget_usd: 50,
    });
    expect(d.kind).toBe("pause");
    expect(d.dailyDeltaUsd).toBe(-50);
    expect(d.dailyLabel).toBe("−$50/day");
    expect(d.monthlyLabel).toBe("−$1,500/mo");
    expect(d.impactLine).toContain("Frees");
  });

  it("pause with NO daily figure → pause kind but no dollar line (no coarse projection)", () => {
    const d = budgetDelta("meta_ads.set_status", { status: "PAUSED" });
    expect(d.kind).toBe("pause");
    expect(d.dailyLabel).toBeNull();
    expect(d.monthlyLabel).toBeNull();
    expect(d.impactLine).toBeNull();
  });

  it("set_status that is NOT a pause (resume) → empty", () => {
    const d = budgetDelta("meta_ads.set_status", {
      status: "ACTIVE",
      expected_current_daily_budget_usd: 50,
    });
    expect(d.kind).toBeNull();
  });

  it("unrelated handler → empty", () => {
    expect(budgetDelta("github.open_pr", {}).kind).toBeNull();
    expect(budgetDelta(null, {}).kind).toBeNull();
  });
});

describe("activeWindowContext — single-window join, null-safe", () => {
  const campaigns: CampaignContextRow[] = [
    { campaign_id: "c1", campaign_name: "Alpha", spend_usd: 1200, roas: 2.4 },
    { campaign_id: "c2", campaign_name: "Beta", spend_usd: 300, roas: 0.4 },
  ];

  it("joins by campaign_id, surfaces spend/roas + tone for the window", () => {
    const ctx = activeWindowContext({ campaign_id: "c1" }, campaigns, "Last 7 days");
    expect(ctx).not.toBeNull();
    expect(ctx!.campaignName).toBe("Alpha");
    expect(ctx!.spendUsd).toBe(1200);
    expect(ctx!.roas).toBe(2.4);
    expect(ctx!.roasTone).toBe("good");
    expect(ctx!.windowLabel).toBe("Last 7 days");
  });

  it("ROAS below 1 → bad tone (never color-only — tone is the a11y signal)", () => {
    const ctx = activeWindowContext({ campaign_id: "c2" }, campaigns, "30d");
    expect(ctx!.roasTone).toBe("bad");
  });

  it("no campaign_id on the body → null", () => {
    expect(activeWindowContext({}, campaigns, "30d")).toBeNull();
  });

  it("campaign not in the current window's rows → null (degrades gracefully)", () => {
    expect(activeWindowContext({ campaign_id: "c9" }, campaigns, "30d")).toBeNull();
  });

  it("no campaigns at all → null", () => {
    expect(activeWindowContext({ campaign_id: "c1" }, [], "30d")).toBeNull();
    expect(activeWindowContext({ campaign_id: "c1" }, null, "30d")).toBeNull();
  });

  it("null roas → null tone (no divide-by-zero / no fabricated health)", () => {
    const ctx = activeWindowContext(
      { campaign_id: "c3" },
      [{ campaign_id: "c3", campaign_name: "Gamma", spend_usd: 0, roas: null }],
      "30d",
    );
    expect(ctx!.roas).toBeNull();
    expect(ctx!.roasTone).toBeNull();
  });

  it("missing window label → 'current window' fallback", () => {
    const ctx = activeWindowContext({ campaign_id: "c1" }, campaigns, null);
    expect(ctx!.windowLabel).toBe("current window");
  });
});

describe("reversibility — per handler", () => {
  it("set_status → reversible, instant, learning preserved", () => {
    const r = reversibility("meta_ads.set_status");
    expect(r.reversible).toBe(true);
    expect(r.line).toContain("re-activate in 1 click");
  });

  it("update_ad_set_budget → reversible", () => {
    expect(reversibility("meta_ads.update_ad_set_budget_review").reversible).toBe(true);
  });

  it("create_ad_set → reversible, ships PAUSED", () => {
    const r = reversibility("meta_ads.create_ad_set");
    expect(r.reversible).toBe(true);
    expect(r.line).toContain("ships PAUSED");
  });

  it("unknown handler → conservative not-one-click", () => {
    expect(reversibility("github.merge_pr").reversible).toBe(false);
    expect(reversibility(null).reversible).toBe(false);
  });
});
