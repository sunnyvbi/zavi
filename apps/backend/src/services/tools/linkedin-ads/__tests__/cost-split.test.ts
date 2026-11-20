import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedInDailyAnalyticsRow } from "@/services/connectors/linkedin-ads/daily";

const SHARED = "900";
const m = vi.hoisted(() => ({ daily: vi.fn(), ownDaily: vi.fn(), wallet: false }));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAccountAccess: async (_t: string, account: string) =>
    m.wallet && account === SHARED
      ? {
          kind: "wallet",
          token: "managed-token",
          currency: "USD",
          campaignUrns: ["urn:li:sponsoredCampaign:111", "urn:li:sponsoredCampaign:112"],
          group: { binding: { provider_account_id: SHARED }, campaignBindingIds: ["cb-1", "cb-2"], campaignIds: ["111", "112"] },
        }
      : { kind: "own" },
}));
vi.mock("@/services/tools/linkedin-ads/list_campaigns", () => ({
  walletCampaigns: async () => [
    { id: "111", name: "Mine", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: "77" },
    { id: "112", name: "Mine too", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: "77" },
  ],
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLinkedInCampaigns: async () => [{ id: "1", name: "A", status: "ACTIVE", objective: "WEBSITE_CONVERSIONS", budget: null, campaign_group_id: "9" }],
  listLinkedInCampaignGroups: async () => [],
  listLinkedInCampaignGroupsWithToken: async () => [],
  listLinkedInAdAccounts: async () => [{ id: "500", name: "Own", currency: "USD", status: "ACTIVE" }],
}));
vi.mock("@/services/connectors/linkedin-ads/daily", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLinkedInDailyAnalyticsWithToken: (...a: unknown[]) => m.daily(...a),
  readLinkedInDailyAnalytics: (...a: unknown[]) => m.ownDaily(...a),
}));
vi.mock("@/services/ads-wallet/fx", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  adsFx: async (currency: string) => ({ currency, units_per_usd: 1, as_of: null, source: "ExchangeRate-API" }),
}));

import { fetchLinkedInDailySeries, linkedinAdsDailySeriesTool, linkedinCostSplit, type LinkedInCostSplit, type LinkedInDailyRow } from "../daily_series";

