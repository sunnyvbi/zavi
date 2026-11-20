import { describe, expect, it } from "vitest";
import { tiktokCampaignTable, tiktokChrome, tiktokKpis } from "./tiktokAdsTables";
import { formatMetricValue, metricDelta } from "../metrics/format";

const totals = { spend: 1000, impressions: 10000, clicks: 100, conversions: 10, conv_value: 2000, ctr: 1, cpa: 100, roas: 2 };
const report = (currency: string | null = "INR") => ({
  platform: "tiktok_ads", connected: true, error_code: null, window_days: 30,
  period: { from: "2026-09-01", to: "2026-09-30" },
  prev_period: { from: "2026-08-02", to: "2026-08-31" },
  account: { name: "Advertiser", advertiser_count: 1, campaign_count: 1, currency },
  totals, prev_totals: { ...totals, cpa: 90 },
  campaigns: [{ id: "1", name: "Campaign", status: "ACTIVE", currency, spend: 1000, conversions: 10, cpa: 100, conv_value: 2000, url: null }],
});

describe("TikTok reporting correctness", () => {
  it.each(["tiktok_ads_read_failed", "tiktok_ads_token_revoked", "tiktok_ads_bad_response", "tiktok_ads_rate_limited"])("does not render failed read %s as measured data", (error_code) => {
    const failed = { ...report(), error_code, totals: { ...totals, spend: 0, conversions: 0 }, campaigns: [] };
    expect(tiktokKpis(failed)).toEqual([]);
    expect(tiktokCampaignTable(failed)).toEqual([]);
    expect(tiktokChrome(failed)?.problem).not.toBeNull();
  });

  it("does not invent data when totals are missing", () => {
    expect(tiktokKpis({ ...report(), totals: null })).toEqual([]);
    expect(tiktokCampaignTable({ ...report(), totals: null })).toEqual([]);
  });

  it.each(["INR", "GBP", "EUR"])("shows %s on metrics, tables, CPA deltas and ROAS explanations", (currency) => {
    const data = report(currency);
    const metrics = tiktokKpis(data);
    const spend = metrics.find((metric) => metric.key === "spend")!;
    const cpa = metrics.find((metric) => metric.key === "cpa")!;
    expect(formatMetricValue(spend)).toBe(`${currency} 1,000`);
    expect(metricDelta(cpa)?.text).toBe(`+${currency} 10.00`);
    expect(metrics.find((metric) => metric.key === "roas")?.note).toBe(`${currency} 2.00 back per ${currency} 1 spent`);
    const table = tiktokCampaignTable(data)[0];
    expect(table.rows[0].cells[2].text).toBe(`${currency} 1,000`);
    expect(table.rows[0].cells[4].text).toBe(`${currency} 100.00`);
    expect(table.footer?.[2].text).toBe(`${currency} 1,000`);
  });

  it("retains existing dollar formatting for USD", () => {
    expect(formatMetricValue(tiktokKpis(report("USD"))[0])).toBe("$1,000");
    expect(tiktokCampaignTable(report("USD"))[0].rows[0].cells[2].text).toBe("$1,000");
  });

  it("shows native campaign currencies but withholds incompatible totals and verdicts", () => {
    const mixed = {
      ...report(null),
      totals: { ...totals, spend: null, conv_value: null, cpa: null, roas: null },
      prev_totals: { ...totals, spend: null, conv_value: null, cpa: null, roas: null },
      campaigns: [report("USD").campaigns[0], { ...report("INR").campaigns[0], id: "2" }],
    };
    const metrics = tiktokKpis(mixed);
    for (const key of ["spend", "cpa", "conv_value", "roas"]) {
      const metric = metrics.find((m) => m.key === key)!;
      expect(formatMetricValue(metric)).toBe("-");
      expect(metric.grounded).toBe(false);
      expect(metric.prev_value).toBeNull();
      expect(metric.tone).toBeUndefined();
      expect(metric.unmeasured).toBeTruthy();
    }
    expect(metrics.find((metric) => metric.key === "conversions")?.value).toBe(10);
    const table = tiktokCampaignTable(mixed)[0];
    expect(table.rows.map((row) => row.cells[2].text)).toEqual(["$1,000", "INR 1,000"]);
    expect(table.footer?.[2].text).toBe("-");
    expect(table.footer?.[1].text).toBe("ROAS -");
    expect(table.caption).toContain("single known currency");
  });

  it("uses retry guidance for rate limits and reconnect only for revoked access", () => {
    const limited = tiktokChrome({ ...report(), error_code: "tiktok_ads_rate_limited" });
    expect(limited?.problem).toMatchObject({ reconnect: false });
    expect(limited?.problem?.text).toContain("Wait a minute");
    expect(tiktokChrome({ ...report(), error_code: "tiktok_ads_token_revoked" })?.problem?.reconnect).toBe(true);
  });
});
