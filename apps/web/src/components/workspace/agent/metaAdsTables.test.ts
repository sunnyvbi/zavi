
import { describe, expect, it } from "vitest";
import { metaCampaignTable, metaChrome, metaKpis } from "./metaAdsTables";

const payload = (roas: number | null) => ({
  window: "last_30d",
  channels: [
    { channel: "meta", connected: true, spend_usd: 500, conversions: 4, revenue_usd: 380, roas, cpa_usd: 125, ctr_percent: 1.2 },
  ],
  campaigns: [],
});

describe("metaKpis ROAS", () => {
  it("is red under 1 with the dollars-back note", () => {
    const r = metaKpis(payload(0.76)).find((m) => m.key === "roas")!;
    expect(r).toMatchObject({ tone: "bad", note: "$0.76 back per $1 spent" });
  });

  it("is green at 1 or above, and carries no verdict when it could not be read", () => {
    expect(metaKpis(payload(2.4)).find((m) => m.key === "roas")!.tone).toBe("good");
    const unread = metaKpis(payload(null)).find((m) => m.key === "roas")!;
    expect(unread.tone).toBeUndefined();
    expect(unread.note).toBeUndefined();
  });

  it("leaves every other number without a verdict", () => {
    const spend = metaKpis(payload(0.76)).find((m) => m.key === "spend")!;
    expect(spend.tone).toBeUndefined();
  });
});

describe("a Meta account Zavi could not read", () => {
  const revoked = {
    window: "last_30d",
    connected: { meta: true },
    channels: [{ channel: "meta", connected: true, spend_usd: 0, conversions: 0, revenue_usd: 0, roas: null, cpa_usd: null, ctr_percent: null }],
    campaigns: [],
    channel_errors: { meta: { code: "meta_ads_token_expired", message: "Reconnect." } },
    served_last_good: false,
  };

  it("draws no numbers instead of a $0 spend", () => {
    expect(metaKpis(revoked)).toEqual([]);
  });

  it("says the campaigns could not be read, not that none is active", () => {
    expect(metaCampaignTable(revoked)[0].empty).toBe("Zavi could not read your Meta campaigns, so none are listed.");
  });

  it("drops the '0 active campaigns' line and keeps the reconnect banner", () => {
    const c = metaChrome(revoked)!;
    expect(c.account).toBeNull();
    expect(c.problem?.reconnect).toBe(true);
  });

  it("still shows numbers when an earlier good read was served", () => {
    expect(metaKpis({ ...revoked, served_last_good: true }).length).toBeGreaterThan(0);
  });

  it("stays unread when only another channel was served from an earlier read", () => {
    const googleOnly = { ...revoked, served_last_good: true, served_last_good_channels: ["google"] };
    expect(metaKpis(googleOnly)).toEqual([]);
    expect(metaChrome(googleOnly)!.account).toBeNull();
  });

  it("shows numbers when Meta itself was served from an earlier read", () => {
    expect(metaKpis({ ...revoked, served_last_good: true, served_last_good_channels: ["meta"] }).length).toBeGreaterThan(0);
  });

  it("never hides real numbers behind an error flag (Meta busy, numbers present)", () => {
    const busy = {
      ...revoked,
      channel_errors: { meta: { code: "meta_ads_busy", message: "Busy." } },
      channels: [{ ...revoked.channels[0], spend_usd: 6732.16, conversions: 10 }],
    };
    expect(metaKpis(busy).length).toBeGreaterThan(0);
  });
});

