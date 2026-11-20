
import { describe, it, expect } from "vitest";
import { mapMetaDailyRow } from "../daily_series";

describe("mapMetaDailyRow", () => {
  it("carries the per-day date + ids and extracts conversions by action_type", () => {
    const row = mapMetaDailyRow({
      date_start: "2026-06-20",
      campaign_id: "c1",
      campaign_name: "New Conversions Campaign",
      adset_id: "as1",
      adset_name: "Set A",
      spend: "100.5",
      impressions: "10000",
      clicks: "250",
      ctr: "2.5",
      cpm: "10.05",
      actions: [
        { action_type: "purchase", value: "2" },
        { action_type: "initiate_checkout", value: "5" },
        { action_type: "complete_registration", value: "40" },
        { action_type: "lead", value: "3" },
      ],
      action_values: [{ action_type: "purchase", value: "180" }],
    });
    expect(row.date).toBe("2026-06-20");
    expect(row.campaign_id).toBe("c1");
    expect(row.ad_set_id).toBe("as1");
    expect(row.spend_usd).toBe(100.5);
    expect(row.impressions).toBe(10000);
    expect(row.clicks).toBe(250);
    expect(row.purchases).toBe(2);
    expect(row.sign_ups).toBe(40);
    expect(row.leads).toBe(3);
    expect(row.conversions).toBe(47);
    expect(row.purchase_value_usd).toBe(180);
  });

  it("defaults missing fields to 0 / null without throwing (sparse early-day rows)", () => {
    const row = mapMetaDailyRow({ date_start: "2026-06-21", campaign_id: "c2", campaign_name: "X" });
    expect(row.date).toBe("2026-06-21");
    expect(row.ad_set_id).toBeNull();
    expect(row.spend_usd).toBe(0);
    expect(row.purchases).toBe(0);
    expect(row.sign_ups).toBe(0);
    expect(row.purchase_value_usd).toBe(0);
  });

  it("falls back to fb_pixel_* registration/lead action types", () => {
    const row = mapMetaDailyRow({
      date_start: "2026-06-22",
      campaign_id: "c3",
      campaign_name: "Y",
      actions: [
        { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "12" },
        { action_type: "offsite_conversion.fb_pixel_lead", value: "4" },
      ],
    });
    expect(row.sign_ups).toBe(12);
    expect(row.leads).toBe(4);
  });
});
