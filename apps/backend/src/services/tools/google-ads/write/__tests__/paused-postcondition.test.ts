import { describe, it, expect, vi } from "vitest";
import type { GoogleCampaignLive } from "../../_client";
import { checkCreatedPaused, pausedPostconditionKey, type PausedPostconditionDeps } from "../_paused-postcondition";

const T = "11111111-1111-4111-8111-111111111111";
const live = (status: string): GoogleCampaignLive => ({
  campaign_resource: "customers/9/campaigns/555",
  campaign_id: "555",
  name: "YT",
  status,
  channel_type: "DEMAND_GEN",
  bidding_strategy_type: "MAXIMIZE_CONVERSIONS",
  budget_resource: "customers/9/campaignBudgets/1",
  amount_micros: 30_000_000,
});

function deps(getCampaign: PausedPostconditionDeps["getCampaign"]) {
  const rpc = vi.fn(async (_tid: string, _fn: string, _args: Record<string, unknown>) => ({ data: true, error: null }));
  const nudge = vi.fn();
  const log = vi.fn(async (_e: Record<string, unknown>) => undefined);
  return { rpc, nudge, log, d: { getCampaign, rpc, nudge, log } as unknown as PausedPostconditionDeps };
}

describe("checkCreatedPaused", () => {
  it("PAUSED: confirmed, no alert", async () => {
    const x = deps(vi.fn(async () => live("PAUSED")));
    expect(await checkCreatedPaused({ tenant_id: T, action_id: "act-1", campaign_id: "555" }, x.d)).toEqual({ paused: true, status: "PAUSED", cpc_bid_ceiling_micros: null });
    expect(x.rpc).not.toHaveBeenCalled();
  });

  it("ENABLED: one ops alert keyed to the action, and nothing else is done", async () => {
    const getCampaign = vi.fn(async () => live("ENABLED"));
    const x = deps(getCampaign);
    expect(await checkCreatedPaused({ tenant_id: T, action_id: "act-1", campaign_id: "555" }, x.d)).toEqual({ paused: false, status: "ENABLED", cpc_bid_ceiling_micros: null });
    expect(x.rpc).toHaveBeenCalledTimes(1);
    const [tid, fn, args] = x.rpc.mock.calls[0];
    expect(tid).toBe(T);
    expect(fn).toBe("enqueue_ops_alert");
    expect(args).toMatchObject({
      p_dedupe_key: "paused_postcondition:act-1",
      p_source: "google_ads.create_campaign",
      p_code: "paused_postcondition",
      p_tenant_id: T,
    });
    expect(String(args.p_msg)).toMatch(/Google reports ENABLED\. Zavi changed nothing/);
    expect(x.nudge).toHaveBeenCalledTimes(1);
    expect(getCampaign).toHaveBeenCalledTimes(1);
    expect(pausedPostconditionKey("act-1")).toBe("paused_postcondition:act-1");
  });

  it("a failed readback is unverified, alerts, and never throws", async () => {
    const x = deps(vi.fn(async () => {
      throw new Error("google down");
    }));
    expect(await checkCreatedPaused({ tenant_id: T, action_id: "act-2", campaign_id: "555" }, x.d)).toEqual({ paused: null, status: null });
    expect(x.rpc.mock.calls[0][2]).toMatchObject({ p_code: "paused_postcondition_unverified", p_dedupe_key: "paused_postcondition:act-2" });
  });

  it("an alert that was already enqueued is not nudged again; an enqueue failure is swallowed", async () => {
    const x = deps(vi.fn(async () => live("ENABLED")));
    x.rpc.mockResolvedValueOnce({ data: false, error: null } as never);
    await checkCreatedPaused({ tenant_id: T, action_id: "act-3", campaign_id: "555" }, x.d);
    expect(x.nudge).not.toHaveBeenCalled();
    x.rpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } } as never);
    await expect(checkCreatedPaused({ tenant_id: T, action_id: "act-3", campaign_id: "555" }, x.d)).resolves.toEqual({ paused: false, status: "ENABLED", cpc_bid_ceiling_micros: null });
  });
});
