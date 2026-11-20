import { describe, expect, it, vi } from "vitest";
import { extraTableData } from "../legacyChannelActions";
import type { GadsPayload } from "./types";

const open = vi.hoisted(() => vi.fn());
vi.mock("../../actions/managed-campaigns/google/googleEditorApi", () => ({ openGoogleCampaignEditor: open }));

const gads = (over: Partial<GadsPayload> = {}) =>
  ({
    platform: "google_ads",
    connected: true,
    error_code: null,
    campaigns: [
      { id: "1", name: "Brand", status: "ENABLED", limited_by_budget: false, spend: 300, conversions: 10, cpa: 30, conv_value: 900, url: null, daily_budget: 20, budget_shared: false },
      { id: "2", name: "Generic", status: "PAUSED", limited_by_budget: false, spend: 40, conversions: 1, cpa: 40, conv_value: 0, url: null, daily_budget: 10, budget_shared: true },
    ],
    paused_campaigns: [{ id: "3", name: "New build", url: null, daily_budget: 15 }],
    totals: { campaigns: 2, spend: 340, conversions: 11, cpa: 30.91, conv_value: 900, roas: 2.65 },
    daily_budget: {
      total_daily_budget_usd: 20,
      active_campaigns: 1,
      today: { date: "2026-11-02", spend_usd: 8, by_campaign: { "1": 8 } },
      days: [{ date: "2026-11-01", spend_usd: 25, by_campaign: { "1": 21, "2": 4 } }],
      campaigns: [
        { campaign_id: "1", campaign_name: "Brand", status: "ENABLED", daily_budget_usd: 20, shared: false },
        { campaign_id: "2", campaign_name: "Generic", status: "PAUSED", daily_budget_usd: null, shared: true },
      ],
    },
    ...over,
  }) as unknown as GadsPayload;

describe("Google Ads daily budget", () => {
  it("leads with a breakdown: today against the budget, then each day by campaign", () => {
    const [b, t] = extraTableData("campaign_table", gads());
    expect(b.title).toBe("Daily budget: $20 / day across 1 enabled campaign");
    expect(b.columns.map((c) => c.label)).toEqual(["Day", "Spend", "Budget", "Used", "Brand", "Generic"]);
    expect(b.rows[0].cells.map((c) => c.text)).toEqual(["Today", "$8", "$20", "40%", "$8", "$0"]);
    expect(b.rows[1].cells.map((c) => c.text)).toEqual(["Nov 1", "$25", "$20", "125%", "$21", "$4"]);
    expect(b.caption).toMatch(/compared with today's budget/);
    expect(t.title).toBe("Campaign performance");
  });

  it("adds a Daily budget column, marking a shared budget", () => {
    const [, t] = extraTableData("campaign_table", gads());
    expect(t.columns.map((c) => c.label)).toEqual(["Campaign", "Status", "Daily budget", "Spend", "Conv.", "CPA", "Conv. value"]);
    expect(t.rows[0].cells[2].text).toBe("$20 / day");
    expect(t.rows[1].cells[2]).toMatchObject({ text: "$10 / day", sub: "shared" });
    expect(t.footer?.[2].text).toBe("$20 / day");
  });

  it("an older backend: no breakdown and the table as it was", () => {
    const [t, more] = extraTableData("campaign_table", gads({ daily_budget: undefined, campaigns: gads().campaigns.map(({ daily_budget, budget_shared, ...c }) => c) as never }));
    expect(more).toBeUndefined();
    expect(t.columns).toHaveLength(6);
  });

  it("a failed spend read never says there was no spend", () => {
    const db = gads().daily_budget!;
    const [failed] = extraTableData("campaign_table", gads({ daily_budget: { ...db, today: null, days: [], history_unreadable: true } }));
    expect(failed.rows).toEqual([]);
    expect(failed.empty).toBe("Zavi could not read Google Ads spend just now. Refresh in a minute.");
    expect(failed.caption).toContain("could not read the earlier days' spend");
    const [todayFailed] = extraTableData("campaign_table", gads({ daily_budget: { ...db, today: null, days: [] } }));
    expect(todayFailed.empty).toBe("Zavi could not read Google Ads spend just now. Refresh in a minute.");
    const [none] = extraTableData("campaign_table", gads({ daily_budget: { ...db, today: { date: "2026-11-02", spend_usd: 0, by_campaign: {} }, days: [] } }));
    expect(none.empty).toBe("No Google Ads spend in this range yet.");
  });

  it("no breakdown when the read failed", () => {
    const tables = extraTableData("campaign_table", gads({ error_code: "google_ads_query_failed" }));
    expect(tables.map((t) => t.title)).toEqual(["Campaign performance"]);
  });
});

describe("Google Ads campaign table actions", () => {
  it("an owner gets Edit, Launch on a paused one, and the paused-only campaigns behind a toggle", () => {
    const [, t] = extraTableData("campaign_table", gads(), undefined, { role: "owner" });
    expect(t.rows.map((r) => [r.id, r.actions?.[0]?.label, !!r.tail])).toEqual([
      ["1", "Edit", false],
      ["2", "Launch…", false],
      ["3", "Launch…", true],
    ]);
    expect(t.tailToggle?.show(1)).toBe("Show 1 paused campaign");
    t.rows[2].actions![0].onClick!();
    expect(open).toHaveBeenCalledWith({ campaign_id: "3" }, "google_ads");
  });

  it("a member gets no editor buttons and no paused list", () => {
    const [, t] = extraTableData("campaign_table", gads(), undefined, { role: "member" });
    expect(t.rows.map((r) => r.actions)).toEqual([undefined, undefined]);
  });
});
