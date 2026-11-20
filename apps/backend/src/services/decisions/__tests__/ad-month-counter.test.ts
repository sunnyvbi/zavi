import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { countMonth, fitDailyChange, overlayChanges, pendingDailyUsd, readMonthCount, readRaiseFit, roundUpToHundred, staleAccounts, type CounterHold } from "../ad-month-counter";
import type { AdBudgetMonthView } from "../ad-budget";
import type { MonthProjection } from "../ad-budget-brake";

const m = vi.hoisted(() => ({
  calls: [] as string[],
  view: null as unknown,
  tables: {} as Record<string, unknown[]>,
  errors: {} as Record<string, { message: string } | null>,
  budgetRow: null as unknown,
  token: { data: "tok-1", error: null } as { data: unknown; error: { message: string } | null },
  ledger: [] as Array<Record<string, unknown>>,
}));
vi.mock("../ad-budget", async (orig) => ({
  ...(await orig<typeof import("../ad-budget")>()),
  readAdBudgetMonthView: vi.fn(async () => { m.calls.push("view"); return m.view; }),
}));
vi.mock("../ad-budget-brake", async (orig) => {
  const real = await orig<typeof import("../ad-budget-brake")>();
  return {
    ...real,
    readLiveMonthProjection: vi.fn(async (_t: string, _now: Date, overlay?: (rows: never[]) => unknown[]) => {
      m.calls.push("projection");
      const v = m.view as AdBudgetMonthView | null;
      if (!v) return null;
      const rows = overlay ? overlay(m.ledger as never[]) : m.ledger;
      return { budget_id: v.id, projection: real.projectMonth(v, rows as never) };
    }),
  };
});
vi.mock("@/services/tenant-client", () => {
  const builder = (table: string) => {
    const res = () => ({ data: m.tables[table] ?? [], error: m.errors[table] ?? null });
    const b: Record<string, unknown> = {};
    for (const k of ["select", "eq", "gte", "in", "limit", "or"]) b[k] = () => b;
    b.maybeSingle = async () => { m.calls.push(table); return { data: m.budgetRow, error: m.errors[table] ?? null }; };
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => { m.calls.push(table); return Promise.resolve(res()).then(ok, bad); };
    return b;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: builder }),
    tenantRpc: vi.fn(async (_t: string, name: string) => { m.calls.push(name); return m.token; }),
  };
});

const view = (o: Partial<AdBudgetMonthView> = {}): AdBudgetMonthView => ({
  id: "b-1", status: "active", monthly_usd: 27000, month_cap_usd: 27000, spent_usd: 18000, held_usd: 4000,
  creator_held_usd: 0, creator_spent_usd: 0, left_usd: 5000, daily_limit_usd: null, next_month_start: "2026-11-01",
  days_left: 8, days_in_month: 31, margin: 1.1, started_on: "2026-08-01", created_at: "2026-08-01T00:00:00Z",
  stopped_at: null, month_start: "2026-10-01", ...o,
});
const proj = (running: number, o: Partial<MonthProjection> = {}): MonthProjection => ({
  spent_usd: 18000, creator_usd: 0, month_cap_usd: 27000, days_left: 8, running_daily_usd: running,
  projected_usd: 18000 + running * 8, over: 18000 + running * 8 > 27000, daily: [], cannot_lower: [], ...o,
});
const h = (o: Partial<CounterHold>): CounterHold => ({ platform: "google", object_id: "c1", daily_delta_usd: 50, status: "committed", created_at: "2026-10-23T10:00:00Z", paused: false, ...o });

describe("overlayChanges", () => {
  it("must-catch (net-fits move): an applied cut frees room before the next hourly read", () => {
    const rows = [{ platform: "google", object_id: "c2", name: "B", budget_kind: "daily", budget_usd: 40, status: "ENABLED", as_of: "2026-10-23T09:00:00Z" }];
    const out = overlayChanges(rows, [{ platform: "google", object_id: "c2", change_kind: "budget", after_daily_usd: 10, after_status: null, occurred_at: "2026-10-23T09:30:00Z" }]);
    expect(out[0].budget_usd).toBe(10);
  });
  it("a change older than the read is ignored; a pause sets the status", () => {
    const rows = [{ platform: "meta", object_id: "a1", name: "A", budget_kind: "daily", budget_usd: 40, status: "ACTIVE", as_of: "2026-10-23T09:00:00Z" }];
    expect(overlayChanges(rows, [{ platform: "meta", object_id: "a1", change_kind: "budget", after_daily_usd: 5, after_status: null, occurred_at: "2026-10-23T08:00:00Z" }])[0].budget_usd).toBe(40);
    expect(overlayChanges(rows, [{ platform: "meta", object_id: "a1", change_kind: "status", after_daily_usd: null, after_status: "PAUSED", occurred_at: "2026-10-23T09:10:00Z" }])[0].status).toBe("PAUSED");
  });
});