const day = (pivot: string, date: string, over: Partial<LinkedInDailyAnalyticsRow> = {}): LinkedInDailyAnalyticsRow => ({
  date,
  pivot,
  spend: 100,
  impressions: 10000,
  reach: 5000,
  clicks: 100,
  conversions: 5,
  leads: 5,
  conversion_value: 0,
  missing_metrics: [],
  ...over,
});
const read = (rows: LinkedInDailyAnalyticsRow[]) => ({ rows, truncated: false, read_through: "2026-11-04", partial_reason: null });
const date = (offset: number) => new Date(Date.UTC(2026, 10, 4) - offset * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date("2026-11-04T12:00:00Z");
const ctx = { tenant_id: "t-a", log: () => undefined } as never;

beforeEach(() => {
  m.wallet = false;
  m.daily.mockReset();
  m.ownDaily.mockReset();
});

describe("linkedin_ads_daily_series cost_split names which part moved the cost", () => {
  it("must catch: CPM flat and CTR halved in the settled week gives driver click_rate, and the settling tail is excluded from the comparison", () => {
    const rows: LinkedInDailyAnalyticsRow[] = [];
    for (let i = 17; i >= 0; i--) {
      const settledWeek = i >= 4 && i <= 10;
      const tail = i < 4;
      rows.push(day("urn:li:sponsoredCampaign:1", date(i), { clicks: settledWeek ? 50 : tail ? 1000 : 100, conversions: settledWeek ? 2.5 : tail ? 0 : 5, leads: tail ? 0 : settledWeek ? 2.5 : 5, spend: tail ? 1 : 100 }));
    }
    const series = rows.map((r) => ({ ...r, campaign_id: "9", campaign_name: "G", ad_set_id: "1", ad_set_name: "A", level: "campaign" as const }));
    const out = linkedinCostSplit(series as unknown as LinkedInDailyRow[], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].settled).toMatchObject({ from: date(10), to: date(4), days: 7, cpm: 10, ctr_percent: 0.5, cvr_percent: 5 });
    expect(out[0].prior).toMatchObject({ from: date(17), to: date(11), days: 7, cpm: 10, ctr_percent: 1, cvr_percent: 5 });
    expect(out[0].ratios).toEqual({ cpm: 1, ctr: 0.5, cvr: 1, cost_per_result: 2 });
    expect(out[0].driver).toBe("click_rate");
    expect(out[0].settled_through).toBe("2026-11-01");
  });

  it("must catch: the two weeks are calendar windows, so days LinkedIn omitted never pull older rows into the settled week", () => {
    const rows: LinkedInDailyAnalyticsRow[] = [];
    for (let i = 17; i >= 0; i--) {
      if (i === 6 || i === 8) continue;
      rows.push(day("urn:li:sponsoredCampaign:1", date(i), { clicks: i >= 4 && i <= 10 ? 50 : 100 }));
    }
    const series = rows.map((r) => ({ ...r, campaign_id: "9", campaign_name: "G", ad_set_id: "1", ad_set_name: "A", level: "campaign" as const }));
    const [split] = linkedinCostSplit(series as unknown as LinkedInDailyRow[], NOW);
    expect(split.settled).toMatchObject({ from: date(10), to: date(4), days: 5, ctr_percent: 0.5 });
    expect(split.prior).toMatchObject({ from: date(17), to: date(11), days: 7, ctr_percent: 1 });
    expect(split.driver).toBe("click_rate");
  });

  it("a day LinkedIn left clicks out of makes the split unknown, never flat or zero", () => {
    const series = Array.from({ length: 17 }, (_, i) => ({
      ...day("urn:li:sponsoredCampaign:1", date(16 - i), i === 5 ? { clicks: null, missing_metrics: ["clicks"] } : {}),
      campaign_id: "9",
      campaign_name: "G",
      ad_set_id: "1",
      ad_set_name: "A",
      level: "campaign" as const,
    }));
    const [split] = linkedinCostSplit(series as unknown as LinkedInDailyRow[], NOW);
    expect(split.prior?.clicks).toBeNull();
    expect(split.ratios.ctr).toBeNull();
    expect(split.driver).toBeNull();
    expect(split.reason).toMatch(/unknown, not flat/);
  });

  it("the tool returns cost_split and the per-day cvr_percent and cost_per_result, and nothing moved gives no driver", async () => {
    m.ownDaily.mockResolvedValue(read(Array.from({ length: 17 }, (_, i) => day("urn:li:sponsoredCampaign:1", date(16 - i)))));
    const out = (await linkedinAdsDailySeriesTool.execute(ctx, { account_id: "500" })) as { rows: LinkedInDailyRow[]; cost_split: LinkedInCostSplit[]; method: string };
    expect(out.rows[0]).toMatchObject({ cvr_percent: 10, cost_per_result: 10 });
    expect(out.cost_split).toHaveLength(1);
    expect(out.cost_split[0]).toMatchObject({ ad_set_id: "1", driver: null });
    expect(out.cost_split[0].reason).toMatch(/No part moved/);
    expect(out.method).toMatch(/sign-up rate/);
  });

  it("must catch: a wallet group day that rolls up two campaigns has null reach and frequency, because reach does not add, while a one-campaign day keeps it", async () => {
    m.wallet = true;
    m.daily.mockResolvedValue(read([day("urn:li:sponsoredCampaign:111", "2026-10-01"), day("urn:li:sponsoredCampaign:112", "2026-10-01"), day("urn:li:sponsoredCampaign:111", "2026-10-02")]));
    const out = await fetchLinkedInDailySeries("t-a", { account_id: SHARED, level: "campaign_group", lookback_days: 30 });
    expect(out.rows.map((r) => [r.date, r.impressions, r.reach, r.frequency, r.missing_metrics])).toEqual([
      ["2026-10-01", 20000, null, null, []],
      ["2026-10-02", 10000, 5000, 2, []],
    ]);
  });
});
