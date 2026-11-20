
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CampaignBrief, WindowAgg } from "@/services/growth/perf-brief/brief";

vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("../_user-initiated-flag-check", () => ({ isUserInitiatedSpendApplyEnabled: vi.fn(async () => false) }));
vi.mock("../cap-reader", () => {
  const m = {
    readTenantCapAndToday: vi.fn(async () => ({
      cap: { enabled: true, max_daily_budget_usd: 1000, max_pct_change_per_run: 0.9, max_daily_total_change_usd: 1000 },
      today_total_change_usd: 0,
      currency: "USD",
      units_per_usd: 1,
    })),
  };
  return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday };
});
const logs = vi.hoisted(() => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/logEvent", () => logs);

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
  briefForCampaign: vi.fn(async () => WORKING),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
    return { from: () => q };
  },
}));

import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import { metaProposeStatusChangeTool } from "../propose_status_change";
import type { ToolContext } from "@/services/tools/types";

function ctx(over: Partial<ToolContext>) {
  const emit = vi.fn(async (_c: string, _b: unknown) => "decision-1");
  const c: ToolContext = { tenant_id: "tenant-1", log: () => {}, emit_decision: emit, ...over };
  return { c, emit };
}
const CUT = { ad_set_id: "as1", current_daily_budget_usd: 100, proposed_daily_budget_usd: 60, rationale: "founder asked" };
const PAUSE = { object_id: "as1", level: "adset" as const, status: "PAUSED" as const, rationale: "founder asked" };
const FOUNDER = { run_trigger: "chat", founder_chat_order: true };

describe("Meta cut guard and a founder chat order", () => {
  beforeEach(() => logs.logEvent.mockClear());

  it("a founder-ordered budget cut on a working ad set is filed, with the guard's objection as the card note", async () => {
    const { c, emit } = ctx(FOUNDER);
    const out = (await metaProposeBudgetChangeTool.execute(c, CUT)) as Record<string, unknown>;
    expect(out.blocked).toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof body.cut_guard_note).toBe("string");
    expect((body.cut_guard_note as string).length).toBeGreaterThan(0);
    expect((body.cut_guard_note as string).length).toBeLessThanOrEqual(300);
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "founder_order.guard_overridden" }));
  });

  it("the same cut from a scheduled run is still blocked", async () => {
    const { c, emit } = ctx({ run_trigger: "scheduled" });
    const out = (await metaProposeBudgetChangeTool.execute(c, CUT)) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a cut the agent proposes on its own in chat (no founder marker, flag off) is still blocked", async () => {
    const { c, emit } = ctx({ run_trigger: "chat" });
    const out = (await metaProposeBudgetChangeTool.execute(c, CUT)) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a founder-ordered pause on a working ad set is filed with the guard note", async () => {
    const { c, emit } = ctx(FOUNDER);
    const out = (await metaProposeStatusChangeTool.execute(c, PAUSE)) as Record<string, unknown>;
    expect(out.blocked).toBeUndefined();
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof body.cut_guard_note).toBe("string");
  });

  it("the same pause from a scheduled run is blocked; the agent's own chat pause is blocked as before", async () => {
    for (const over of [{ run_trigger: "scheduled" }, { run_trigger: "chat" }]) {
      const { c, emit } = ctx(over);
      const out = (await metaProposeStatusChangeTool.execute(c, PAUSE)) as Record<string, unknown>;
      expect(out.blocked, JSON.stringify(over)).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    }
  });

  it("an UNVERIFIED founder mark (a read failed while checking the run) never overrides the cut or pause guard (bug #2)", async () => {
    for (const [tool, args] of [[metaProposeBudgetChangeTool, CUT], [metaProposeStatusChangeTool, PAUSE]] as const) {
      const { c, emit } = ctx({ ...FOUNDER, founder_order_unverified: true });
      const out = (await (tool as typeof metaProposeBudgetChangeTool).execute(c, args as never)) as Record<string, unknown>;
      expect(out.blocked).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    }
  });

  it("a founder order on a captured page is not a founder order: still guarded", async () => {
    const { c, emit } = ctx({ ...FOUNDER, captured_page_context: true });
    const out = (await metaProposeStatusChangeTool.execute(c, PAUSE)) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });
});
