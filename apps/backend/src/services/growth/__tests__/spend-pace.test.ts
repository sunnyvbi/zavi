import { describe, expect, it, vi, beforeEach } from "vitest";

const cgoAdBudget = vi.fn();
vi.mock("../cgo-ads", () => ({ cgoAdBudget: (...a: unknown[]) => cgoAdBudget(...a) }));
const readAdBudgetMonthView = vi.fn();
const releaseIdleAdHolds = vi.fn();
const shrinkUnderdeliveringAdHolds = vi.fn();
vi.mock("@/services/decisions/ad-budget", () => ({
  readAdBudgetMonthView: (...a: unknown[]) => readAdBudgetMonthView(...a),
  releaseIdleAdHolds: (...a: unknown[]) => releaseIdleAdHolds(...a),
  shrinkUnderdeliveringAdHolds: (...a: unknown[]) => shrinkUnderdeliveringAdHolds(...a),
}));

import { LAUNCH_GRACE_HOURS, dailyBudgetCapacityUsd } from "../delivery-capacity";
import {
  computeSpendPace,
  deliveryDebtHigh,
  forecastDailySpend,
  ledgerAccountTodays,
  loadSpendPace,
  maintainCgoAdHolds,
  type SpendPace,
} from "../spend-pace";

beforeEach(() => {
  vi.clearAllMocks();
});

const base = {
  monthly_usd: 31_000,
  spent_month_usd: 0,
  left_usd: 31_000,
  month_start: "2026-10-01",
  started_on: "2026-09-15",
  now: new Date("2026-10-11T00:00:00Z"),
  actual_read_at: "2026-10-11T00:00:00Z",
};

describe("computeSpendPace", () => {
  it("full even pace from day 1, no ramp: left over the days left, today included", () => {
    const p = computeSpendPace({ ...base, now: new Date("2026-10-01T00:00:00Z"), actual_read_at: null });
    expect(p.days_left).toBe(31);
    expect(p.daily_target_usd).toBe(1000);
    expect(p.required_cumulative_usd).toBe(0);
    expect(p.delivery_debt_usd).toBe(0);
  });

  it("the line is the monthly amount spread evenly: 10 whole days in, $10,000 is required", () => {
    const p = computeSpendPace({ ...base, spent_month_usd: 4_000, left_usd: 27_000 });
    expect(p.required_cumulative_usd).toBe(10_000);
    expect(p.actual_month_usd).toBe(4_000);
    expect(p.delivery_debt_usd).toBe(6_000);
    expect(p.days_left).toBe(21);
    expect(p.daily_target_usd).toBe(1285.71);
  });

  it("ahead of the line is no debt (overspend is fine)", () => {
    const p = computeSpendPace({ ...base, spent_month_usd: 12_000, left_usd: 19_000 });
    expect(p.delivery_debt_usd).toBe(0);
  });

  it("a budget started this month paces from its own first day", () => {
    const p = computeSpendPace({
      ...base,
      started_on: "2026-10-06",
      now: new Date("2026-10-11T00:00:00Z"),
      actual_read_at: "2026-10-11T00:00:00Z",
    });
    expect(p.required_cumulative_usd).toBe(5_000);
  });

  it("measured up to the last spend read, so a lagging read is not debt", () => {
    const p = computeSpendPace({ ...base, now: new Date("2026-10-11T12:00:00Z"), actual_read_at: "2026-10-11T00:00:00Z", spent_month_usd: 10_000 });
    expect(p.required_cumulative_usd).toBe(10_000);
    expect(p.delivery_debt_usd).toBe(0);
    expect(p.data_fresh).toBe(false);
  });

  it("data_fresh: a read within 3 hours", () => {
    expect(computeSpendPace({ ...base, now: new Date("2026-10-11T02:59:00Z") }).data_fresh).toBe(true);
    expect(computeSpendPace({ ...base, now: new Date("2026-10-11T03:01:00Z") }).data_fresh).toBe(false);
    expect(computeSpendPace({ ...base, actual_read_at: null }).data_fresh).toBe(false);
    expect(computeSpendPace({ ...base, actual_read_at: "garbage" }).data_fresh).toBe(false);
    const at = new Date("2026-10-02T11:41:00Z");
    expect(computeSpendPace({ ...base, now: at, actual_read_at: "2026-10-02T11:07:02.749446+00:00" }).data_fresh).toBe(true);
    expect(computeSpendPace({ ...base, now: at, actual_read_at: "2026-10-02T04:07:02.749446-07:00" }).data_fresh).toBe(true);
    expect(computeSpendPace({ ...base, now: at, actual_read_at: "2026-10-02T08:40:00+00:00" }).data_fresh).toBe(false);
  });

  it("the plan's 1 Oct shape: $25K budget, $518 spent on day 2 is behind the line", () => {
    const p = computeSpendPace({
      monthly_usd: 25_000,
      spent_month_usd: 518,
      left_usd: 25_000 - 518,
      month_start: "2026-10-01",
      started_on: "2026-10-01",
      now: new Date("2026-10-02T12:00:00Z"),
      actual_read_at: "2026-10-02T11:00:00Z",
    });
    expect(p.days_left).toBe(30);
    expect(p.daily_target_usd).toBe(816.07);
    expect(p.required_cumulative_usd).toBe(1176.08);
    expect(p.delivery_debt_usd).toBe(658.08);
    expect(deliveryDebtHigh(p)).toBe(true);
  });

  it("never negative, never NaN on unreadable inputs", () => {
    const p = computeSpendPace({ ...base, left_usd: -50, spent_month_usd: Number.NaN, monthly_usd: Number.NaN, month_start: "", started_on: null });
    for (const v of Object.values(p)) if (typeof v === "number") expect(Number.isFinite(v) && v >= 0).toBe(true);
    expect(p.daily_target_usd).toBe(0);
  });

  it("the last day of the month: one day left", () => {
    expect(computeSpendPace({ ...base, now: new Date("2026-10-31T23:00:00Z") }).days_left).toBe(1);
    expect(computeSpendPace({ ...base, now: new Date("2027-02-01T00:00:00Z"), month_start: "2027-02-01" }).days_left).toBe(28);
  });
});

