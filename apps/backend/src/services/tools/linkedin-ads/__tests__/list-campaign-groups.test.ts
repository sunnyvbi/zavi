import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedInDailyAnalyticsRow } from "@/services/connectors/linkedin-ads/daily";

const SHARED = "900";
const m = vi.hoisted(() => ({ daily: vi.fn(), ownDaily: vi.fn(), ownList: vi.fn(), ownGroups: vi.fn(), walletGroups: vi.fn(), wallet: false, fxDown: false }));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAccountAccess: async (_t: string, account: string) =>
    m.wallet && account === SHARED
      ? { kind: "wallet", token: "managed-token", currency: "USD", campaignUrns: ["urn:li:sponsoredCampaign:111"], group: { binding: { provider_account_id: SHARED }, campaignBindingIds: ["cb-1"], campaignIds: ["111"] } }
      : { kind: "own" },
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({
  goneLinkedinCampaignIds: async () => new Set(),
  linkedinCampaign: async () => ({ token: "managed-token", campaign: { id: 111, name: "Mine", status: "ACTIVE", objectiveType: "LEAD_GENERATION", campaignGroup: "urn:li:sponsoredCampaignGroup:77" } }),
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLinkedInCampaigns: (...a: unknown[]) => m.ownList(...a),
  listLinkedInCampaignGroups: (...a: unknown[]) => m.ownGroups(...a),
  readLinkedInCampaignGroupsByIdWithToken: (...a: unknown[]) => m.walletGroups(...a),
  listLinkedInAdAccounts: async () => [{ id: "500", name: "Own", currency: "USD", status: "ACTIVE" }],
  readLinkedInAdStates: async () => [],
  readLinkedInAdStatesWithToken: async () => [],
}));
vi.mock("@/services/connectors/linkedin-ads/daily", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLinkedInDailyAnalyticsWithToken: (...a: unknown[]) => m.daily(...a),
  readLinkedInDailyAnalytics: (...a: unknown[]) => m.ownDaily(...a),
}));
vi.mock("@/services/ads-wallet/fx", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  adsFx: async (currency: string) => {
    if (m.fxDown) throw new Error("fx down");
    return { currency, units_per_usd: 1, as_of: null, source: "ExchangeRate-API" };
  },
}));

import { linkedinAdsListCampaignGroupsTool, type LinkedInCampaignGroupRow } from "../list_campaign_groups";
import { linkedinAdsListCampaignsTool } from "../list_campaigns";

const group = (id: string, name: string, status = "ACTIVE") => ({ id, name, status, total_budget: { amount: 500, currency: "USD" }, run_start_at: "2026-10-01T00:00:00.000Z", run_end_at: null });
const campaign = (id: string, campaign_group_id: string | null, objective = "WEBSITE_CONVERSIONS") => ({ id, name: `C${id}`, status: "ACTIVE", objective, budget: null, campaign_group_id });
const day = (pivot: string, date: string, over: Partial<LinkedInDailyAnalyticsRow> = {}): LinkedInDailyAnalyticsRow => ({
  date,
  pivot,
  spend: 10,
  impressions: 1000,
  reach: 500,
  clicks: 8,
  conversions: 1,
  leads: 2,
  conversion_value: 40,
  missing_metrics: [],
  ...over,
});
const read = (rows: LinkedInDailyAnalyticsRow[], over: Partial<{ truncated: boolean; read_through: string | null; partial_reason: "rate_limited" | null }> = {}) => ({ rows, truncated: false, read_through: "2026-10-30", partial_reason: null, ...over });
const ctx = { tenant_id: "t-a", log: () => undefined } as never;
type Out = { campaign_groups: LinkedInCampaignGroupRow[]; truncated: boolean; warning?: string; unread_metrics?: string[]; unread_note?: string; fx_note?: string; count: number };
const run = async (account_id = "500") => (await linkedinAdsListCampaignGroupsTool.execute(ctx, { account_id })) as Out;

beforeEach(() => {
  m.wallet = false;
  m.fxDown = false;
  for (const f of [m.daily, m.ownDaily, m.ownList, m.ownGroups, m.walletGroups]) f.mockReset();
});

