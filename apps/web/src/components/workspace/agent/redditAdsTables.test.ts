import { describe, expect, it } from "vitest";
import { redditAdsCampaignLinks, redditAdsCampaignTable, redditAdsChrome, redditAdsKpis } from "./redditAdsTables";

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const payload = {
  platform: "reddit_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  prev_period: { from: "2026-08-03", to: "2026-09-01" },
  account: { name: "Main", account_count: 1, campaign_count: 2, active_count: 1, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [
    { id: "c1", currency: "USD", name: "Live", status: "ACTIVE", daily_budget: 15, spend: 0, clicks: 0, conversions: 0, cpa: null, url: "https://ads.reddit.com/account/a2_x/campaigns" },
    { id: "c2", currency: "USD", name: "Held", status: "PAUSED", daily_budget: null, spend: 0, clicks: 0, conversions: 0, cpa: null, url: "https://ads.reddit.com/account/a2_x/campaigns" },
  ],
};

describe("reddit_ads kpiFallback", () => {
  it("draws six tiles: counts as zero and undefined ratios as unmeasured when nothing ran", () => {
    const m = redditAdsKpis(payload);
    expect(m.map((x) => x.key)).toEqual(["spend", "cpa", "conversions", "clicks", "ctr", "cpc"]);
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
    for (const k of ["spend", "conversions", "clicks"]) expect(byKey[k]).toMatchObject({ value: 0, grounded: true });
    for (const k of ["cpa", "ctr", "cpc"]) {
      expect(Number.isNaN(byKey[k].value)).toBe(true);
      expect(byKey[k].unmeasured).toBeTruthy();
    }
  });

  it("shows real numbers when the account spent", () => {
    const spent = { spend: 60, impressions: 10_000, clicks: 200, conversions: 5, ctr: 2, cpc: 0.3, cpa: 12 };
    const m = redditAdsKpis({ ...payload, totals: spent });
    expect(Object.fromEntries(m.map((x) => [x.key, x.value]))).toEqual({ spend: 60, cpa: 12, conversions: 5, clicks: 200, ctr: 2, cpc: 0.3 });
  });

  it("draws nothing for an unconnected or failed read", () => {
    expect(redditAdsKpis({ ...payload, connected: false, totals: null })).toEqual([]);
    expect(redditAdsKpis({ ...payload, error_code: "reddit_ads_read_failed" })).toEqual([]);
  });
});

describe("reddit_ads campaigns table and chrome", () => {
  it("lists campaigns with their status and counts the active ones", () => {
    const [t] = redditAdsCampaignTable(payload);
    expect(t.columns.map((c) => c.label)).toEqual(["Campaign", "Status", "Daily budget", "Spend", "Clicks", "Conv.", "CPA"]);
    expect(t.rows.map((r) => r.cells.slice(0, 3).map((c) => c.text))).toEqual([["Live", "Active", "$15"], ["Held", "Paused", "-"]]);
    expect(t.footer).toHaveLength(7);
    expect(t.footer?.[0]?.text).toBe("1 active of 2");
    expect(redditAdsCampaignLinks(payload).Live).toContain("ads.reddit.com");
  });

  it("shows a delivery status in words and leaves an unreported campaign unread", () => {
    const unfunded = { id: "c3", currency: "USD", name: "Unfunded", status: "CAMPAIGN_NOT_FUNDED", spend: null, clicks: null, conversions: null, cpa: null, url: null };
    const [t] = redditAdsCampaignTable({ ...payload, campaigns: [...payload.campaigns, unfunded] });
    expect(t.rows[2].cells.map((c) => c.text)).toEqual(["Unfunded", "Campaign not funded", "-", "-", "-", "-", "-"]);
    expect(t.caption).toContain("reported nothing");
  });

  it("names the account and offers a reconnect on a revoked token", () => {
    expect(redditAdsChrome(payload)?.account).toEqual({ name: "Main", sub: "1 active campaign" });
    const chrome = redditAdsChrome({ ...payload, error_code: "reddit_ads_token_revoked" });
    expect(chrome?.problem).toMatchObject({ reconnect: true });
  });
});