describe("deliveryDebtHigh: more than 15% of a day's target", () => {
  const p = (debt: number, target = 1000): SpendPace => ({
    daily_target_usd: target,
    required_cumulative_usd: 0,
    actual_month_usd: 0,
    delivery_debt_usd: debt,
    days_left: 10,
    data_fresh: true,
  });
  it("is the 15% line", () => {
    expect(deliveryDebtHigh(p(150))).toBe(false);
    expect(deliveryDebtHigh(p(151))).toBe(true);
  });
  it("is false with no pace or no target", () => {
    expect(deliveryDebtHigh(null)).toBe(false);
    expect(deliveryDebtHigh(p(500, 0))).toBe(false);
  });
});

describe("forecastDailySpend: what the ads that are ON will spend", () => {
  const now = new Date("2026-10-10T15:00:00Z");
  const obj = (id: string, status: string, budget: number | null, kind = "daily") => ({
    platform: "meta",
    object_id: id,
    status,
    budget_kind: kind,
    budget_usd: budget,
  });
  const spent = (id: string, amounts: number[], today = 0) => [
    ...amounts.map((a, n) => ({ platform: "meta", object_id: id, spend_date: `2026-10-0${7 + n}`, amount_usd: a })),
    ...(today ? [{ platform: "meta", object_id: id, spend_date: "2026-10-10", amount_usd: today }] : []),
  ];

  it("paused and removed objects count 0", () => {
    const f = forecastDailySpend({
      objects: [obj("p", "PAUSED", 300), obj("r", "REMOVED", 300)],
      spend: [...spent("p", [300, 300, 300]), ...spent("r", [50, 50, 50])],
      holds: [],
      now,
    });
    expect(f.forecast_daily_usd).toBe(0);
  });

  it("a delivering object counts its trailing spend, at most its budget", () => {
    const f = forecastDailySpend({
      objects: [obj("a", "ACTIVE", 100), obj("b", "ENABLED", 50)],
      spend: [...spent("a", [40, 50, 60]), ...spent("b", [80, 80, 80])],
      holds: [],
      now,
    });
    expect(f.forecast_daily_usd).toBe(100);
  });

  it("D6: a hold older than the 24h launch grace no longer counts the whole budget: no spend counts 0, spend counts what it spends", () => {
    const hold = [{ platform: "meta", object_id: "e", created_at: "2026-10-09T09:00:00Z" }];
    expect(forecastDailySpend({ objects: [obj("e", "ACTIVE", 300)], spend: [], holds: hold, now }).forecast_daily_usd).toBe(0);
    expect(forecastDailySpend({ objects: [obj("e", "ACTIVE", 300)], spend: spent("e", [30, 30, 30]), holds: hold, now }).forecast_daily_usd).toBe(30);
  });

  it("D6: the forecast and the spend controller count the same object the same way", () => {
    for (const [created_at, spend, want] of [
      ["2026-10-09T19:00:00Z", [0, 0, 0], 100],
      ["2026-10-09T09:00:00Z", [0, 0, 0], 0],
      ["2026-10-09T09:00:00Z", [40, 40, 40], 40],
    ] as const) {
      const f = forecastDailySpend({ objects: [obj("x", "ACTIVE", 100)], spend: spent("x", [...spend]), holds: [{ platform: "meta", object_id: "x", created_at }], now });
      const hours = (now.getTime() - Date.parse(created_at)) / 3_600_000;
      const c = dailyBudgetCapacityUsd(100, { just_launched: hours < LAUNCH_GRACE_HOURS, spend_observed_usd: ([...spend] as number[]).reduce((a, b) => a + b, 0) });
      expect(f.forecast_daily_usd).toBe(want);
      expect(c).toBe(want);
    }
  });

  it("an ON object that delivered nothing in 3 days counts 0, unless Zavi launched it within the launch grace", () => {
    const empty = forecastDailySpend({ objects: [obj("e", "ACTIVE", 300)], spend: [], holds: [], now });
    expect(empty.forecast_daily_usd).toBe(0);
    const launched = forecastDailySpend({
      objects: [obj("e", "ACTIVE", 300)],
      spend: [],
      holds: [{ platform: "meta", object_id: "e", created_at: "2026-10-09T15:00:00Z" }],
      now,
    });
    expect(launched.forecast_daily_usd).toBe(300);
  });

  it("a campaign-level budget counts its trailing spend; the largest source per day counts once", () => {
    const f = forecastDailySpend({
      objects: [obj("c", "ACTIVE", null, "campaign_level")],
      spend: [...spent("c", [30, 30, 30]), { platform: "meta", object_id: "c", spend_date: "2026-10-09", amount_usd: 60 }],
      holds: [],
      now,
    });
    expect(f.forecast_daily_usd).toBe(40);
  });

  it("each platform's days are its ad account's own: an account behind UTC is still on yesterday", () => {
    const late = new Date("2026-10-11T01:00:00Z");
    const f = forecastDailySpend({ objects: [obj("a", "ACTIVE", 100)], spend: spent("a", [30, 30, 30], 12), holds: [], now: late, today: { meta: "2026-10-10" } });
    expect(f).toEqual({ forecast_daily_usd: 30, actual_today_usd: 12 });
    expect(forecastDailySpend({ objects: [obj("a", "ACTIVE", 100)], spend: spent("a", [30, 30, 30], 12), holds: [], now: late })).toEqual({ forecast_daily_usd: 24, actual_today_usd: 0 });
  });

  it("reports today's actual so far", () => {
    const f = forecastDailySpend({ objects: [obj("a", "ACTIVE", 100)], spend: spent("a", [100, 100, 100], 37.5), holds: [], now });
    expect(f.actual_today_usd).toBe(37.5);
  });
});

