import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdAnalyticsRow } from "@/services/connectors/linkedin-ads/client";

const m = vi.hoisted(() => ({
  rows: [] as AdAnalyticsRow[],
  accounts: [] as Array<{ id: string; name: string; currency: string | null; status: string | null }>,
  accountsFail: false,
  history: [] as AdAnalyticsRow[],
  historyFail: false,
  windows: [] as number[],
}));
vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinWalletGroups: async () => [], linkedinAccountAccess: async () => ({ kind: "own" }) }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  readLinkedInAdAnalytics: vi.fn(async (_t: string, _a: string, o: { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } }) => {
    const days = (Date.UTC(o.end.year, o.end.month - 1, o.end.day) - Date.UTC(o.start.year, o.start.month - 1, o.start.day)) / 86_400_000;
    m.windows.push(days);
    if (days <= 90) return m.rows;
    if (m.historyFail) throw new Error("linkedin down");
    return m.history;
  }),
  listLinkedInAdAccounts: vi.fn(async () => {
    if (m.accountsFail) throw new Error("linkedin down");
    return m.accounts;
  }),
}));

import { linkedinAdsReadAnalyticsTool, spendTotals } from "../read_analytics";

const ctx = { tenant_id: "t-1" } as never;
const row = (over: Partial<AdAnalyticsRow>): AdAnalyticsRow => ({
  pivot: "urn:li:sponsoredCampaign:1",
  impressions: 4000,
  clicks: 60,
  spend: 420.5,
  conversions: 0,
  leads: 0,
  missing_metrics: [],
  ...over,
});
type Out = {
  currency: string | null;
  currency_note?: string;
  conversion_tracking: string;
  totals: { spend: number | null; currency: string | null; spend_by_currency?: Record<string, number> };
  rows: Array<AdAnalyticsRow & { currency: string | null; pause_signal: string; pause_note: string }>;
};
const read = async () => (await linkedinAdsReadAnalyticsTool.execute(ctx, { account_id: "5001" })) as Out;

beforeEach(() => {
  m.accountsFail = false;
  m.history = [];
  m.historyFail = false;
  m.windows = [];
  m.accounts = [
    { id: "5001", name: "Main", currency: "INR", status: "ACTIVE" },
    { id: "5002", name: "Other", currency: "EUR", status: "ACTIVE" },
  ];
});

describe("read_analytics money carries the account currency", () => {
  it("every row and the total carry the read account's currency, not another account's and not USD", async () => {
    m.rows = [row({ pivot: "urn:li:sponsoredCampaign:1", spend: 1200 }), row({ pivot: "urn:li:sponsoredCampaign:2", spend: 800, conversions: 3 })];
    const out = await read();
    expect(out.currency).toBe("INR");
    expect(out.rows.map((r) => r.currency)).toEqual(["INR", "INR"]);
    expect(out.totals).toMatchObject({ spend: 2000, currency: "INR" });
    expect(JSON.stringify(out)).not.toContain("USD");
  });

  it("an unreadable currency is null with a note that forbids a symbol, never a guessed USD", async () => {
    m.accountsFail = true;
    m.rows = [row({})];
    const out = await read();
    expect(out.currency).toBeNull();
    expect(out.rows[0].currency).toBeNull();
    expect(out.totals.currency).toBeNull();
    expect(out.currency_note).toMatch(/never with a \$/);
  });

  it("mixed currencies are never summed into one number", () => {
    const t = spendTotals([
      { ...row({ spend: 100 }), currency: "INR" },
      { ...row({ spend: 50 }), currency: "EUR" },
      { ...row({ spend: 25 }), currency: "INR" },
    ]);
    expect(t.spend).toBeNull();
    expect(t.currency).toBeNull();
    expect(t.spend_by_currency).toEqual({ INR: 125, EUR: 50 });
  });
});

