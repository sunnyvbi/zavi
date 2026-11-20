
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ series: vi.fn(), adSets: vi.fn() }));
vi.mock("../../daily_series", () => ({ fetchMetaDailySeries: (...a: unknown[]) => mocks.series(...a) }));
vi.mock("../../list_ad_sets", () => ({ enumerateCampaignAdSets: (...a: unknown[]) => mocks.adSets(...a) }));

import { evaluateCutGuard, briefForCampaign } from "../_cut-guard";
import type { CampaignBrief, FunnelLabel, Confidence, Posture, WindowAgg } from "@/services/growth/perf-brief/brief";

function agg(o: Partial<WindowAgg> = {}): WindowAgg {
  return {
    days: 7, spend_usd: 1400, impressions: 35000, clicks: 700, conversions: 182,
    purchases: 1, sign_ups: 182, leads: 0, purchase_value_usd: 180,
    ctr_percent: 2, cvr_percent: 26, signup_cvr_percent: 26, cpa_usd: 7.7,
    cost_per_signup_usd: 7.69, cost_per_purchase_usd: 1400, roas: 0.13, ...o,
  };
}
function brief(label: FunnelLabel, conf: Confidence, posture: Posture, settled: Partial<WindowAgg> = {}): CampaignBrief {
  return {
    campaign_id: "c1", campaign_name: "New Conversions Campaign", ad_set_id: "as1", ad_set_name: "Set A",
    window_days: 30, settled_cutoff: "2026-06-25", settled: agg(settled), prior: agg(),
    maturing_days: 4, confidence: conf, funnel_label: label, posture, judged_on: "unknown", notes: [],
  };
}

describe("evaluateCutGuard", () => {
  it("BLOCKS an agent cut of a campaign bought on reach and clicks, even a settled zero-result one", () => {
    const b = { ...brief("underperforming_settled", "adequate", "NO_DECISION", { purchases: 0, sign_ups: 0, roas: 0 }), judged_on: "reach_and_clicks" as const };
    const v = evaluateCutGuard(b, { operatorDirected: false });
    expect(v.block).toBe(true);
    expect(v.reason).toBe("cut_blocked_objective_not_conversions");
    expect(v.guidance).toMatch(/objective/);
  });

  it("still ALLOWS the founder's own cut of a reach-and-clicks campaign", () => {
    const b = { ...brief("underperforming_settled", "adequate", "NO_DECISION"), judged_on: "reach_and_clicks" as const };
    expect(evaluateCutGuard(b, { operatorDirected: true }).block).toBe(false);
  });

  it("unknown objective keeps today's verdict (a settled money-waster is still allowed)", () => {
    const b = brief("underperforming_settled", "adequate", "CUT_CANDIDATE", { purchases: 0, sign_ups: 0, roas: 0 });
    expect(evaluateCutGuard(b, { operatorDirected: false }).block).toBe(false);
  });

  it("BLOCKS an agent cut when the ad is working (181-signups case)", () => {
    const v = evaluateCutGuard(brief("top_funnel_working_bottleneck_below_click", "thin", "INVESTIGATE_FUNNEL"), { operatorDirected: false });
    expect(v.block).toBe(true);
    expect(v.reason).toBe("cut_blocked_top_funnel_working");
    expect(v.guidance).toMatch(/Do NOT cut/i);
    expect(v.guidance).toMatch(/below the click/i);
  });

  it("BLOCKS an agent cut on insufficient settled signal (conversion lag / thin)", () => {
    const v = evaluateCutGuard(brief("maturing_insufficient", "inadequate", "NO_DECISION"), { operatorDirected: false });
    expect(v.block).toBe(true);
    expect(v.reason).toBe("cut_blocked_insufficient_settled_signal");
    expect(v.guidance).toMatch(/Hold/i);
  });

  it("ALLOWS a cut on a genuine settled MONEY-WASTER: real spend+clicks, 0 purchases, 0 signups, ~0 ROAS (codex P1 — reachable allow path)", () => {
    const v = evaluateCutGuard(
      brief("click_no_convert", "thin", "INVESTIGATE_FUNNEL", {
        days: 9, spend_usd: 150, clicks: 220, conversions: 0, purchases: 0, sign_ups: 0, purchase_value_usd: 0, roas: 0,
      }),
      { operatorDirected: false },
    );
    expect(v.block).toBe(false);
  });

  it("BLOCKS a cut on a HEALTHY WINNER (purchases + ROAS) — contradicts the brief (codex P1)", () => {
    const v = evaluateCutGuard(
      brief("converting_healthy", "adequate", "SCALE", { purchases: 28, sign_ups: 40, roas: 6, purchase_value_usd: 8400 }),
      { operatorDirected: false },
    );
    expect(v.block).toBe(true);
    expect(v.reason).toBe("cut_blocked_brief_contradicts");
    expect(v.guidance).toMatch(/winner/i);
  });

  it("BLOCKS a cut on a campaign producing down-funnel signal (some purchases, not a waster)", () => {
    const v = evaluateCutGuard(
      brief("converting_healthy", "thin", "HOLD", { days: 9, spend_usd: 300, clicks: 200, purchases: 3, sign_ups: 6, roas: 0.8, purchase_value_usd: 240 }),
      { operatorDirected: false },
    );
    expect(v.block).toBe(true);
    expect(v.reason).toBe("cut_blocked_brief_contradicts");
  });

  it("NEVER blocks an operator-typed cut, even on a working ad", () => {
    const v = evaluateCutGuard(brief("top_funnel_working_bottleneck_below_click", "thin", "INVESTIGATE_FUNNEL"), { operatorDirected: true });
    expect(v.block).toBe(false);
  });

  it("does NOT block when no brief is available (fail open — no false stops on API errors)", () => {
    const v = evaluateCutGuard(null, { operatorDirected: false });
    expect(v.block).toBe(false);
  });

  it("S1: a cgo-originated cut with no brief is BLOCKED (fail closed: Autopilot never cuts blind)", () => {
    const v = evaluateCutGuard(null, { operatorDirected: false, cgoOriginated: true });
    expect(v).toMatchObject({ block: true, reason: "cut_blocked_no_brief_autopilot" });
  });

  it("S1: a founder-typed cut stays allowed with no brief, even when cgo runs the ads", () => {
    expect(evaluateCutGuard(null, { operatorDirected: true, cgoOriginated: true }).block).toBe(false);
  });
});