describe("pendingDailyUsd", () => {
  it("counts reserved holds, and committed ones newer than every read or change of their object", () => {
    const seen = new Map([["google:c1", Date.parse("2026-10-23T09:00:00Z")], ["google:c2", Date.parse("2026-10-23T11:00:00Z")]]);
    expect(pendingDailyUsd([h({ status: "reserved", object_id: "c9" }), h({}), h({ object_id: "c2" }), h({ paused: true })], seen)).toBe(100);
  });
});

describe("staleAccounts", () => {
  it("must-catch: an account that can spend, read this month but not in 26 h, is stale, never $0", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const accts = [
      { platform: "google", account_id: "g1", as_of: "2026-10-21T08:00:00Z", status: "ENABLED" },
      { platform: "meta", account_id: "m1", as_of: "2026-10-23T11:00:00Z", status: "ACTIVE" },
      { platform: "meta", account_id: "old", as_of: "2026-09-20T00:00:00Z", status: "ACTIVE" },
    ];
    expect(staleAccounts(accts, "2026-10-01", now)).toEqual([{ platform: "google", account_id: "g1", as_of: "2026-10-21T08:00:00Z" }]);
  });
  it("must-catch: a meta account with an ACTIVE row last read 30 h ago this month is stale", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const accts = [
      { platform: "meta", account_id: "m1", as_of: "2026-10-22T06:00:00Z", status: "ACTIVE" },
      { platform: "meta", account_id: "m1", as_of: "2026-10-22T06:00:00Z", status: "PAUSED" },
    ];
    expect(staleAccounts(accts, "2026-10-01", now)).toEqual([{ platform: "meta", account_id: "m1", as_of: "2026-10-22T06:00:00Z" }]);
  });
  it("must-not-touch (upcar-ai 2026-10-23): a LinkedIn account of only DRAFT campaigns adds $0 and is not stale", () => {
    const now = new Date("2026-10-23T22:00:00Z");
    const accts = [
      { platform: "linkedin", account_id: "559880687", as_of: "2026-10-15T06:07:29Z", status: "DRAFT" },
      { platform: "linkedin", account_id: "559880687", as_of: "2026-10-15T06:07:29Z", status: "DRAFT" },
      { platform: "meta", account_id: "m1", as_of: "2026-10-23T21:05:00Z", status: "ACTIVE" },
      { platform: "google", account_id: "g1", as_of: "2026-10-23T21:05:00Z", status: "ENABLED" },
    ];
    expect(staleAccounts(accts, "2026-10-01", now)).toEqual([]);
  });
  it("the newest read wins: all PAUSED now, though an older read this month was ACTIVE, is not stale", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const accts = [
      { platform: "meta", account_id: "m1", as_of: "2026-10-10T06:00:00Z", status: "ACTIVE" },
      { platform: "meta", account_id: "m1", as_of: "2026-10-20T06:00:00Z", status: "PAUSED" },
    ];
    expect(staleAccounts(accts, "2026-10-01", now)).toEqual([]);
  });
});