describe("read_analytics pause signal counts lead-form leads and refuses to call untracked spend waste", () => {
  it("a lead-gen campaign with lead-form leads and no website conversions is not waste", async () => {
    m.rows = [row({ pivot: "urn:li:sponsoredCampaign:1", conversions: 0, leads: 14 }), row({ pivot: "urn:li:sponsoredCampaign:2", conversions: 0, leads: 0 })];
    m.history = [row({ pivot: "urn:li:sponsoredCampaign:2" })];
    const out = await read();
    expect(out.rows[0].pause_signal).toBe("has_results");
    expect(out.rows[1].pause_signal).toBe("tracking_unverified");
    expect(out.conversion_tracking).toBe("unverified");
  });

  it("an account with no conversions and no leads anywhere is untracked: no pause candidate, it says tracking is missing", async () => {
    m.rows = [row({ pivot: "urn:li:sponsoredCampaign:1" }), row({ pivot: "urn:li:sponsoredCampaign:2", spend: 90 })];
    m.history = [row({ pivot: "urn:li:sponsoredCampaign:1" }), row({ pivot: "urn:li:sponsoredCampaign:2", spend: 90 })];
    const out = await read();
    expect(out.conversion_tracking).toBe("unverified");
    expect(out.rows.map((r) => r.pause_signal)).toEqual(["tracking_unverified", "tracking_unverified"]);
    expect(out.rows[0].pause_note).toMatch(/tracking is unverified/);
    expect(out.rows[0].pause_note).toMatch(/do not propose a pause/);
  });

  it("a row whose conversions or leads LinkedIn suppressed is unread even when tracking fires elsewhere", async () => {
    m.rows = [row({ pivot: "urn:li:sponsoredCampaign:1", conversions: 5 }), row({ pivot: "urn:li:sponsoredCampaign:2", missing_metrics: ["leads"] })];
    const out = await read();
    expect(out.rows[1].pause_signal).toBe("metrics_unread");
    expect(out.conversion_tracking).toBe("unverified");
  });

  it("a suppressed metric elsewhere does not verify tracking", async () => {
    m.rows = [row({ pivot: "urn:li:sponsoredCampaign:1", conversions: 0, missing_metrics: ["conversions", "leads"] }), row({ pivot: "urn:li:sponsoredCampaign:2" })];
    m.history = [row({ pivot: "urn:li:sponsoredCampaign:2" })];
    const out = await read();
    expect(out.conversion_tracking).toBe("unverified");
    expect(out.rows[0].pause_signal).toBe("metrics_unread");
    expect(out.rows[1].pause_signal).toBe("tracking_unverified");
  });

  it("no spend is never waste", async () => {
    m.rows = [row({ pivot: "urn:li:sponsoredCampaign:1", conversions: 2 }), row({ pivot: "urn:li:sponsoredCampaign:2", spend: 0 })];
    const out = await read();
    expect(out.rows[1].pause_signal).toBe("no_spend");
  });
});

describe("read_analytics tracking is judged campaign by campaign", () => {
  const LEADS = "urn:li:sponsoredCampaign:1";
  const WEBSITE = "urn:li:sponsoredCampaign:2";

  it("another campaign's leads never make an untracked website campaign a pause candidate", async () => {
    m.rows = [row({ pivot: LEADS, leads: 14 }), row({ pivot: WEBSITE, spend: 900 })];
    m.history = [row({ pivot: LEADS, leads: 80 }), row({ pivot: WEBSITE, spend: 900 })];
    const out = await read();
    expect(out.rows.map((r) => r.pause_signal)).toEqual(["has_results", "tracking_unverified"]);
    expect(out.conversion_tracking).toBe("unverified");
    expect(out.rows[1].pause_note).toMatch(/even if other campaigns in the account have results/);
    expect(out.rows[1].pause_note).toMatch(/do not propose a pause/);
  });

  it("a campaign whose own past results prove its tracking can be a pause candidate", async () => {
    m.rows = [row({ pivot: WEBSITE, spend: 900 })];
    m.history = [row({ pivot: WEBSITE, spend: 5000, conversions: 12 })];
    const out = await read();
    expect(out.rows[0].pause_signal).toBe("pause_candidate");
    expect(out.conversion_tracking).toBe("verified");
  });

  it("a result in a suppressed history metric proves nothing", async () => {
    m.rows = [row({ pivot: WEBSITE, spend: 900 })];
    m.history = [row({ pivot: WEBSITE, conversions: 5, missing_metrics: ["conversions"] })];
    expect((await read()).rows[0].pause_signal).toBe("tracking_history_unread");
  });

  it("a failed history read keeps the campaign unverified and the rest of the read intact", async () => {
    m.rows = [row({ pivot: WEBSITE, spend: 900 })];
    m.historyFail = true;
    const out = await read();
    expect(out.rows[0].pause_signal).toBe("tracking_history_unread");
    expect(out.rows[0].pause_signal).not.toBe("pause_candidate");
    expect(out.rows[0].pause_note).toMatch(/could not be read/i);
    expect(out.conversion_tracking).toBe("unverified");
    expect(out.totals.spend).toBe(900);
  });

  it("a failed history read never decides a campaign with results in the window, or a window with no spend", async () => {
    m.rows = [row({ pivot: LEADS, spend: 900, leads: 3 }), row({ pivot: WEBSITE, spend: 900 })];
    m.historyFail = true;
    const out = await read();
    const by = (urn: string) => out.rows.find((r) => r.pivot === urn)!;
    expect(by(LEADS).pause_signal).not.toBe("tracking_history_unread");
    expect(by(WEBSITE).pause_signal).toBe("tracking_history_unread");
  });

  it("must catch: an empty year of history is not proof the campaign never had a result", async () => {
    m.rows = [row({ pivot: WEBSITE, spend: 900 })];
    m.history = [];
    const out = await read();
    expect(out.rows[0].pause_signal).toBe("tracking_history_unread");
    expect(out.rows[0].pause_note).not.toMatch(/never shown/);
    expect(out.conversion_tracking).toBe("unverified");
  });

  it("must catch: history that only has another campaign says nothing about this one", async () => {
    m.rows = [row({ pivot: WEBSITE, spend: 900 })];
    m.history = [row({ pivot: LEADS, leads: 40 })];
    expect((await read()).rows[0].pause_signal).toBe("tracking_history_unread");
  });

  it("a full year of measured history with no result does say tracking is unverified", async () => {
    m.rows = [row({ pivot: WEBSITE, spend: 900 })];
    m.history = [row({ pivot: WEBSITE, spend: 900 })];
    const out = await read();
    expect(out.rows[0].pause_signal).toBe("tracking_unverified");
    expect(out.rows[0].pause_note).toMatch(/never shown/);
  });

  it("no spend without results means no extra LinkedIn read", async () => {
    m.rows = [row({ pivot: LEADS, leads: 3 }), row({ pivot: WEBSITE, spend: 0 })];
    await read();
    expect(m.windows).toHaveLength(1);
  });
});

