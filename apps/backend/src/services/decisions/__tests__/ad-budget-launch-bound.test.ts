import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const T = "22222222-2222-4222-8222-222222222222";
const m = vi.hoisted(() => ({
  view: null as unknown,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string } | null>,
  throwOn: new Set<string>(),
  reads: [] as string[],
  claimed: false,
}));

vi.mock("@/services/decisions/ad-budget", async (orig) => ({
  ...(await orig<typeof import("@/services/decisions/ad-budget")>()),
  readAdBudgetMonthView: vi.fn(async () => m.view),
}));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(async () => false) }));
vi.mock("@/services/tenant-client", () => {
  const builder = (table: string) => {
    if (m.throwOn.has(table)) throw new Error(`${table} unavailable`);
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const res = () => {
      m.reads.push(table);
      const err = m.errors[table] ?? null;
      return { data: err ? null : (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: err };
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.limit = () => b;
    b.order = () => b;
    b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
    b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
    b.gte = (c: string, v: string) => (filters.push((r) => typeof r[c] === "string" && (r[c] as string) >= v), b);
    b.or = () => (filters.push((r) => r.status == null || r.status !== "removed"), b);
    b.range = async () => res();
    b.maybeSingle = async () => {
      const r = res();
      return { data: r.data?.[0] ?? null, error: r.error };
    };
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(res).then(ok, bad);
    return b;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: builder }),
    globalClient: () => ({ from: builder }),
    tenantRpc: vi.fn(async (_t: string, name: string) => {
      if (name === "ad_month_token") return { data: "tok-1", error: null };
      if (name === "claim_ad_budget_brake") {
        if (m.claimed) return { data: { claimed: false, day: "2026-11-11" }, error: null };
        m.claimed = true;
        return { data: { claimed: true, day: "2026-11-11" }, error: null };
      }
      if (name === "release_ad_budget_brake") {
        m.claimed = false;
        return { data: { status: "released" }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    }),
  };
});

import { projectMonth, readMonthProjection, readLaunchBounds, runBudgetBrake } from "../ad-budget-brake";
import { fitDailyChange, readCountedProjection, readMonthCount } from "../ad-month-counter";
import { overProjectionGate, type AdBudgetMonthView } from "../ad-budget";

const NOW = new Date("2026-11-11T12:00:00Z");
const READ_AT = "2026-11-11T11:00:00Z";

const view = (o: Partial<AdBudgetMonthView> = {}): AdBudgetMonthView => ({
  id: "b1", status: "active", monthly_usd: 900, month_cap_usd: 900, spent_usd: 590, held_usd: 20,
  creator_held_usd: 0, creator_spent_usd: 0, left_usd: 290, daily_limit_usd: null, next_month_start: "2026-12-01",
  days_left: 20, days_in_month: 30, margin: 1, started_on: "2026-10-01", created_at: "2026-10-01T00:00:00Z",
  stopped_at: null, month_start: "2026-11-01", actual_read_at: READ_AT, ...o,
});
const campaign = (o: Record<string, unknown> = {}) => ({
  tenant_id: T, platform: "linkedin", account_id: "acct-1", object_id: "bind-1", name: "Launch", budget_kind: "daily",
  budget_usd: 20, status: "ACTIVE", as_of: READ_AT, ...o,
});
const hold = (o: Record<string, unknown> = {}) => ({
  tenant_id: T, budget_id: "b1", platform: "linkedin", object_id: "bind-1", status: "committed", cap_usd: 50,
  ends_on: "2026-11-14", spend_baseline_usd: 0, spend_from: "2026-11-08", created_at: "2026-11-08T09:00:00Z",
  daily_delta_usd: 20, paused: false, idem_key: "op-1:resume", ...o,
});
const spend = (object_id: string, spend_date: string, amount_usd: number) => ({ tenant_id: T, platform: "linkedin", object_id, spend_date, amount_usd });

function seed(o: { campaigns?: Array<Record<string, unknown>>; holds?: Array<Record<string, unknown>>; spend?: Array<Record<string, unknown>> } = {}) {
  m.tables = {
    ad_campaigns: o.campaigns ?? [campaign()],
    ad_budget_reservations: o.holds ?? [hold()],
    ad_spend_daily: o.spend ?? [spend("bind-1", "2026-11-08", 10), spend("bind-1", "2026-11-09", 10), spend("bind-1", "2026-11-09", 4), spend("bind-1", "2026-11-10", 10)],
    ad_budgets: [{ tenant_id: T, id: "b1", read_failed: null, actual_read_at: READ_AT }],
    ad_object_changes: [],
    ads_campaign_binding_details: [],
  };
}

const ACCT = [{ platform: "linkedin", account_id: "acct-1" }];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.view = view();
  m.errors = {};
  m.throwOn = new Set();
  m.reads = [];
  m.claimed = false;
  seed();
});
afterEach(() => { vi.useRealTimers(); });