describe("only for a tenant the CGO runs ads for", () => {
  it("loadSpendPace is null when Autopilot or the budget is off, and reads nothing else", async () => {
    cgoAdBudget.mockResolvedValue(null);
    expect(await loadSpendPace("t1")).toBeNull();
    expect(readAdBudgetMonthView).not.toHaveBeenCalled();
  });

  it("loadSpendPace reads this month's view: left is the money not spent nor taken by creator hires", async () => {
    cgoAdBudget.mockResolvedValue({ id: "b1" });
    readAdBudgetMonthView.mockResolvedValue({
      status: "active",
      monthly_usd: 31_000,
      month_cap_usd: 31_000,
      spent_usd: 4_000,
      held_usd: 9_000,
      creator_held_usd: 500,
      creator_spent_usd: 500,
      month_start: "2026-10-01",
      started_on: "2026-09-15",
      actual_read_at: "2026-10-11T00:00:00Z",
    });
    const p = await loadSpendPace("t1", new Date("2026-10-11T00:00:00Z"));
    expect(p?.daily_target_usd).toBe(1238.1);
    expect(p?.delivery_debt_usd).toBe(6_000);
  });

  it("loadSpendPace is null when the read fails (changes nothing)", async () => {
    cgoAdBudget.mockResolvedValue({ id: "b1" });
    readAdBudgetMonthView.mockRejectedValue(new Error("db down"));
    expect(await loadSpendPace("t1")).toBeNull();
  });

  it("maintainCgoAdHolds skips a tenant the CGO does not run ads for, writing nothing", async () => {
    cgoAdBudget.mockResolvedValue(null);
    expect(await maintainCgoAdHolds("t1")).toEqual({ status: "skipped" });
    expect(releaseIdleAdHolds).not.toHaveBeenCalled();
    expect(shrinkUnderdeliveringAdHolds).not.toHaveBeenCalled();
  });

  it("maintainCgoAdHolds runs the release, then the shrink, for this tenant only", async () => {
    cgoAdBudget.mockResolvedValue({ id: "b1" });
    releaseIdleAdHolds.mockResolvedValue({ status: "done", released: 1 });
    shrinkUnderdeliveringAdHolds.mockResolvedValue({ status: "stale", shrunk: 0 });
    const r = await maintainCgoAdHolds("t1");
    expect(r).toEqual({ status: "done", released: { status: "done", released: 1 }, shrunk: { status: "stale", shrunk: 0 } });
    expect(releaseIdleAdHolds).toHaveBeenCalledWith("t1");
    expect(shrinkUnderdeliveringAdHolds).toHaveBeenCalledWith("t1");
  });
});

