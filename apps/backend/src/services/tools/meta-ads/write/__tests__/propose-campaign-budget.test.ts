
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../_flag-check", () => ({
  isMetaAdsWriteEnabled: vi.fn(async () => true),
}));
vi.mock("../_user-initiated-flag-check", () => ({
  isUserInitiatedSpendApplyEnabled: vi.fn(async () => false),
}));
vi.mock("../cap-reader", () => { const m = ({
  readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })),
}); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });

import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import { pickDecisionClass } from "../_class-router";
import { metaChangeRows } from "../_change-rows";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";

function makeCtx() {
  const emit = vi.fn(async () => "decision-id-1");
  const ctx: ToolContext = { tenant_id: "t1", log: () => {}, emit_decision: emit, run_trigger: "scheduled" };
  return { ctx, emit };
}

describe("meta_ads_propose_budget_change on a campaign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("campaign_id emits the campaign class with a campaign body and no ad set", async () => {
    const { ctx, emit } = makeCtx();
    const r = (await metaProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "120200",
      current_daily_budget_usd: 50,
      proposed_daily_budget_usd: 60,
      rationale: "CBO campaign is budget-limited at a good CPA",
      name: "Spring CBO",
    })) as { decision_class: string };
    expect(r.decision_class).toBe("meta_ads.update_campaign_budget_review");
    const [cls, body] = emit.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(cls).toBe("meta_ads.update_campaign_budget_review");
    expect(body).toMatchObject({ campaign_id: "120200", daily_budget_usd: 60, expected_current_daily_budget_usd: 50, currency: "USD", name: "Spring CBO" });
    expect(body.ad_set_id).toBeUndefined();
  });

  it("refuses both ids, and neither, before emitting", async () => {
    const { ctx, emit } = makeCtx();
    const base = { current_daily_budget_usd: 50, proposed_daily_budget_usd: 60, rationale: "x" };
    await expect(metaProposeBudgetChangeTool.execute(ctx, { ...base, ad_set_id: "1", campaign_id: "2" })).rejects.toBeInstanceOf(ExpectedToolError);
    await expect(metaProposeBudgetChangeTool.execute(ctx, base)).rejects.toBeInstanceOf(ExpectedToolError);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("pickDecisionClass — campaign level", () => {
  it("routes the same way onto the campaign classes", () => {
    expect(pickDecisionClass({ op: "budget", level: "campaign", within: true })).toBe("meta_ads.update_campaign_budget");
    expect(pickDecisionClass({ op: "budget", level: "campaign", within: false })).toBe("meta_ads.update_campaign_budget_review");
    expect(pickDecisionClass({ op: "budget", level: "campaign", within: true, forceApproval: true })).toBe("meta_ads.update_campaign_budget_review");
    expect(pickDecisionClass({ op: "budget", level: "campaign", within: false, origin: "user_chat", flagOn: true })).toBe("meta_ads.update_campaign_budget");
    expect(pickDecisionClass({ op: "budget", level: "campaign", within: true, origin: "user_chat", flagOn: true, agentUnsure: true })).toBe("meta_ads.update_campaign_budget_review");
  });

  it("an unannotated budget input still routes onto the ad-set classes", () => {
    expect(pickDecisionClass({ op: "budget", within: true })).toBe("meta_ads.update_ad_set_budget");
  });
});

describe("metaChangeRows — campaign budget", () => {
  it("names the campaign and the before/after from the parsed body", () => {
    const c = metaChangeRows("meta_ads.update_campaign_budget_review", {
      campaign_id: "120200",
      daily_budget_usd: 80,
      expected_current_daily_budget_usd: 50,
      over_cap: true,
    });
    expect(c?.title).toBe("Raise campaign 120200 from $50 to $80 a day");
    expect(c?.rows).toEqual([{ item: "Campaign 120200 daily budget", before: "$50/day", after: "$80/day" }]);
  });

  it("an ad-set body on the campaign class draws no rows (dispatch would refuse it)", () => {
    expect(metaChangeRows("meta_ads.update_campaign_budget", { ad_set_id: "1", daily_budget_usd: 80, expected_current_daily_budget_usd: 50, over_cap: false })).toBeNull();
  });
});
