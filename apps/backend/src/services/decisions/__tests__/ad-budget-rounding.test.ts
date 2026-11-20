import { beforeEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: { status: "held", amount_usd: 80.04 }, error: null })));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantRpc: rpc }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => true }));
vi.mock("@/services/decisions/ad-money-book-flag", () => ({ moneyBookShadowEnabled: () => false }));
import { lifetimeDailyUsd, rebaseAdSpendForObject, reserveAdSpend, syncAdHoldsToLive } from "../ad-budget";
beforeEach(() => rpc.mockClear());
it("passes only supported, successfully read platforms to hold reconciliation, including TikTok", async () => {
  const started = new Date("2026-10-21T12:00:00Z");
  await syncAdHoldsToLive("T", ["tiktok", "tiktok", "unsupported"], started);
  expect(rpc).toHaveBeenCalledWith("T", "sync_ad_holds_to_live", { p_platforms: ["tiktok"], p_read_started_at: started.toISOString() });
});
it.each([[20.01, 20.01], [20.010001, 20.02], [0.004, 0.01], [30.000000000000004, 30], [0, 0]])("reserves %s as %s without binary cent drift", async (amount, expected) => {
  await reserveAdSpend({ id: "a", tenant_id: "T", exec_source: "channel_actions" }, { platform: "tiktok", currency: "USD", op: "create", object_id: null, daily_delta_usd: amount });
  expect(rpc).toHaveBeenCalledWith("T", "reserve_ad_spend", expect.objectContaining({ p_daily_delta_usd: expected }));
});
it("preserves exact cents in lifetime limits and worst-day amounts", async () => {
  expect(lifetimeDailyUsd(20.01, 1, 1)).toBe(20.01);
  await reserveAdSpend({ id: "a", tenant_id: "T" }, { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: 20.01, lifetime_usd: 20.01 });
  expect(rpc).toHaveBeenCalledWith("T", "reserve_ad_spend", expect.objectContaining({ p_cap_usd: 20.01 }));
});
it.each([[20.01, 0.29, 20.01, 0.29], [20.010001, 0.299999, 20.02, 0.29]])("rebases upward and rounds cuts downward at micro-dollar precision", async (daily, cut, expectedDaily, expectedCut) => {
  await rebaseAdSpendForObject("T", "tiktok", "201", daily, "cut", cut);
  expect(rpc).toHaveBeenCalledWith("T", "rebase_ad_spend_for_object", expect.objectContaining({ p_new_daily_usd: expectedDaily, p_cut_usd: expectedCut }));
});