describe("briefForCampaign resolves an engagement campaign from its ad sets", () => {
  const asOf = new Date("2026-06-30T12:00:00Z");
  const rows = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-06-${String(10 + i).padStart(2, "0")}`,
    campaign_id: "c1", campaign_name: "Engagement", ad_set_id: null, ad_set_name: null,
    spend_usd: 20, impressions: 5000, clicks: 40, ctr_percent: 0.8, cpm_usd: 4,
    conversions: 0, purchases: 0, sign_ups: 0, leads: 0, purchase_value_usd: 0,
    objective: "OUTCOME_ENGAGEMENT", judged_on: "unknown" as const,
  }));
  const set = (goal: string, status = "ACTIVE") => ({ id: goal + status, optimization_goal: goal, configured_status: status, effective_status: status });

  beforeEach(() => {
    mocks.series.mockReset().mockResolvedValue({ rows, truncated: false });
    mocks.adSets.mockReset();
  });

  it("BLOCKS an agent cut when every running ad set optimises for POST_ENGAGEMENT", async () => {
    mocks.adSets.mockResolvedValue([set("POST_ENGAGEMENT"), set("POST_ENGAGEMENT"), set("OFFSITE_CONVERSIONS", "PAUSED")]);
    const b = await briefForCampaign("t1", "c1", asOf);
    expect(mocks.adSets).toHaveBeenCalledWith("t1", "c1");
    expect(b?.judged_on).toBe("reach_and_clicks");
    const v = evaluateCutGuard(b, { operatorDirected: false });
    expect(v.block).toBe(true);
    expect(v.reason).toBe("cut_blocked_objective_not_conversions");
  });

  it("still ALLOWS the founder's own cut of that campaign", async () => {
    mocks.adSets.mockResolvedValue([set("POST_ENGAGEMENT")]);
    const b = await briefForCampaign("t1", "c1", asOf);
    expect(evaluateCutGuard(b, { operatorDirected: true }).block).toBe(false);
  });

  it.each(["CONVERSATIONS", "OFFSITE_CONVERSIONS"])("one %s ad set -> judged on conversions, settled zero-result cut allowed", async (goal) => {
    mocks.adSets.mockResolvedValue([set("POST_ENGAGEMENT"), set(goal)]);
    const b = await briefForCampaign("t1", "c1", asOf);
    expect(b?.judged_on).toBe("conversions");
    expect(evaluateCutGuard(b, { operatorDirected: false }).block).toBe(false);
  });

  it("ad set read fails -> unknown, today's verdict (allowed)", async () => {
    mocks.adSets.mockRejectedValue(new Error("graph down"));
    const b = await briefForCampaign("t1", "c1", asOf);
    expect(b?.judged_on).toBe("unknown");
    expect(evaluateCutGuard(b, { operatorDirected: false }).block).toBe(false);
  });

  it("mixed reach + unrecognised goal -> unknown (allowed as today)", async () => {
    mocks.adSets.mockResolvedValue([set("POST_ENGAGEMENT"), set("AUTOMATIC_OBJECTIVE")]);
    const b = await briefForCampaign("t1", "c1", asOf);
    expect(b?.judged_on).toBe("unknown");
    expect(evaluateCutGuard(b, { operatorDirected: false }).block).toBe(false);
  });

  it("a campaign whose objective already resolves never reads its ad sets", async () => {
    mocks.series.mockResolvedValue({ rows: rows.map((r) => ({ ...r, objective: "OUTCOME_SALES", judged_on: "conversions" as const })), truncated: false });
    await briefForCampaign("t1", "c1", asOf);
    expect(mocks.adSets).not.toHaveBeenCalled();
  });
});