describe("fitDailyChange", () => {
  it("a $30/day raise that fits", () => {
    const v = view();
    expect(fitDailyChange(countMonth("b-1", v, proj(1000), 0), v, 0, 30).kind).toBe("fits");
  });
  it("must-catch: over budget shows the full-budget projection and raise_to rounded up to $100", () => {
    const v = view();
    const f = fitDailyChange(countMonth("b-1", v, proj(1100), 0), v, 0, 30);
    expect(f).toMatchObject({ kind: "over", with_usd: 27040, over_by_usd: 40, raise_to_usd: 27100, daily_limit_to_usd: null });
  });
  it("pending holds count", () => {
    const v = view();
    expect(fitDailyChange(countMonth("b-1", v, proj(1000), 120), v, 0, 30).kind).toBe("over");
  });
  it("first month: raise_to's PRORATED cap covers the need", () => {
    const v = view({ monthly_usd: 31000, month_cap_usd: 22000, started_on: "2026-10-10", spent_usd: 14000, margin: 1 });
    const f = fitDailyChange(countMonth("b-1", v, proj(1000, { spent_usd: 14000, month_cap_usd: 22000, projected_usd: 22000 }), 0), v, 0, 60);
    if (f.kind !== "over" || f.raise_to_usd === null) throw new Error("expected a monthly raise");
    expect(Math.floor(f.raise_to_usd * (22 / 31) * 100) / 100).toBeGreaterThanOrEqual(22480);
  });
  it("a net cut always fits", () => {
    const v = view();
    expect(fitDailyChange(countMonth("b-1", v, proj(2000), 0), v, 0, -40).kind).toBe("fits");
  });
  it("must-catch Q3/B: over the daily limit gives daily_limit_to; both limits on one card", () => {
    const v = view({ daily_limit_usd: 1000 });
    expect(fitDailyChange(countMonth("b-1", v, proj(500), 0), v, 990.5, 30)).toMatchObject({ kind: "over", raise_to_usd: null, daily_limit_to_usd: 1021 });
    expect(fitDailyChange(countMonth("b-1", v, proj(1100), 0), v, 990, 30)).toMatchObject({ kind: "over", raise_to_usd: 27100, daily_limit_to_usd: 1020 });
  });
  it("must-catch F1 (Codex): the full-budget projection fits but reserve_ad_spend's sum with margin does not: over, raise_to covers the sum", () => {
    const v = view({ monthly_usd: 1000, month_cap_usd: 1000, spent_usd: 900, held_usd: 55, days_left: 10, margin: 1.1 });
    const f = fitDailyChange(countMonth("b-1", v, proj(5, { spent_usd: 900, month_cap_usd: 1000, days_left: 10, projected_usd: 950, over: false }), 0), v, 5, 5);
    expect(f).toMatchObject({ kind: "over", with_usd: 1000, gate_usd: 1010, set_aside_over: true, raise_to_usd: 1100, daily_limit_to_usd: null });
  });
  it("roundUpToHundred", () => expect([roundUpToHundred(27040), roundUpToHundred(27100), roundUpToHundred(27100.01)]).toEqual([27100, 27100, 27200]));
});

