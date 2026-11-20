
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn(), daily: vi.fn(), creds: vi.fn() }));
vi.mock("@/services/tools/google-ads/list_campaigns", () => ({ listCampaignsTool: { execute: m.list } }));
vi.mock("@/services/tools/google-ads/daily_series", () => ({ fetchGoogleDailySeries: m.daily }));
vi.mock("@/services/tools/google-ads/_client", () => ({ googleAdsCreds: m.creds, gadsSearch: vi.fn() }));

import { googleCampaignLite } from "@/routes/agents/dashboard";
import { googleCampaignUrl, readGoogleCampaigns } from "@/routes/agents/dashboards/_google-campaigns";

const ROW = {
  campaign_id: "111",
  campaign_name: "Emergency Plumbing",
  status: "ENABLED",
  channel_type: "SEARCH",
  start_time: "2026-01-01 00:00:00",
  end_time: null,
  daily_budget_usd: 180,
  spend_usd: 5240,
  impressions: 40000,
  clicks: 2000,
  ctr: 0.05,
  avg_cpc_usd: 2.62,
  cpm_usd: 131,
  conversions: 128,
  conversions_value_usd: 22300,
  roas: 4.26,
  cpa_usd: 40.94,
};

beforeEach(() => {
  m.list.mockReset().mockResolvedValue({ campaigns: [ROW] });
  m.daily.mockReset().mockResolvedValue({ rows: [{ date: "2026-09-01", campaign_id: "111" }] });
  m.creds.mockReset().mockResolvedValue({ customer_id: "1234567890" });
});

describe("googleCampaignLite (perf dashboard Google row)", () => {
  it("maps a list_campaigns row exactly as before the extraction", () => {
    expect(googleCampaignLite(ROW, "1234567890")).toEqual({
      channel: "google",
      campaign_id: "111",
      campaign_name: "Emergency Plumbing",
      status: "ENABLED",
      start_time: "2026-01-01 00:00:00",
      end_time: null,
      reach: null,
      spend_usd: 5240,
      conversions: 128,
      revenue_usd: 22300,
      roas: 4.26,
      cpa_usd: 40.94,
      impressions: 40000,
      clicks: 2000,
      ctr_percent: 5,
      cpc_usd: 2.62,
      cpm_usd: 131,
      frequency: null,
      purchases: 0,
      sign_ups: 0,
      leads: 0,
      cost_per_booking_usd: null,
      active_daily_budget_usd: 180,
      optimization_label: null,
      ad_sets: [],
      objective_key: expect.any(String),
      objective_label: expect.any(String),
      primary_result_label: expect.any(String),
      primary_result_count: expect.any(Number),
      primary_cost_label: expect.anything(),
      primary_cost_usd: expect.anything(),
      objective_status: expect.any(String),
      triage_reasons: [],
      confidence_reasons: [
        "Platform-reported Google Ads data",
        "Daily cap unavailable",
        "Generic conversions are not bookings",
      ],
      is_delivering: true,
      pending_change: null,
      recent_daily_spend_usd: null,
      triage_state: expect.any(String),
      manage_url: "https://ads.google.com/aw/campaigns?__c=1234567890&campaignId=111",
    });
  });
});

describe("readGoogleCampaigns", () => {
  it("reads every status for the window and returns rows, series and customer id", async () => {
    const r = await readGoogleCampaigns("t1", { date_range: "LAST_30_DAYS", custom_range: { since: "2026-08-01", until: "2026-08-30" } });
    expect(m.list).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1" }),
      { date_range: "LAST_30_DAYS", custom_range: { since: "2026-08-01", until: "2026-08-30" }, status: "ALL" },
    );
    expect(m.daily).toHaveBeenCalledWith("t1", { date_range: "LAST_30_DAYS", custom_range: { since: "2026-08-01", until: "2026-08-30" } });
    expect(r.campaigns).toEqual([ROW]);
    expect(r.customer_id).toBe("1234567890");
    expect(r.daily?.rows).toHaveLength(1);
  });

  it("a failed series or creds read degrades to null; a failed campaign read throws", async () => {
    m.daily.mockRejectedValue(new Error("slow"));
    m.creds.mockRejectedValue(new Error("vault"));
    const r = await readGoogleCampaigns("t1", { date_range: "LAST_7_DAYS" });
    expect(r.daily).toBeNull();
    expect(r.customer_id).toBeNull();
    m.list.mockRejectedValue(Object.assign(new Error("revoked"), { code: "google_ads_token_revoked" }));
    await expect(readGoogleCampaigns("t1", { date_range: "LAST_7_DAYS" })).rejects.toThrow("revoked");
  });

  it("builds no deep link without a customer id", () => {
    expect(googleCampaignUrl(null, "1")).toBeNull();
  });
});
