import { describe, expect, it } from "vitest";
import { campaignLinksOf, channelChrome, extraTableData, kpiFallbackMetrics } from "./legacyChannelActions";
import { xAdsCampaignTable, xAdsChrome, xAdsKpis } from "./xAdsTables";

const totals = { spend: 120, impressions: 20_000, clicks: 400, conversions: 6, ctr: 2, cpc: 0.3, cpa: 20 };
const payload = {
  platform: "x_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  prev_period: { from: "2026-08-03", to: "2026-09-01" },
  account: { name: "Acme", account_count: 1, campaign_count: 2, active_count: 1, currency: "USD" },
  totals,
  prev_totals: totals,
  campaigns: [
    { id: "c1", ad_account_id: "18ce54", currency: "USD", name: "Live", status: "ACTIVE", spend: 120, impressions: 20_000, clicks: 400, conversions: 6, cpa: 20, url: "https://ads.x.com/campaign/c1", daily_budget: 40, total_budget: null },
    { id: "c2", ad_account_id: "18ce54", currency: "USD", name: "Held", status: "PAUSED", spend: 0, impressions: 0, clicks: 0, conversions: 0, cpa: null, url: null, daily_budget: null, total_budget: 500 },
  ],
};

describe("x_ads dashboard adapters", () => {
  it("draws the six tiles through the kpiFallback switch", () => {
    expect(kpiFallbackMetrics("x_ads", payload).map((m) => [m.key, m.value])).toEqual([
      ["spend", 120], ["cpa", 20], ["conversions", 6], ["clicks", 400], ["ctr", 2], ["cpc", 0.3],
    ]);
    expect(xAdsKpis({ ...payload, error_code: "x_ads_read_failed" })).toEqual([]);
    expect(xAdsKpis({ ...payload, platform: "reddit_ads" })).toEqual([]);
  });

  it("lists campaigns with a daily budget column", () => {
    const [t] = extraTableData("campaign_table", payload, () => {});
    expect(t.columns.map((c) => c.label)).toEqual(["Campaign", "Status", "Daily budget", "Spend", "Clicks", "Conv.", "CPA"]);
    expect(t.rows.map((r) => r.cells.slice(0, 3).map((c) => c.text))).toEqual([["Live", "Active", "$40"], ["Held", "Paused", "-"]]);
    expect(t.footer).toHaveLength(7);
    expect(t.footer?.[0]?.text).toBe("1 active of 2");
    expect(campaignLinksOf(payload)).toEqual({ Live: "https://ads.x.com/campaign/c1" });
  });

  it("conversions X would not report show as unknown, never as zero", () => {
    const p = { ...payload, conversions_unmeasured: "X would not report conversions for this account" };
    const tiles = xAdsKpis(p);
    for (const key of ["cpa", "conversions"]) {
      expect(tiles.find((m) => m.key === key)).toMatchObject({ grounded: false, unmeasured: p.conversions_unmeasured });
    }
    expect(tiles.find((m) => m.key === "spend")).toMatchObject({ value: 120, grounded: true });
    const [t] = xAdsCampaignTable(p);
    expect(t.rows[0].cells.slice(-2).map((c) => c.text)).toEqual(["-", "-"]);
    expect(t.footer?.slice(-2).map((c) => c.text)).toEqual(["-", "-"]);
  });

  it("phrases each error code, offering reconnect only where it helps", () => {
    expect(channelChrome("x_ads", payload)?.account).toEqual({ name: "Acme", sub: "1 active campaign" });
    expect(xAdsChrome({ ...payload, error_code: "x_ads_forbidden" })?.problem).toMatchObject({ reconnect: true });
    expect(xAdsChrome({ ...payload, error_code: "x_ads_not_connected", connected: false })?.problem).toMatchObject({ reconnect: true });
    expect(xAdsChrome({ ...payload, error_code: "x_ads_rate_limited" })?.problem).toMatchObject({ reconnect: false });
    expect(xAdsChrome({ ...payload, error_code: "x_ads_read_failed" })?.problem?.text).toContain("Try Refresh");
    expect(xAdsCampaignTable({ ...payload, connected: false })).toEqual([]);
  });
});