describe("a Zavi-launched LinkedIn campaign's projection is capped by its launch hold", () => {
  it("$20/day, $50 total with $30 spent, ending in 3 days, 20 days left: projects $20 more, not $400", async () => {
    const r = await readMonthProjection(T, ACCT);
    expect(r!.projection.projected_usd).toBe(610);
    expect(r!.projection.over).toBe(false);
    expect(r!.projection.running_daily_usd).toBe(20);
    expect(r!.projection.daily.map((d) => d.object_id)).toEqual(["bind-1"]);
  });

  it("the end date before the month end caps the days when the total has room", async () => {
    seed({ holds: [hold({ cap_usd: 1000 })] });
    const r = await readMonthProjection(T, ACCT);
    expect(r!.projection.projected_usd).toBe(590 + 20 * 3);
  });

  it("an end date already passed adds nothing", async () => {
    seed({ holds: [hold({ ends_on: "2026-11-11", cap_usd: 1000 })] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(590);
  });

  it("a hold with no spend baseline counts only spend since the launch day", async () => {
    seed({ holds: [hold({ spend_baseline_usd: null, cap_usd: 50, ends_on: "2026-11-30" })], spend: [spend("bind-1", "2026-11-02", 500), spend("bind-1", "2026-11-09", 30)] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(610);
  });

  it("the newest hold of a relaunched campaign wins", async () => {
    seed({ holds: [hold({ cap_usd: 5, created_at: "2026-11-01T00:00:00Z" }), hold({ cap_usd: 1000, created_at: "2026-11-09T00:00:00Z" })] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(650);
  });
});

describe("fails safe to the daily budget for every day left", () => {
  const FULL = 590 + 20 * 20;
  it("no hold", async () => {
    seed({ holds: [] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
  it("a hold without a total or end date", async () => {
    seed({ holds: [hold({ cap_usd: null }), hold({ ends_on: null, created_at: "2026-11-09T00:00:00Z" })] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
  it("a released hold", async () => {
    seed({ holds: [hold({ status: "released" })] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
  it("the hold read fails", async () => {
    m.errors.ad_budget_reservations = { message: "db down" };
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
  it("the hold read throws", async () => {
    m.throwOn.add("ad_budget_reservations");
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
  it("the spend read fails", async () => {
    m.errors.ad_spend_daily = { message: "db down" };
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
  it("a spend amount is unreadable", async () => {
    seed({ spend: [spend("bind-1", "2026-11-09", Number.NaN)] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
  it("the month view has no next month start", async () => {
    m.view = view({ next_month_start: "" });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(FULL);
  });
});

describe("an own campaign without a Zavi hold is unchanged", () => {
  it("counts at its daily budget for every day left, next to a capped Zavi one", async () => {
    seed({ campaigns: [campaign(), campaign({ object_id: "5551", name: "Own", budget_usd: 7 })] });
    const r = await readMonthProjection(T, ACCT);
    expect(r!.projection.projected_usd).toBe(590 + 20 + 7 * 20);
  });
  it("a hold on another platform's object of the same id does not cap a LinkedIn one", async () => {
    seed({ holds: [hold({ platform: "meta" })] });
    expect((await readMonthProjection(T, ACCT))!.projection.projected_usd).toBe(990);
  });
  it("no hold read happens when no LinkedIn daily campaign runs", async () => {
    seed({ campaigns: [campaign({ platform: "meta", object_id: "a1" }), campaign({ status: "PAUSED" })] });
    await readMonthProjection(T, [...ACCT, { platform: "meta", account_id: "acct-1" }]);
    expect(m.reads).not.toContain("ad_budget_reservations");
  });
});

describe("the over-budget warning and the Autopilot raise read the capped figure", () => {
  it("the daily brake is on track and sends no warning", async () => {
    const send = vi.fn(async () => undefined);
    const alertFounder = vi.fn(async () => undefined);
    const out = await runBudgetBrake({ id: "b1", tenant_id: T }, ACCT, { send, alertFounder });
    expect(out).toEqual({ status: "on_track", projected_usd: 610, cap_usd: 900 });
    expect(send).not.toHaveBeenCalled();
    expect(alertFounder).not.toHaveBeenCalled();
  });

  it("the counted month (cgo warning, cap warning) is not over", async () => {
    const r = await readCountedProjection(T);
    expect(r!.projection).toEqual({ projected_usd: 610, month_cap_usd: 900, days_left: 20, over: false });
  });

  it("Autopilot's D3 gate reads a month that is not over", async () => {
    const r = await overProjectionGate.read(T, "other:resume");
    expect(r!.projection.over).toBe(false);
    expect(r!.projection.projected_usd).toBe(610);
  });

  it("a $10/day Autopilot raise fits", async () => {
    const mc = await readMonthCount(T, NOW);
    expect(mc && !("unreadable" in mc)).toBe(true);
    const r = mc as Exclude<typeof mc, null | { unreadable: string }>;
    const fit = fitDailyChange(r.count, r.view, r.live_held_daily_usd, 10);
    expect(fit.kind).toBe("fits");
    expect(fit.kind === "fits" && fit.with_usd).toBe(810);
  });

  it("with no hold the same month still warns and blocks the raise", async () => {
    seed({ holds: [] });
    const send = vi.fn(async () => undefined);
    const out = await runBudgetBrake({ id: "b1", tenant_id: T }, ACCT, { send });
    expect(out.status).toBe("warned");
    expect(send).toHaveBeenCalledTimes(1);
    const mc = await readMonthCount(T, NOW);
    const r = mc as Exclude<typeof mc, null | { unreadable: string }>;
    expect(fitDailyChange(r.count, r.view, r.live_held_daily_usd, 10).kind).toBe("over");
  });
});

describe("projectMonth with bounds", () => {
  const v = { spent_usd: 0, month_cap_usd: 100, days_left: 5 };
  const row = { platform: "linkedin", object_id: "x", name: null, budget_kind: "daily", budget_usd: 10, status: "ACTIVE" };
  it("a bound longer than the month never adds more than the full budget", () => {
    expect(projectMonth(v, [row], new Map([["linkedin:x", { left_usd: 1000, days: 40 }]])).projected_usd).toBe(50);
  });
  it("no bounds is the old projection", () => {
    expect(projectMonth(v, [row]).projected_usd).toBe(50);
  });
  it("readLaunchBounds is empty without LinkedIn daily rows", async () => {
    expect((await readLaunchBounds(T, view(), [])).size).toBe(0);
  });
});