describe("linkedin_ads_list_campaign_groups", () => {
  it("must catch: a group's window numbers equal the sum of its daily rows, a group with a missing day keeps the metric unknown, and ad sets are counted per group", async () => {
    m.ownList.mockResolvedValue([campaign("1", "5"), campaign("2", "5"), campaign("3", "6"), campaign("4", "9")]);
    m.ownGroups.mockResolvedValue([group("5", "Spring launch"), group("6", "Always on")]);
    m.ownDaily.mockResolvedValue(
      read([
        day("urn:li:sponsoredCampaignGroup:5", "2026-10-01", { spend: 10, clicks: 4, conversions: 1, leads: 1, conversion_value: 30 }),
        day("urn:li:sponsoredCampaignGroup:5", "2026-10-02", { spend: 15.5, clicks: 6, conversions: 0, leads: 3, conversion_value: 20 }),
        day("urn:li:sponsoredCampaignGroup:6", "2026-10-01", { conversions: null, missing_metrics: ["conversions"] }),
        day("urn:li:sponsoredCampaignGroup:6", "2026-10-02"),
      ]),
    );
    const out = await run();
    expect(m.ownGroups).toHaveBeenCalledWith("t-a", "500", 500);
    expect(m.ownDaily.mock.calls[0][2]).toMatchObject({ pivot: "CAMPAIGN_GROUP" });
    const byId = Object.fromEntries(out.campaign_groups.map((g) => [g.id, g]));
    expect(out.campaign_groups.map((g) => g.id)).toEqual(["5", "6", "9"]);
    expect(byId["5"]).toMatchObject({ name: "Spring launch", status: "ACTIVE", total_budget: { amount: 500, currency: "USD" }, ad_set_count: 2, ad_set_ids: ["1", "2"] });
    expect(byId["5"].window).toMatchObject({ spend: 25.5, spend_usd: 25.5, clicks: 10, website_conversions: 1, leads: 4, conversions: 5, conversion_value: 50, days: 2, missing_metrics: [] });
    expect(byId["6"].window).toMatchObject({ spend: 20, clicks: 16, leads: 4, conversions: null, website_conversions: null });
    expect(byId["6"].window.missing_metrics).toEqual(["conversions", "website_conversions"]);
    expect(byId["9"]).toMatchObject({ name: "9", status: null, ad_set_count: 1, window: { spend: null, days: 0 } });
    expect(out.unread_metrics).toEqual(expect.arrayContaining(["conversions", "spend"]));
    expect(JSON.stringify(byId["6"].window)).not.toContain('"conversions":0');
  });

  it("must catch: a group that only the daily rows know, whose ad sets LinkedIn no longer lists, still shows with its spend", async () => {
    m.ownList.mockResolvedValue([campaign("1", "5")]);
    m.ownGroups.mockResolvedValue([group("5", "Spring launch")]);
    m.ownDaily.mockResolvedValue(read([day("urn:li:sponsoredCampaignGroup:5", "2026-10-01"), day("urn:li:sponsoredCampaignGroup:8", "2026-10-01", { spend: 77 })]));
    const out = await run();
    expect(out.campaign_groups.map((g) => [g.id, g.ad_set_count, g.window.spend])).toEqual([
      ["8", 0, 77],
      ["5", 1, 10],
    ]);
  });

  it("must catch: a missing exchange rate is said to be Zavi's, never LinkedIn leaving a number out", async () => {
    m.fxDown = true;
    m.ownList.mockResolvedValue([campaign("1", "5")]);
    m.ownGroups.mockResolvedValue([group("5", "Spring launch")]);
    m.ownDaily.mockResolvedValue(read([day("urn:li:sponsoredCampaignGroup:5", "2026-10-01")]));
    const out = await run();
    expect(out.campaign_groups[0].window).toMatchObject({ spend: 10, spend_usd: null });
    expect(out.fx_note).toMatch(/exchange rate/);
    expect(out.unread_metrics).toBeUndefined();
    expect(out.unread_note).toBeUndefined();
  });

  it("must catch: a partly read window is said to be partial", async () => {
    m.ownList.mockResolvedValue([campaign("1", "5")]);
    m.ownGroups.mockResolvedValue([group("5", "Spring launch")]);
    m.ownDaily.mockResolvedValue(read([day("urn:li:sponsoredCampaignGroup:5", "2026-10-01")], { truncated: true, read_through: "2026-10-07", partial_reason: "rate_limited" }));
    const out = await run();
    expect(out.truncated).toBe(true);
    expect(out.warning).toMatch(/PARTIAL/);
  });

  it("must catch: a wallet account reads its groups and days with the managed token and shows only this workspace's group", async () => {
    m.wallet = true;
    m.walletGroups.mockImplementation(async (_t: string, _a: string, ids: string[]) => [group("77", "My wallet group"), group("78", "Other tenant's group")].filter((g) => ids.includes(g.id)));
    m.daily.mockResolvedValue(read([day("urn:li:sponsoredCampaign:111", "2026-10-01"), day("urn:li:sponsoredCampaign:222", "2026-10-01", { spend: 9000 })]));
    const out = await run(SHARED);
    expect(m.walletGroups).toHaveBeenCalledWith("managed-token", SHARED, ["77"]);
    expect(m.daily.mock.calls[0].slice(0, 2)).toEqual(["managed-token", SHARED]);
    expect(m.daily.mock.calls[0][2]).toMatchObject({ pivot: "CAMPAIGN", campaigns: ["urn:li:sponsoredCampaign:111"] });
    expect(m.ownGroups).not.toHaveBeenCalled();
    expect(m.ownList).not.toHaveBeenCalled();
    expect(out.campaign_groups.map((g) => [g.id, g.name, g.ad_set_count, g.window.spend])).toEqual([["77", "My wallet group", 1, 10]]);
    expect(JSON.stringify(out)).not.toContain("Other tenant");
  });
});

describe("linkedin_ads_list_campaigns names each campaign's group", () => {
  it("carries the group id and name, a null name when the group list could not be read, and null when LinkedIn gave no group", async () => {
    m.ownList.mockResolvedValue([campaign("1", "5"), campaign("2", null)]);
    m.ownGroups.mockResolvedValue([group("5", "Spring launch")]);
    const out = (await linkedinAdsListCampaignsTool.execute(ctx, { account_id: "500" })) as { campaigns: Array<{ id: string; campaign_group: unknown }> };
    expect(out.campaigns.map((c) => c.campaign_group)).toEqual([{ id: "5", name: "Spring launch" }, null]);
    m.ownGroups.mockRejectedValue(new Error("down"));
    const unread = (await linkedinAdsListCampaignsTool.execute(ctx, { account_id: "500" })) as { campaigns: Array<{ campaign_group: unknown }> };
    expect(unread.campaigns.map((c) => c.campaign_group)).toEqual([{ id: "5", name: null }, null]);
  });
});
