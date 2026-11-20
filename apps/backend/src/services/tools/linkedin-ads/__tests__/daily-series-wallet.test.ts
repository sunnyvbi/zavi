import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedInDailyAnalyticsRow } from "@/services/connectors/linkedin-ads/daily";

const SHARED = "900";
const m = vi.hoisted(() => ({
  daily: vi.fn(),
  ownDaily: vi.fn(),
  ownList: vi.fn(),
  wallet: true,
  fxFails: false,
}));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAccountAccess: async (_t: string, account: string) =>
    m.wallet && account === SHARED
      ? { kind: "wallet", token: "managed-token", currency: "EUR", campaignUrns: ["urn:li:sponsoredCampaign:111"], group: { binding: { provider_account_id: SHARED }, campaignBindingIds: ["cb-1"], campaignIds: ["111"] } }
      : { kind: "own" },
}));
vi.mock("@/services/tools/linkedin-ads/list_campaigns", () => ({
  walletCampaigns: async () => [{ id: "111", name: "Mine", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: "77" }],
}));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  listLinkedInCampaigns: (...a: unknown[]) => m.ownList(...a),
  listLinkedInAdAccounts: async () => [{ id: "500", name: "Own", currency: "INR", status: "ACTIVE" }],
}));
vi.mock("@/services/connectors/linkedin-ads/daily", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLinkedInDailyAnalyticsWithToken: (...a: unknown[]) => m.daily(...a),
  readLinkedInDailyAnalytics: (...a: unknown[]) => m.ownDaily(...a),
}));
vi.mock("@/services/ads-wallet/fx", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  adsFx: async (currency: string) => {
    if (m.fxFails) throw new Error("fx down");
    return { currency, units_per_usd: currency === "EUR" ? 0.5 : 80, as_of: null, source: "ExchangeRate-API" };
  },
}));

import { fetchLinkedInDailySeries, linkedinAdsDailySeriesTool, type LinkedInDailyRow } from "../daily_series";

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
const read = (rows: LinkedInDailyAnalyticsRow[]) => ({ rows, truncated: false, read_through: "2026-10-30", partial_reason: null });
const ctx = { tenant_id: "t-a", log: () => undefined } as never;

beforeEach(() => {
  m.wallet = true;
  m.fxFails = false;
  m.daily.mockReset();
  m.ownDaily.mockReset();
  m.ownList.mockReset();
  m.ownList.mockResolvedValue([{ id: "1", name: "A", status: "ACTIVE", objective: "WEBSITE_VISIT", budget: null, campaign_group_id: "9" }]);
});

describe("linkedin_ads_daily_series on the shared wallet account", () => {
  it("must catch: a wallet account is read with the managed token and only this workspace's campaigns, never the founder's own login", async () => {
    m.daily.mockResolvedValue(read([day("urn:li:sponsoredCampaign:111", "2026-10-01"), day("urn:li:sponsoredCampaign:222", "2026-10-01", { spend: 9000 })]));
    const out = (await linkedinAdsDailySeriesTool.execute(ctx, { account_id: SHARED })) as { rows: LinkedInDailyRow[]; currency: string | null };
    expect(m.daily).toHaveBeenCalledTimes(1);
    expect(m.daily.mock.calls[0][0]).toBe("managed-token");
    expect(m.daily.mock.calls[0][1]).toBe(SHARED);
    expect(m.daily.mock.calls[0][2]).toMatchObject({ pivot: "CAMPAIGN", campaigns: ["urn:li:sponsoredCampaign:111"] });
    expect(m.ownDaily).not.toHaveBeenCalled();
    expect(m.ownList).not.toHaveBeenCalled();
    expect(out.currency).toBe("EUR");
    expect(out.rows.map((r) => r.ad_set_id)).toEqual(["111"]);
    expect(out.rows[0]).toMatchObject({ campaign_id: "77", ad_set_name: "Mine", judged_on: "conversions", spend: 10, spend_usd: 20, conversion_value: 40, purchase_value_usd: 80, frequency: 2, conversions: 3, leads: 2 });
  });

  it("rolls wallet campaigns up to their campaign group per day when asked for group level, keeping a missing metric missing", async () => {
    m.daily.mockResolvedValue(read([day("urn:li:sponsoredCampaign:111", "2026-10-01", { conversions: null, missing_metrics: ["conversions"] }), day("urn:li:sponsoredCampaign:111", "2026-10-02")]));
    const out = await fetchLinkedInDailySeries("t-a", { account_id: SHARED, level: "campaign_group", lookback_days: 30 });
    expect(out.rows.map((r) => [r.date, r.campaign_id, r.ad_set_id, r.conversions])).toEqual([
      ["2026-10-01", "77", null, null],
      ["2026-10-02", "77", null, 3],
    ]);
    expect(out.rows[0].missing_metrics).toContain("conversions");
  });

  it("an own account reads through the tenant login at the asked pivot and keeps spend in the account currency when no rate is available", async () => {
    m.wallet = false;
    m.fxFails = true;
    m.ownDaily.mockResolvedValue(read([day("urn:li:sponsoredCampaignGroup:9", "2026-10-01")]));
    const out = (await linkedinAdsDailySeriesTool.execute(ctx, { account_id: "500", level: "campaign_group" })) as { rows: LinkedInDailyRow[]; fx_note?: string; currency: string | null };
    expect(m.ownDaily.mock.calls[0].slice(0, 2)).toEqual(["t-a", "500"]);
    expect(m.ownDaily.mock.calls[0][2]).toMatchObject({ pivot: "CAMPAIGN_GROUP" });
    expect(out.currency).toBe("INR");
    expect(out.fx_note).toMatch(/account currency/);
    expect(out.rows[0]).toMatchObject({ campaign_id: "9", ad_set_id: null, spend: 10, spend_usd: null, cpm_usd: null, purchase_value_usd: null, cpm: 10, judged_on: "reach_and_clicks" });
    expect(out.rows[0].missing_metrics).toEqual([]);
  });
});
