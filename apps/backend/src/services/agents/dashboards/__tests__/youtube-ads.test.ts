import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
const googleAdsCreds = vi.hoisted(() => vi.fn());
const gadsSearch = vi.hoisted(() => vi.fn());
vi.mock("@/services/tools/google-ads/list_video_campaigns", () => ({ listVideoCampaignsTool: { execute } }));
vi.mock("@/services/tools/google-ads/_client", () => ({ googleAdsCreds, gadsSearch }));
vi.mock("@/routes/agents/dashboards/_google-campaigns", () => ({ googleCampaignUrl: () => "https://ads.google.com/x" }));

import { build } from "../youtube-ads";

let n = 0;
const ctx = () => ({ tenantId: `t${(n += 1)}`, ctx: {}, refresh: false, meteredRefresh: false, rangeDays: 30 }) as never;
const err = (code: string) => Object.assign(new Error(code), { code });

describe("youtube ads dashboard", () => {
  beforeEach(() => {
    execute.mockReset();
    googleAdsCreds.mockReset().mockResolvedValue({ customer_id: "123" });
    gadsSearch.mockReset().mockResolvedValue([{ customer: { currencyCode: "USD" } }]);
  });

  it("carries the video numbers and the totals the tool already summed", async () => {
    execute.mockResolvedValue({
      campaigns: [{ campaign_id: "1", campaign_name: "Shorts", status: "ENABLED", spend_usd: 20, conversions: 2, conversions_value_usd: 50, cpa_usd: 10, impressions: 1000, video_views: 250, view_rate: 25, avg_cpv_usd: 0.08 }],
      totals: { spend_usd: 20, conversions: 2, conversions_value_usd: 50, impressions: 1000, video_views: 250, view_rate: 0.25, avg_cpv_usd: 0.08, cpa_usd: 10 },
    });
    const out = (await build(ctx())) as Record<string, any>;
    expect(out.connected).toBe(true);
    expect(out.campaigns[0]).toMatchObject({ views: 250, view_rate: 25, cpv: 0.08 });
    expect(out.totals).toMatchObject({ campaigns: 1, spend: 20, views: 250, view_rate: 25, cpv: 0.08, roas: 2.5 });
  });

  it("sends clicks, impressions, each campaign's goal and the complete-days window", async () => {
    execute.mockResolvedValue({
      campaigns: [
        { campaign_id: "1", campaign_name: "Pre-roll", status: "ENABLED", channel_type: "VIDEO", bidding_strategy_type: "TARGET_CPV", spend_usd: 20, conversions: 0, conversions_value_usd: 0, cpa_usd: null, impressions: 1000, clicks: 12, video_views: 250 },
        { campaign_id: "2", campaign_name: "Feed", status: "PAUSED", channel_type: "DEMAND_GEN", bidding_strategy_type: "MAXIMIZE_CONVERSIONS", spend_usd: 0, conversions: 0, conversions_value_usd: 0, cpa_usd: null, impressions: 0, clicks: 3, video_views: 0 },
      ],
      totals: { spend_usd: 20, conversions: 0, conversions_value_usd: 0, impressions: 1000, video_views: 250 },
    });
    gadsSearch.mockResolvedValue([{ customer: { currencyCode: "USD", timeZone: "UTC", descriptiveName: " upcar.ai " } }]);
    const out = (await build(ctx())) as Record<string, any>;
    expect(out.account).toEqual({ name: "upcar.ai", customer_id: "123", campaign_count: 2 });
    expect(out.campaigns.map((c: any) => [c.goal, c.clicks, c.impressions])).toEqual([["Video views", 12, 1000], ["Demand Gen, conversions", 3, 0]]);
    expect(out.totals).toMatchObject({ clicks: 15, impressions: 1000 });
    const today = new Date().toISOString().slice(0, 10);
    const back = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    expect(out.period).toEqual({ from: back(30), to: back(1) });
  });

  it("works the total view rate out from views and impressions, not the rounded ratio", async () => {
    execute.mockResolvedValue({
      campaigns: [{ campaign_id: "1", campaign_name: "Shorts", status: "ENABLED", spend_usd: 20, conversions: 0, conversions_value_usd: 0, cpa_usd: null, impressions: 1000, video_views: 246, view_rate: 24.6, avg_cpv_usd: 0.08 }],
      totals: { spend_usd: 20, conversions: 0, conversions_value_usd: 0, impressions: 1000, video_views: 246, view_rate: 0.25, avg_cpv_usd: 0.08, cpa_usd: null },
    });
    const out = (await build(ctx())) as Record<string, any>;
    expect(out.totals.view_rate).toBe(24.6);
  });

  it("adds each video campaign's budget and the daily breakdown, video campaigns only", async () => {
    execute.mockResolvedValue({
      campaigns: [
        { campaign_id: "1", campaign_name: "Shorts", status: "ENABLED", channel_type: "DEMAND_GEN", spend_usd: 20, conversions: 0, conversions_value_usd: 0, cpa_usd: null },
        { campaign_id: "2", campaign_name: "Old video", status: "PAUSED", channel_type: "VIDEO", spend_usd: 0, conversions: 0, conversions_value_usd: 0, cpa_usd: null },
      ],
    });
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("customer.time_zone")) return [{ customer: { currencyCode: "USD", timeZone: "America/New_York" } }];
      if (q.includes("campaign.campaign_budget")) {
        return [
          { campaign: { id: "1", status: "ENABLED", campaignBudget: "b/shared" }, campaignBudget: { amountMicros: "25000000" } },
          { campaign: { id: "2", status: "PAUSED", campaignBudget: "b/2" }, campaignBudget: { amountMicros: "10000000" } },
          { campaign: { id: "9", status: "ENABLED", campaignBudget: "b/shared" }, campaignBudget: { amountMicros: "25000000" } },
        ];
      }
      if (q.includes("DURING TODAY")) return [{ campaign: { id: "1" }, metrics: { costMicros: "4000000" } }, { campaign: { id: "9" }, metrics: { costMicros: "9000000" } }];
      if (q.includes("segments.date")) return [{ campaign: { id: "1", name: "Shorts" }, segments: { date: "2026-11-01" }, metrics: { costMicros: "20000000" } }, { campaign: { id: "9", name: "Search" }, segments: { date: "2026-11-01" }, metrics: { costMicros: "50000000" } }];
      return [];
    });
    const out = (await build(ctx())) as Record<string, any>;
    expect(out.campaigns.map((c: any) => [c.id, c.channel_type, c.daily_budget, c.budget_shared])).toEqual([
      ["1", "DEMAND_GEN", 25, true],
      ["2", "VIDEO", 10, false],
    ]);
    expect(out.daily_budget).toMatchObject({ total_daily_budget_usd: 25, active_campaigns: 1, today: { spend_usd: 4, by_campaign: { "1": 4 } } });
    expect(out.daily_budget.days).toEqual([{ date: "2026-11-01", spend_usd: 20, by_campaign: { "1": 20 } }]);
  });

  it("leaves budgets out, not the page, when they cannot be read", async () => {
    execute.mockResolvedValue({ campaigns: [{ campaign_id: "1", campaign_name: "Shorts", status: "ENABLED", spend_usd: 20, conversions: 0, conversions_value_usd: 0, cpa_usd: null }] });
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("campaign.campaign_budget")) throw new Error("down");
      return [{ customer: { currencyCode: "USD" } }];
    });
    const out = (await build(ctx())) as Record<string, any>;
    expect(out.connected).toBe(true);
    expect(out.daily_budget).toBeUndefined();
    expect(out.campaigns[0].daily_budget).toBeUndefined();
  });

  it("says not connected, not 'could not be read', when Google Ads is not linked", async () => {
    execute.mockRejectedValue(err("google_ads_not_connected"));
    const out = (await build(ctx())) as Record<string, any>;
    expect(out).toMatchObject({ connected: false, error_code: "not_connected", campaigns: [] });
    expect(out.campaigns_note).toBeUndefined();
  });

  it("keeps a failed read connected, with its code and the reason", async () => {
    execute.mockRejectedValue(err("google_ads_query_failed"));
    const out = (await build(ctx())) as Record<string, any>;
    expect(out).toMatchObject({ connected: true, error_code: "google_ads_query_failed" });
    expect(out.campaigns_note).toContain("could not be read");
  });
});
