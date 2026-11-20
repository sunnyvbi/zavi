
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";

const resolveBid = vi.hoisted(() => vi.fn());
vi.mock("../_ad-set-bid", () => ({ resolveCreateAdSetBid: resolveBid }));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("../cap-reader", () => {
  const m = { readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })) };
  return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday };
});

import { metaProposeNewAdSetTool } from "../propose_new_ad_set";

const INPUT = {
  campaign_id: "camp-123",
  name: "Prospecting",
  daily_budget_usd: 30,
  optimization_goal: "LINK_CLICKS",
  billing_event: "IMPRESSIONS",
  targeting: { geo_locations: { countries: ["US"] } },
  rationale: "launch",
};

function ctx() {
  const emit = vi.fn(async () => "d-1");
  const c: ToolContext = { tenant_id: "t-1", log: () => {}, emit_decision: emit, run_trigger: "chat" };
  return { c, emit };
}

beforeEach(() => {
  resolveBid.mockReset();
});

describe("propose_new_ad_set: the bid read before the card", () => {
  it("a Meta 500 is told to the agent as temporary, and nothing is emitted", async () => {
    resolveBid.mockImplementation(async () => {
      throw new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 500 x", { http_status: 500 });
    });
    const { c, emit } = ctx();
    const err = (await metaProposeNewAdSetTool.execute(c, INPUT).catch((e) => e)) as ExpectedToolError;
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("meta_ads_temporarily_unavailable");
    expect(err.meta).toEqual({ next_step: "retry" });
    expect(err.message).toMatch(/Nothing was created or sent to approvals/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a real refusal (bid conflict) is passed through as is", async () => {
    resolveBid.mockImplementation(async () => {
      throw new ExpectedToolError("meta_ads_bid_conflict", "this campaign uses COST_CAP");
    });
    const { c, emit } = ctx();
    const err = (await metaProposeNewAdSetTool.execute(c, INPUT).catch((e) => e)) as ExpectedToolError;
    expect(err.code).toBe("meta_ads_bid_conflict");
    expect(emit).not.toHaveBeenCalled();
  });
});
