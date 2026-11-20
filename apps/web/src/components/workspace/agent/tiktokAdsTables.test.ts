import { describe, expect, it } from "vitest";
import { channelChrome, extraTableData, kpiFallbackMetrics } from "./legacyChannelActions";

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0, ctr: null, cpa: null, roas: null };
const payload = {
  platform: "tiktok_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-01", to: "2026-09-30" },
  prev_period: { from: "2026-08-02", to: "2026-08-31" },
  account: { name: "2 advertisers", advertiser_count: 2, campaign_count: 0, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [],
};

describe("tiktok kpiFallback", () => {
  it.each([
    [["ADGROUP_STATUS_TIME_DONE"], "Ended"],
    [["ADGROUP_STATUS_TIME_DONE", "ADGROUP_STATUS_DELIVERY_OK"], "Enabled · 1/2 ad groups ended"],
  ])("shows child schedule completion without marking a mixed campaign ended", (statuses, label) => {
    const [table] = extraTableData("campaign_table", { ...payload, campaigns: [{ id: "2", name: "Test 2", status: "ACTIVE", secondary_status: "CAMPAIGN_STATUS_ENABLE", ad_groups: (statuses as string[]).map((secondary_status) => ({ status: "ACTIVE", secondary_status })), spend: 0, conversions: 0, conv_value: 0, currency: "USD" }] });
    expect(table.rows[0].cells[1]).toMatchObject({ text: label, chip: "muted" });
  });
  it("draws counts as zero and undefined ratios as unmeasured when nothing ran", () => {
    const m = kpiFallbackMetrics("tiktok_ads", payload);
    expect(m.map((x) => x.key)).toEqual(["spend", "cpa", "conversions", "conv_value", "roas", "ctr"]);
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
    for (const k of ["spend", "conversions", "conv_value"]) expect(byKey[k]).toMatchObject({ value: 0, grounded: true });
    for (const k of ["cpa", "roas", "ctr"]) {
      expect(Number.isNaN(byKey[k].value)).toBe(true);
      expect(byKey[k].unmeasured).toBeTruthy();
      expect(byKey[k].prev_value).toBeNull();
    }
    expect(byKey.roas.tone).toBeUndefined();
  });

  it("never shows a $0 CPA for spend with no conversions", () => {
    const spent = { ...zero, spend: 500, impressions: 1000, clicks: 10, ctr: 1, roas: 0 };
    const m = kpiFallbackMetrics("tiktok_ads", { ...payload, totals: spent });
    const cpa = m.find((x) => x.key === "cpa");
    expect(Number.isNaN(cpa?.value)).toBe(true);
    expect(cpa?.unmeasured).toBe(true);
    const [t] = extraTableData("campaign_table", { ...payload, totals: spent });
    expect(t.footer?.[4]?.text).toBe("-");
  });

  it("draws an empty campaign table with a zero footer", () => {
    const [t] = extraTableData("campaign_table", payload);
    expect(t.rows).toEqual([]);
    expect(t.caption).toBe("Numbers as reported by TikTok Ads.");
    expect(t.footer?.[2]?.text).toBe("$0");
  });

  it("reports the account and asks for a reconnect on a revoked token", () => {
    expect(channelChrome("tiktok_ads", payload)?.account).toEqual({ name: "2 advertisers", sub: "0 campaigns" });
    const revoked = channelChrome("tiktok_ads", { ...payload, error_code: "tiktok_ads_token_revoked" });
    expect(revoked?.problem?.reconnect).toBe(true);
  });

  it("draws nothing for a disconnected account", () => {
    expect(kpiFallbackMetrics("tiktok_ads", { ...payload, connected: false })).toEqual([]);
    expect(channelChrome("tiktok_ads", { ...payload, connected: false })?.connected).toBe(false);
  });

  it("shows TikTok's budget blocker even when the campaign switch is enabled", () => {
    const [table] = extraTableData("campaign_table", { ...payload, campaigns: [{ id: "1", name: "Test 1", status: "ACTIVE", secondary_status: "CAMPAIGN_STATUS_BUDGET_EXCEED", spend: 50, conversions: 0, conv_value: 0, currency: "USD" }] });
    expect(table.rows[0].cells[1]).toMatchObject({ text: "Budget exceeded", chip: "muted" });
  });

  it("does not mark an enabled campaign as healthy delivery", () => {
    const [table] = extraTableData("campaign_table", { ...payload, campaigns: [{ id: "2", name: "Test 2", status: "ACTIVE", secondary_status: "CAMPAIGN_STATUS_ENABLE", spend: 0, conversions: 0, conv_value: 0, currency: "USD" }] });
    expect(table.rows[0].cells[1]).toMatchObject({ text: "Enabled", chip: "muted" });
  });
});