describe("Meta daily budget breakdown", () => {
  const base = {
    window: "last_7d",
    connected: { meta: true },
    channels: [{ channel: "meta", connected: true, spend_usd: 300, conversions: 3, revenue_usd: 0, roas: null, cpa_usd: 100, ctr_percent: 1 }],
    campaigns: [
      { channel: "meta", campaign_id: "a", campaign_name: "Alpha", status: "ACTIVE", spend_usd: 200, conversions: 2, revenue_usd: 0, cpa_usd: 100, manage_url: null, active_daily_budget_usd: 100 },
      { channel: "meta", campaign_id: "b", campaign_name: "Beta", status: "ACTIVE", spend_usd: 100, conversions: 1, revenue_usd: 0, cpa_usd: 100, manage_url: null, active_daily_budget_usd: 80 },
    ],
  };
  const breakdown = {
    total_daily_budget_usd: 180,
    active_campaigns: 2,
    today: { date: "2026-11-01", spend_usd: 112, by_campaign: { a: 70, b: 42 } },
    days: [{ date: "2026-10-31", spend_usd: 176, by_campaign: { a: 90, b: 86 } }],
    campaigns: [
      { campaign_id: "a", campaign_name: "Alpha", status: "ACTIVE", daily_budget_usd: 100 },
      { campaign_id: "b", campaign_name: "Beta", status: "ACTIVE", daily_budget_usd: 80 },
    ],
    truncated: false,
  };

  it("draws today then each day, split by campaign, before the campaign table", () => {
    const [daily, campaigns] = metaCampaignTable({ ...base, meta_daily_budget: breakdown });
    expect(daily.title).toBe("Daily budget: $180 / day across 2 active campaigns");
    expect(daily.columns.map((c) => c.label)).toEqual(["Day", "Spend", "Budget", "Used", "Alpha", "Beta"]);
    expect(daily.rows[0].cells.map((c) => c.text)).toEqual(["Today", "$112", "$180", "62%", "$70", "$42"]);
    expect(daily.rows[1].cells.map((c) => c.text)).toEqual(["Oct 31", "$176", "$180", "98%", "$90", "$86"]);
    expect(campaigns.columns.map((c) => c.label)).toContain("Daily budget");
    expect(campaigns.rows[0].cells[2].text).toBe("$100 / day");
    expect(campaigns.footer?.[2].text).toBe("$180 / day");
  });

  it("a failed spend read never says there was no spend", () => {
    const [failed] = metaCampaignTable({ ...base, meta_daily_budget: { ...breakdown, today: null, days: [], history_unreadable: true } });
    expect(failed.rows).toEqual([]);
    expect(failed.empty).toBe("Zavi could not read Meta spend just now. Refresh in a minute.");
    expect(failed.caption).toContain("could not read the earlier days' spend");
    const [todayFailed] = metaCampaignTable({ ...base, meta_daily_budget: { ...breakdown, today: null, days: [] } });
    expect(todayFailed.empty).toBe("Zavi could not read Meta spend just now. Refresh in a minute.");
    const [none] = metaCampaignTable({ ...base, meta_daily_budget: { ...breakdown, today: { date: null, spend_usd: 0, by_campaign: {} }, days: [] } });
    expect(none.empty).toBe("No Meta spend in this range yet.");
  });

  it("is left out when the backend sends no breakdown", () => {
    const tables = metaCampaignTable(base);
    expect(tables).toHaveLength(1);
    expect(tables[0].title).toBe("Active campaigns");
  });
});

describe("Meta campaign table: Zavi's editor from a row", () => {
  const camp = (id: string, status: string) => ({ channel: "meta", campaign_id: id, campaign_name: id, status, spend_usd: 0, conversions: 0, revenue_usd: 0, cpa_usd: null, manage_url: null, active_daily_budget_usd: 10 });
  const p = { window: "last_7d", channels: [{ channel: "meta", connected: true, spend_usd: 0, conversions: 0, revenue_usd: 0, roas: null, cpa_usd: null, ctr_percent: null }], campaigns: [camp("on1", "ACTIVE"), camp("off1", "PAUSED")] };

  it("an owner or admin gets Edit on live rows and Launch on paused ones, behind Show paused", () => {
    const [t] = metaCampaignTable(p, { canEdit: true });
    expect(t.rows.map((r) => [r.id, r.actions?.[0]?.label, r.tail ?? false])).toEqual([["on1", "Edit", false], ["off1", "Launch…", true]]);
    expect(t.tailToggle?.show(1)).toBe("Show 1 paused campaign");
  });

  it("anyone else sees only the live rows, with no buttons", () => {
    const [t] = metaCampaignTable(p);
    expect(t.rows.map((r) => [r.id, r.actions])).toEqual([["on1", undefined]]);
  });
});