describe("readMonthCount / readRaiseFit", () => {
  const NOW = new Date("2026-10-23T12:00:00Z");
  const fresh = "2026-10-23T11:00:00Z";
  const googleRaise = (to: number, from: number) => ["google_ads.update_campaign_budget_review", { campaign_id: "c1", daily_budget_usd: to, expected_current_daily_budget_usd: from, rationale: "", over_cap: false }] as const;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    m.calls = [];
    m.view = view();
    m.budgetRow = { read_failed: {}, actual_read_at: fresh };
    m.errors = {};
    m.token = { data: "tok-1", error: null };
    m.ledger = [{ platform: "google", account_id: "g1", object_id: "c1", name: "A", budget_kind: "daily", budget_usd: 1100, status: "ENABLED", as_of: fresh }];
    m.tables = { ad_campaigns: [{ platform: "google", account_id: "g1", as_of: fresh, status: "ENABLED" }], ad_object_changes: [], ad_budget_reservations: [] };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a Google raise over budget is over, with raise_to and the token", async () => {
    const [cls, body] = googleRaise(130, 100);
    expect(await readRaiseFit("t-1", cls, body)).toMatchObject({ kind: "over", with_usd: 27040, raise_to_usd: 27100, token: "tok-1", raise: { platform: "google", object_id: "c1", delta_daily_usd: 30 } });
  });

  it("an applied cut after the read is laid over it, and a reserved hold counts", async () => {
    m.tables.ad_object_changes = [{ platform: "google", object_id: "c1", change_kind: "budget", after_daily_usd: 1000, after_status: null, occurred_at: "2026-10-23T11:30:00Z" }];
    m.tables.ad_budget_reservations = [{ platform: "google", object_id: "c9", daily_delta_usd: "20", status: "reserved", created_at: "2026-10-23T11:40:00Z", paused: null }];
    const r = await readMonthCount("t-1", NOW);
    if (!r || "unreadable" in r) throw new Error("expected a count");
    expect(r.count).toMatchObject({ running_daily_usd: 1000, pending_daily_usd: 20, projection_usd: 18000 + 1020 * 8 });
    expect(r.live_held_daily_usd).toBe(20);
  });

  it("a cut is not_a_raise; no budget is no_budget", async () => {
    const [cls, body] = googleRaise(80, 100);
    expect(await readRaiseFit("t-1", cls, body)).toEqual({ kind: "not_a_raise" });
    m.view = null;
    const [c2, b2] = googleRaise(130, 100);
    expect(await readRaiseFit("t-1", c2, b2)).toEqual({ kind: "no_budget" });
  });

  it("must-catch: a read error is unreadable, never a number", async () => {
    m.errors.ad_budget_reservations = { message: "db down" };
    const [cls, body] = googleRaise(130, 100);
    expect(await readRaiseFit("t-1", cls, body)).toEqual({ kind: "unreadable", why: "read" });
  });

  it("must-catch: a platform the last hourly read failed on makes the month unreadable", async () => {
    m.budgetRow = { read_failed: { google: { at: "2026-10-23T11:00:00Z" } }, actual_read_at: fresh };
    const [cls, body] = googleRaise(130, 100);
    const f = await readRaiseFit("t-1", cls, body);
    expect(f.kind).toBe("unreadable");
    expect((f as { why: string }).why).toMatch(/google/);
  });

  it("must-catch: an account read this month but not in 26 h is unreadable, never $0", async () => {
    m.tables.ad_campaigns = [{ platform: "google", account_id: "g1", as_of: fresh, status: "ENABLED" }, { platform: "meta", account_id: "m1", as_of: "2026-10-21T08:00:00Z", status: "ACTIVE" }];
    const [cls, body] = googleRaise(130, 100);
    const f = await readRaiseFit("t-1", cls, body);
    expect(f).toEqual({ kind: "unreadable", why: "meta was last read 2026-10-21" });
  });

  it("must-catch: a budget whose ad accounts were never read is unreadable, never a readable zero", async () => {
    m.budgetRow = { read_failed: {}, actual_read_at: null };
    m.tables.ad_campaigns = [];
    m.ledger = [];
    const [cls, body] = googleRaise(130, 100);
    expect(await readRaiseFit("t-1", cls, body)).toEqual({ kind: "unreadable", why: "your ad accounts have not been read yet" });
  });

  it("a read budget with no ads at all this month stays readable at spent + holds", async () => {
    m.tables.ad_campaigns = [];
    m.ledger = [];
    m.tables.ad_budget_reservations = [{ platform: "google", object_id: "c9", daily_delta_usd: 20, status: "reserved", created_at: "2026-10-23T11:40:00Z", paused: false, idem_key: "d9:raise" }];
    const r = await readMonthCount("t-1", NOW);
    if (!r || "unreadable" in r) throw new Error("expected a count");
    expect(r.count).toMatchObject({ running_daily_usd: 0, pending_daily_usd: 20, projection_usd: 18000 + 20 * 8 });
  });

  it("must-not-touch: a drafts-only account last read days ago leaves the month readable", async () => {
    m.tables.ad_campaigns = [{ platform: "google", account_id: "g1", as_of: fresh, status: "ENABLED" }, { platform: "linkedin", account_id: "559880687", as_of: "2026-10-15T06:07:29Z", status: "DRAFT" }];
    const [cls, body] = googleRaise(130, 100);
    expect(await readRaiseFit("t-1", cls, body)).toMatchObject({ kind: "over", raise_to_usd: 27100 });
  });

  it("must-catch (codex F1): the hold being judged is left out, so its change is counted once by the caller", async () => {
    m.tables.ad_budget_reservations = [
      { platform: "google", object_id: "c1", daily_delta_usd: 30, status: "reserved", created_at: "2026-10-23T11:50:00Z", paused: false, idem_key: "dec-1:raise" },
      { platform: "google", object_id: "c9", daily_delta_usd: 20, status: "reserved", created_at: "2026-10-23T11:40:00Z", paused: false, idem_key: "dec-9:raise" },
    ];
    const all = await readMonthCount("t-1", NOW);
    const mine = await readMonthCount("t-1", NOW, { excludeIdemKey: "dec-1:raise" });
    if (!all || "unreadable" in all || !mine || "unreadable" in mine) throw new Error("expected counts");
    expect(all.count.pending_daily_usd).toBe(50);
    expect(mine.count.pending_daily_usd).toBe(20);
    expect(mine.live_held_daily_usd).toBe(20);
  });

  it("reads the token BEFORE the month view", async () => {
    await readMonthCount("t-1", NOW);
    expect(m.calls.indexOf("ad_month_token")).toBeGreaterThanOrEqual(0);
    expect(m.calls.indexOf("ad_month_token")).toBeLessThan(m.calls.indexOf("view"));
  });

  it("must-catch: a missing token function throws (no \"none\" token since 20261114100000), as does any other token error", async () => {
    m.token = { data: null, error: { message: "Could not find the function public.ad_month_token(p_tenant_id) in the schema cache" } };
    await expect(readMonthCount("t-1", NOW)).rejects.toThrow(/token/);
    m.token = { data: null, error: { message: "permission denied" } };
    await expect(readMonthCount("t-1", NOW)).rejects.toThrow(/token/);
  });
});