describe("read_analytics never turns an unread number into a fact", () => {
  type Loose = { count: number; conversion_tracking: string; no_data_note?: string; unread_metrics?: string[]; unread_totals_note?: string; totals: Record<string, number | string | null>; rows: Array<Record<string, unknown>> };
  const loose = async () => (await linkedinAdsReadAnalyticsTool.execute(ctx, { account_id: "5001" })) as Loose;
  const A = "urn:li:sponsoredCampaign:1";
  const B = "urn:li:sponsoredCampaign:2";

  it("must catch: an empty answer has no zeros in it, keeps the account currency and says why", async () => {
    m.rows = [];
    const out = await loose();
    expect(out.totals).toEqual({ impressions: null, clicks: null, spend: null, currency: "INR", conversions: null, leads: null });
    expect(out.no_data_note).toMatch(/not a measured zero/);
    expect(out.conversion_tracking).toBe("unverified");
    expect(out.count).toBe(0);
  });

  it("a real zero is a measured zero: totals are 0, no note, and the signal is no_spend", async () => {
    m.rows = [row({ pivot: A, spend: 0, clicks: 0, impressions: 0 })];
    const out = await loose();
    expect(out.totals).toEqual({ impressions: 0, clicks: 0, spend: 0, currency: "INR", conversions: 0, leads: 0 });
    expect(out.no_data_note).toBeUndefined();
    expect(out.unread_metrics).toBeUndefined();
    expect(out.rows[0].pause_signal).toBe("no_spend");
    expect(out.rows[0].spend).toBe(0);
  });

  it("must catch: a campaign whose spend was left out is unread, shown as null, and never called no spend", async () => {
    m.rows = [row({ pivot: A, spend: 0, missing_metrics: ["spend"] })];
    const out = await loose();
    expect(out.rows[0].pause_signal).toBe("metrics_unread");
    expect(out.rows[0].spend).toBeNull();
    expect(out.totals.spend).toBeNull();
    expect(out.totals.currency).toBe("INR");
    expect(out.unread_metrics).toEqual(["spend"]);
  });

  it("must catch: a missing metric on a row is null in the row, and the total keeps only what was reported and says it is partial", async () => {
    m.rows = [row({ pivot: A, clicks: 0, conversions: 0, spend: 100, missing_metrics: ["clicks", "conversions"] }), row({ pivot: B, clicks: 60, conversions: 4, spend: 50 })];
    const out = await loose();
    expect(out.rows[0]).toMatchObject({ clicks: null, conversions: null, spend: 100, pause_signal: "metrics_unread" });
    expect(out.rows[1]).toMatchObject({ clicks: 60, conversions: 4 });
    expect(out.totals).toMatchObject({ clicks: 60, conversions: 4, spend: 150 });
    expect(out.unread_metrics).toEqual(["clicks", "conversions"]);
    expect(out.unread_totals_note).toMatch(/partial/);
  });

  it("must catch: every row hiding a metric makes its total null, never 0", async () => {
    m.rows = [row({ pivot: A, conversions: 0, missing_metrics: ["conversions"] }), row({ pivot: B, conversions: 0, missing_metrics: ["conversions"] })];
    const out = await loose();
    expect(out.totals.conversions).toBeNull();
    expect(out.rows.map((r) => r.pause_signal)).toEqual(["metrics_unread", "metrics_unread"]);
  });

  it("a result that was counted still wins over a different metric being left out", async () => {
    m.rows = [row({ pivot: A, conversions: 3, missing_metrics: ["leads"] })];
    expect((await loose()).rows[0].pause_signal).toBe("has_results");
  });

  it("must catch: a row hiding spend or results never becomes a pause candidate even with proven history", async () => {
    m.rows = [row({ pivot: A, spend: 900, missing_metrics: ["leads"] })];
    m.history = [row({ pivot: A, conversions: 12 })];
    const out = await loose();
    expect(out.rows[0].pause_signal).toBe("metrics_unread");
    expect(out.conversion_tracking).toBe("unverified");
  });
});
