import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({
  tiktokAdsAccount: async () => ({ tenant_id: "tenant", connected_account_id: "connection" }),
  verifyAdvertisers: m.verify,
  tiktokCampaignsUrl: (id: string) => `https://ads.tiktok.com/?aadvid=${id}`,
}));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({
  ensureAdAccounts: async () => ({ accounts: [{ advertiser_id: "123", name: "Old", status: "SELF_SERVICE_UNAUDITED", currency: "USD", source: "manual" }], selected_id: "123", needs: "nothing" }),
}));
import { tiktokAdsListAccountsTool } from "../list_accounts";
const ctx = { tenant_id: "tenant", log: () => {} };

beforeEach(() => { m.verify.mockReset(); });

describe("TikTok account facts", () => {
  it("reports TikTok's current account status instead of the saved discovery status", async () => {
    m.verify.mockResolvedValue([{ advertiser_id: "123", name: "Current", currency: "USD", status: "ENABLE", timezone: "Etc/GMT+5" }]);
    const result = await tiktokAdsListAccountsTool.execute(ctx, {}) as { advertisers: unknown[] };
    expect(result.advertisers).toEqual([expect.objectContaining({ advertiser_id: "123", name: "Current", status: "ENABLE", source: "manual", selected: true })]);
    expect(m.verify).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant" }), ["123"]);
  });
  it("does not claim a saved but unreachable account is currently available", async () => {
    m.verify.mockResolvedValue([]);
    expect(await tiktokAdsListAccountsTool.execute(ctx, {})).toMatchObject({ count: 0, selected_advertiser_id: null, advertisers: [] });
  });
  it("surfaces a failed live read rather than falling back to stale facts", async () => {
    m.verify.mockRejectedValue(new Error("TikTok unavailable"));
    await expect(tiktokAdsListAccountsTool.execute(ctx, {})).rejects.toThrow("TikTok unavailable");
  });
});