describe("ledgerAccountTodays", () => {
  const at = new Date("2026-10-30T03:00:00Z");
  const read = "2026-10-30T02:30:00.000Z";
  const object = { platform: "meta", account_id: "a", object_id: "o", status: "ACTIVE", budget_kind: "daily", budget_usd: 10, as_of: read };
  const spend = (spend_date: string, provisional = false, recorded_at = read, account_id: string | null = "a") => ({ platform: "meta", account_id, object_id: "o", spend_date, amount_usd: 5, provisional, recorded_at });

  it.each([
    ["the flagged row on UTC's yesterday", [spend("2026-10-28"), spend("2026-10-29", true)], "2026-10-29"],
    ["the flagged row on UTC's today", [spend("2026-10-29"), spend("2026-10-30", true)], "2026-10-30"],
    ["the flagged row on UTC's tomorrow", [spend("2026-10-30"), spend("2026-10-31", true)], "2026-10-31"],
    ["the newest flagged row of several", [spend("2026-10-29", true), spend("2026-10-30", true)], "2026-10-30"],
    ["no flagged row: the day after the newest", [spend("2026-10-28")], "2026-10-29"],
    ["no flagged row, newest yesterday: UTC's today", [spend("2026-10-29")], "2026-10-30"],
    ["a flag left by an older read is ignored", [spend("2026-10-29", true, "2026-10-30T01:30:00.000Z"), spend("2026-10-28")], "2026-10-30"],
  ])("%s", (_label, rows, want) => {
    expect(ledgerAccountTodays([object], rows, at)).toEqual({ "meta:a": want });
  });

  it.each([
    ["a flagged row two days behind UTC", [spend("2026-10-28", true)]],
    ["a newest row too old to date anything", [spend("2026-10-20")]],
    ["a flagged row two days ahead of UTC", [spend("2026-11-01", true)]],
    ["no rows", []],
    ["rows with no account", [spend("2026-10-29", true, read, null)]],
  ])("must not catch: %s says nothing, so the account counts on UTC days", (_label, rows) => {
    expect(ledgerAccountTodays([object], rows, at)).toEqual({});
  });

  it("must catch: every platform and account is read on its own", () => {
    expect(
      ledgerAccountTodays(
        [object, { ...object, platform: "google", account_id: "g" }],
        [spend("2026-10-29", true), { ...spend("2026-10-30", true), platform: "google", account_id: "g" }],
        at,
      ),
    ).toEqual({ "meta:a": "2026-10-29", "google:g": "2026-10-30" });
  });
});
