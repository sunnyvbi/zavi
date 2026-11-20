
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CampaignBrief, WindowAgg } from "@/services/growth/perf-brief/brief";

vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("../_user-initiated-flag-check", () => ({ isUserInitiatedSpendApplyEnabled: vi.fn(async () => false) }));
vi.mock("../cap-reader", () => { const m = ({
  readTenantCapAndToday: vi.fn(async () => ({
    cap: { enabled: true, max_daily_budget_usd: 1000, max_pct_change_per_run: 0.25, max_daily_total_change_usd: 100 },
    today_total_change_usd: 0,
    currency: "USD",
    units_per_usd: 1,
  })),
}); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });

function agg(o: Partial<WindowAgg> = {}): WindowAgg {
  return {
    days: 7, spend_usd: 1400, impressions: 35000, clicks: 700, conversions: 182,
    purchases: 1, sign_ups: 182, leads: 0, purchase_value_usd: 180,
    ctr_percent: 2, cvr_percent: 26, signup_cvr_percent: 26, cpa_usd: 7.7,
    cost_per_signup_usd: 7.69, cost_per_purchase_usd: 1400, roas: 0.13, ...o,
  };
}
const WORKING: CampaignBrief = {
  campaign_id: "c1", campaign_name: "Conversions", ad_set_id: "as1", ad_set_name: "Set A",
  window_days: 30, settled_cutoff: "2026-09-20", settled: agg(), prior: agg(),
  maturing_days: 4, confidence: "thin", funnel_label: "top_funnel_working_bottleneck_below_click",
  posture: "INVESTIGATE_FUNNEL", judged_on: "unknown", notes: [],
};
vi.mock("../_cut-guard", async (orig) => ({
  ...(await orig<typeof import("../_cut-guard")>()),
  briefForAdSet: vi.fn(async () => WORKING),
}));

const runs = new Map<string, { tenant_id: string; payload: unknown }>();
const runReadFails = { on: false };
const runReads: Array<{ tenant: string; id: unknown }> = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      if (table !== "agent_runs") throw new Error(`unexpected table ${table}`);
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => ((filters[c] = v), q),
        maybeSingle: async () => {
          runReads.push({ tenant, id: filters.id });
          if (runReadFails.on) return { data: null, error: { message: "db down" } };
          const r = runs.get(String(filters.id));
          return { data: r && r.tenant_id === tenant ? { payload: r.payload } : null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import type { ToolContext } from "@/services/tools/types";

function ctx(run_id?: string) {
  const emit = vi.fn(async () => "decision-1");
  const c: ToolContext = { tenant_id: "tenant-1", log: () => {}, emit_decision: emit, run_trigger: "scheduled", run_id };
  return { c, emit };
}
const CUT = { ad_set_id: "as1", current_daily_budget_usd: 100, proposed_daily_budget_usd: 60, rationale: "brake" };

describe("the cut guard and budget brake runs", () => {
  beforeEach(() => {
    runs.clear();
    runReads.length = 0;
    runReadFails.on = false;
  });

  it("a brake run's cut is proposed even though the ad set is working", async () => {
    runs.set("run-brake", { tenant_id: "tenant-1", payload: { brake: true } });
    const { c, emit } = ctx("run-brake");
    const out = (await metaProposeBudgetChangeTool.execute(c, CUT)) as Record<string, unknown>;
    expect(out.blocked).toBeUndefined();
    expect(out.brake_cut).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(runReads).toEqual([{ tenant: "tenant-1", id: "run-brake" }]);
  });

  it("a normal agent run's cut on a working ad set is still blocked", async () => {
    runs.set("run-normal", { tenant_id: "tenant-1", payload: { reason: "scheduled" } });
    const { c, emit } = ctx("run-normal");
    const out = (await metaProposeBudgetChangeTool.execute(c, CUT)) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(out.code).toBe("cut_blocked_top_funnel_working");
    expect(emit).not.toHaveBeenCalled();
  });

  it("a model-supplied field claiming a brake cut is ignored", async () => {
    runs.set("run-normal", { tenant_id: "tenant-1", payload: {} });
    const { c, emit } = ctx("run-normal");
    const out = (await metaProposeBudgetChangeTool.execute(c, { ...CUT, brake: true, payload: { brake: true } })) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("only exactly `brake: true` counts: a string or a truthy number does not", async () => {
    for (const v of ["true", 1, "yes"]) {
      runs.set("run-x", { tenant_id: "tenant-1", payload: { brake: v } });
      const { c } = ctx("run-x");
      expect(((await metaProposeBudgetChangeTool.execute(c, CUT)) as Record<string, unknown>).blocked).toBe(true);
    }
  });

  it("fails closed: an unreadable run, a missing run, no run id, or another tenant's brake run keeps the guard", async () => {
    runs.set("run-other", { tenant_id: "tenant-2", payload: { brake: true } });
    runReadFails.on = true;
    expect(((await metaProposeBudgetChangeTool.execute(ctx("run-brake").c, CUT)) as Record<string, unknown>).blocked).toBe(true);
    runReadFails.on = false;
    expect(((await metaProposeBudgetChangeTool.execute(ctx("missing").c, CUT)) as Record<string, unknown>).blocked).toBe(true);
    expect(((await metaProposeBudgetChangeTool.execute(ctx(undefined).c, CUT)) as Record<string, unknown>).blocked).toBe(true);
    expect(((await metaProposeBudgetChangeTool.execute(ctx("run-other").c, CUT)) as Record<string, unknown>).blocked).toBe(true);
  });

  it("a raise never reads the run for the brake marker", async () => {
    runs.set("run-brake", { tenant_id: "tenant-1", payload: { brake: true } });
    const { c } = ctx("run-brake");
    const out = (await metaProposeBudgetChangeTool.execute(c, { ...CUT, proposed_daily_budget_usd: 110 })) as Record<string, unknown>;
    expect(out.brake_cut).toBe(false);
    expect(runReads).toEqual([]);
  });
});
