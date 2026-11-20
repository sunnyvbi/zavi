import { describe, expect, it } from "vitest";
import { buildMoneyTable, spendReadSince, type SpendRow } from "../ad-money-table";

const budget = { status: "active" as const, month_cap_usd: 28400, monthly_usd: 28400, spent_usd: 28388.12, month_start: "2026-10-01" };

function day(platform: string, spend_date: string, amount_usd: number, object_id = "o1", account_id = "a1"): SpendRow {
  return { platform, spend_date, amount_usd, object_id, account_id };
}

describe("buildMoneyTable", () => {
  it("sums the month, the last 7 full days and the 7 before, per channel", () => {
    const spend: SpendRow[] = [
      day("meta", "2026-09-30", 50),
      day("meta", "2026-10-17", 100),
      day("meta", "2026-10-23", 100),
      day("meta", "2026-10-24", 150),
      day("meta", "2026-10-30", 150),
      day("meta", "2026-10-31", 40),
      day("reddit", "2026-10-20", 25),
      day("linkedin", "2026-10-01", 0),
    ];
    const t = buildMoneyTable({ spend, snapshot: null, budget, today: "2026-10-31" });
    expect(t.month_start).toBe("2026-10-01");
    const meta = t.rows.find((r) => r.platform === "meta")!;
    expect(meta).toMatchObject({ name: "Meta Ads", spent_usd: 540, last7_usd: 300, prev7_usd: 200, change: 0.5 });
    const reddit = t.rows.find((r) => r.platform === "reddit")!;
    expect(reddit).toMatchObject({ spent_usd: 25, last7_usd: 0, prev7_usd: 25, change: -1, results: null, results_status: "not_synced" });
    const linkedin = t.rows.find((r) => r.platform === "linkedin")!;
    expect(linkedin).toMatchObject({ name: "LinkedIn Ads", spent_usd: 0, share: 0, change: null, results_status: "not_synced" });
    expect(t.rows.map((r) => r.platform)).toEqual(["meta", "reddit", "linkedin"]);
    expect(t.total).toEqual({ spent_usd: 565, last7_usd: 300, prev7_usd: 225, change: 0.333 });
    expect(meta.share! + reddit.share!).toBeCloseTo(1, 2);
    expect(t.spend_through).toBe("2026-10-31");
    expect(t.budget).toEqual({ status: "active", month_cap_usd: 28400, monthly_usd: 28400, spent_usd: 28388.12 });
  });

  it("counts one amount per object per day (the largest source), never both", () => {
    const spend: SpendRow[] = [day("meta", "2026-10-05", 100), day("meta", "2026-10-05", 120), day("meta", "2026-10-05", 30, "o2")];
    const t = buildMoneyTable({ spend, snapshot: null, budget, today: "2026-10-31" });
    expect(t.rows[0].spent_usd).toBe(150);
  });

  it("shows Meta and Google results from the snapshot's points, labeled as the platform's own count", () => {
    const snapshot = {
      fetched_at: "2026-10-30T06:15:05.630Z",
      series: {
        meta: { points: [
          { date: "2026-09-29", bookings: 100, spend_usd: 12000 },
          { date: "2026-10-28", bookings: 69, spend_usd: 8460.55 },
        ] },
        google: { points: [{ date: "2026-10-28", bookings: 115.96, spend_usd: 4620.46 }] },
      },
    };
    const spend = [day("meta", "2026-10-05", 10), day("google", "2026-10-05", 5), day("tiktok", "2026-10-05", 1)];
    const t = buildMoneyTable({ spend, snapshot, budget, today: "2026-10-31" });
    const meta = t.rows.find((r) => r.platform === "meta")!;
    expect(meta.results_status).toBe("platform");
    expect(meta.results).toEqual({ count: 169, label: "purchases", cost_each_usd: 121.07, source: "Meta's own count", from: "2026-09-29", to: "2026-10-28", settling: false });
    const google = t.rows.find((r) => r.platform === "google")!;
    expect(google.results).toMatchObject({ count: 115.96, label: "conversions", cost_each_usd: 39.85, source: "Google's own count" });
    expect(t.rows.find((r) => r.platform === "tiktok")!.results_status).toBe("not_synced");
    expect(t.results_read_at).toBe("2026-10-30T06:15:05.630Z");
  });

  it("keeps provisional days out of the 7-day windows but in the month", () => {
    const spend = [
      { ...day("meta", "2026-10-31", 500), provisional: true },
      day("meta", "2026-10-30", 100),
      day("meta", "2026-11-01", 999),
    ];
    const t = buildMoneyTable({ spend, snapshot: null, budget: { ...budget, month_start: "2026-10-01" }, today: "2026-10-31" });
    expect(t.rows[0]).toMatchObject({ spent_usd: 600, last7_usd: 100 });
    expect(t.spend_through).toBe("2026-10-31");
  });

  it("a truncated platform read shows no results rather than an undercount", () => {
    const snapshot = { fetched_at: "2026-10-30T00:00:00.000Z", series: { meta: { meta_truncated: true, points: [{ date: "2026-10-01", bookings: 3, spend_usd: 50 }] } } };
    const t = buildMoneyTable({ spend: [day("meta", "2026-10-05", 5)], snapshot, budget, today: "2026-10-31" });
    expect(t.rows[0]).toMatchObject({ results: null, results_status: "unavailable" });
  });

  it("cuts each account's 7 days on its own clock and keeps an account ahead of UTC in the month", () => {
    const spend = [
      { ...day("meta", "2026-10-31", 50, "us", "us-acct"), provisional: true },
      day("meta", "2026-10-30", 100, "us", "us-acct"),
      day("meta", "2026-10-23", 10, "us", "us-acct"),
      { ...day("google", "2026-11-01", 7, "jp", "jp-acct"), provisional: true },
      day("google", "2026-10-31", 30, "jp", "jp-acct"),
      day("google", "2026-10-24", 5, "jp", "jp-acct"),
    ];
    const t = buildMoneyTable({ spend, snapshot: null, budget, today: "2026-10-31" });
    expect(t.rows.find((r) => r.platform === "meta")).toMatchObject({ spent_usd: 160, last7_usd: 100, prev7_usd: 10 });
    expect(t.rows.find((r) => r.platform === "google")).toMatchObject({ spent_usd: 35, last7_usd: 30, prev7_usd: 5 });
    expect(t.spend_through).toBe("2026-10-31");
  });

  it("drops results whose newest day is over a week old", () => {
    const snapshot = { fetched_at: "2026-10-01T00:00:00.000Z", series: { meta: { points: [{ date: "2026-10-20", bookings: 9, spend_usd: 90 }] } } };
    const t = buildMoneyTable({ spend: [day("meta", "2026-10-05", 5)], snapshot, budget, today: "2026-10-31" });
    expect(t.rows[0]).toMatchObject({ results: null, results_status: "unavailable" });
    expect(t.results_read_at).toBeNull();
  });

  it("ends the 7 days before the FIRST of several provisional days, so they never read as $0", () => {
    const spend = [
      { ...day("microsoft", "2026-10-29", 10), provisional: true },
      { ...day("microsoft", "2026-10-30", 10), provisional: true },
      { ...day("microsoft", "2026-10-31", 10), provisional: true },
      ...["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"].map((d) => day("microsoft", d, 10)),
      ...["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"].map((d) => day("microsoft", d, 10)),
    ];
    const t = buildMoneyTable({ spend, snapshot: null, budget, today: "2026-10-31" });
    expect(t.rows[0]).toMatchObject({ last7_usd: 70, prev7_usd: 70, change: 0 });
  });

  it("marks results whose newest days are still settling", () => {
    const snapshot = { fetched_at: "2026-10-30T00:00:00.000Z", series: { google: { points: [{ date: "2026-10-27", bookings: 2, spend_usd: 20 }, { date: "2026-10-28", bookings: 1, spend_usd: 10, maturing: true }] } } };
    const t = buildMoneyTable({ spend: [day("google", "2026-10-05", 5)], snapshot, budget, today: "2026-10-31" });
    expect(t.rows[0].results).toMatchObject({ count: 3, cost_each_usd: 10, settling: true });
  });

  it("an error read shows 'read_failed'; a healthy read reused from an older snapshot still shows", () => {
    const series = { meta: { points: [{ date: "2026-10-28", bookings: 5, spend_usd: 50 }] }, google: { points: [{ date: "2026-10-28", bookings: 5, spend_usd: 50 }] } };
    const fetched_at = "2026-10-30T12:00:00.000Z";
    const t = buildMoneyTable({
      spend: [day("meta", "2026-10-05", 5), day("google", "2026-10-05", 5)],
      snapshot: { fetched_at, series, reads: { meta: { read_at: fetched_at, error: { code: "rate_limited" } }, google: { read_at: "2026-10-29T06:00:00.000Z", error: null } } },
      budget,
      today: "2026-10-31",
    });
    expect(t.rows.find((r) => r.platform === "meta")).toMatchObject({ results: null, results_status: "read_failed" });
    expect(t.rows.find((r) => r.platform === "google")).toMatchObject({ results_status: "platform", results: { count: 5 } });
  });

  it("a platform whose last spend read failed gives no 7-day change (its missing days are not a drop)", () => {
    const spend = [day("google", "2026-10-20", 100), day("meta", "2026-10-20", 100), day("meta", "2026-10-27", 100)];
    const t = buildMoneyTable({ spend, snapshot: null, budget, today: "2026-10-31", spendReadFailed: ["google"] });
    expect(t.rows.find((r) => r.platform === "google")).toMatchObject({ spend_read_failed: true, change: null });
    expect(t.rows.find((r) => r.platform === "meta")).toMatchObject({ spend_read_failed: false, change: 0 });
    expect(t.total.change).toBeNull();
  });

  it("names a platform it has no label for", () => {
    const t = buildMoneyTable({ spend: [day("snapchat", "2026-10-05", 5), day("newnet", "2026-10-05", 1)], snapshot: null, budget, today: "2026-10-31" });
    expect(t.rows.map((r) => r.name)).toEqual(["Snapchat Ads", "Newnet Ads"]);
  });

  it("Meta/Google with no snapshot say unavailable, never a made-up zero", () => {
    const t = buildMoneyTable({ spend: [day("google", "2026-10-05", 5)], snapshot: null, budget: null, today: "2026-10-31" });
    expect(t.rows[0]).toMatchObject({ results: null, results_status: "unavailable" });
    expect(t.results_read_at).toBeNull();
    expect(t.budget).toBeNull();
    expect(t.month_start).toBe("2026-10-01");
  });

  it("a failed snapshot read says so, never 'absent'", () => {
    const t = buildMoneyTable({ spend: [day("meta", "2026-10-05", 5), day("reddit", "2026-10-05", 1)], snapshot: "failed", budget, today: "2026-10-31" });
    expect(t.rows.find((r) => r.platform === "meta")).toMatchObject({ results: null, results_status: "read_failed" });
    expect(t.rows.find((r) => r.platform === "reddit")).toMatchObject({ results_status: "not_synced" });
    expect(t.results_read_at).toBeNull();
  });

  it("zero results gives no cost each", () => {
    const snapshot = { fetched_at: "2026-10-30T00:00:00.000Z", series: { meta: { points: [{ date: "2026-10-28", bookings: 0, spend_usd: 50 }] } } };
    const t = buildMoneyTable({ spend: [day("meta", "2026-10-05", 5)], snapshot, budget, today: "2026-10-31" });
    expect(t.rows[0].results).toMatchObject({ count: 0, cost_each_usd: null });
  });

  it("no spend at all is an empty table", () => {
    const t = buildMoneyTable({ spend: [], snapshot: null, budget: null, today: "2026-11-01" });
    expect(t.rows).toEqual([]);
    expect(t.total).toEqual({ spent_usd: 0, last7_usd: 0, prev7_usd: 0, change: null });
    expect(t.spend_through).toBeNull();
  });

  it("a new month starts at zero while the 7-day windows still reach back", () => {
    const spend = [day("meta", "2026-10-28", 100), day("meta", "2026-10-31", 100)];
    const t = buildMoneyTable({ spend, snapshot: null, budget: { ...budget, month_start: "2026-11-01" }, today: "2026-11-01" });
    expect(t.rows[0]).toMatchObject({ spent_usd: 0, last7_usd: 200, share: null });
  });
});

describe("spendReadSince", () => {
  it("reads back to 14 days or the month start, whichever is earlier", () => {
    expect(spendReadSince("2026-10-01", "2026-10-31")).toBe("2026-10-01");
    expect(spendReadSince("2026-11-01", "2026-11-03")).toBe("2026-10-16");
  });
});
