import { describe, expect, it, vi } from "vitest";
import { extraTableData } from "../legacyChannelActions";
import type { GadsPayload } from "./types";

const open = vi.hoisted(() => vi.fn());
vi.mock("../../actions/managed-campaigns/google/googleEditorApi", () => ({ openGoogleCampaignEditor: open }));

const yt = (over: Partial<GadsPayload> = {}) =>
  ({
    platform: "youtube_ads",
    currency: "USD",
    connected: true,
    error_code: null,
    campaigns: [
      { id: "1", name: "Shorts", status: "ENABLED", limited_by_budget: false, spend: 20, conversions: 2, cpa: 10, conv_value: 50, url: null, views: 250, view_rate: 25, cpv: 0.08 },
    ],
    totals: { campaigns: 1, spend: 20, conversions: 2, cpa: 10, conv_value: 50, roas: 2.5, views: 250, view_rate: 25, cpv: 0.08 },
    ...over,
  }) as unknown as GadsPayload;

describe("the YouTube Ads campaign table", () => {
  it("shows views, view rate and cost per view, in rows and in the totals", () => {
    const [t] = extraTableData("campaign_table", yt());
    expect(t.columns.map((c) => c.label)).toEqual(["Campaign", "Status", "Spend", "Views", "View rate", "Cost per view", "Conv.", "CPA", "Conv. value"]);
    expect(t.rows[0].cells.slice(3, 6).map((c) => c.text)).toEqual(["250", "25%", "$0.08"]);
    expect(t.footer?.length).toBe(9);
  });

  it("draws no table when Google Ads is not connected", () => {
    expect(extraTableData("campaign_table", yt({ connected: false, error_code: "not_connected", campaigns: [], totals: null }))).toEqual([]);
  });

  it("says the read failed rather than that nothing spent", () => {
    const [t] = extraTableData("campaign_table", yt({ error_code: "google_ads_query_failed", campaigns: [], totals: null }));
    expect(t.empty).toBe("Zavi could not read your campaigns just now.");
  });

  it("leaves the Google Ads table's columns as they were", () => {
    const [t] = extraTableData("campaign_table", yt({ platform: "google_ads" }));
    expect(t.columns).toHaveLength(6);
  });

  it("with budgets: a breakdown first, a Daily budget column, and Edit on Demand Gen rows only", () => {
    const d = yt({
      campaigns: [
        { id: "1", name: "Shorts", status: "PAUSED", channel_type: "DEMAND_GEN", limited_by_budget: false, spend: 20, conversions: 2, cpa: 10, conv_value: 50, url: null, views: 250, view_rate: 25, cpv: 0.08, daily_budget: 15, budget_shared: false },
        { id: "2", name: "Old video", status: "ENABLED", channel_type: "VIDEO", limited_by_budget: false, spend: 5, conversions: 0, cpa: null, conv_value: 0, url: null, views: 10, view_rate: 5, cpv: 0.5, daily_budget: 10, budget_shared: false },
      ],
      daily_budget: { total_daily_budget_usd: 10, active_campaigns: 1, today: null, days: [{ date: "2026-11-01", spend_usd: 5, by_campaign: { "2": 5 } }], campaigns: [{ campaign_id: "2", campaign_name: "Old video", status: "ENABLED", daily_budget_usd: 10, shared: false }] },
    } as never);
    const [b, t] = extraTableData("campaign_table", d, undefined, { role: "owner" });
    expect(b.title).toBe("Daily budget: $10 / day across 1 enabled campaign");
    expect(b.caption).toMatch(/Demand Gen can also run/);
    expect(t.columns.map((c) => c.label)).toEqual(["Campaign", "Status", "Daily budget", "Spend", "Views", "View rate", "Cost per view", "Conv.", "CPA", "Conv. value"]);
    expect(t.rows.map((r) => r.actions?.[0]?.label)).toEqual(["Launch…", undefined]);
    t.rows[0].actions![0].onClick!();
    expect(open).toHaveBeenCalledWith({ campaign_id: "1" }, "youtube_ads");
  });
});
