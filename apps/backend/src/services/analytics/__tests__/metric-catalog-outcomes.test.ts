import { describe, expect, it, vi } from "vitest";
import { aggregate, catalogEntry } from "../metric-catalog";
import {
  cacBounds,
  fetchOutcomeMetric,
  isOtherPaidSlug,
  roasBounds,
  type OutcomeDeps,
} from "../metric-catalog/outcomes";
import type { FetchOk, MetricFetchCtx } from "../metric-catalog/types";
import type { ResolvedWindow } from "../metric-time";
import type { OutcomeMap } from "@/services/growth/booking-metrics/outcomes";
import { outcomeFingerprint, type OutcomeRollup } from "@/services/growth/booking-metrics/outcome-rollup";

const TZ = "America/Los_Angeles";
const W: ResolvedWindow = { since: "2026-10-05", until: "2026-10-11", tz: TZ, notes: [] };
const CTX: MetricFetchCtx = {
  tenant_id: "t1",
  tz: TZ,
  now: new Date("2026-10-15T12:00:00Z"),
  grain: "week",
  gateway: { tenant_id: "t1", caller: { kind: "agent", agent_slug: "operator", run_id: null, tool_name: "get_metric" } },
};
const MAP: OutcomeMap = {
  engine: "mongodb",
  booking_source: "orders",
  date_field: "createdAt",
  status_field: "status",
  terminal_statuses: ["completed"],
  completed_at_field: "finishedAt",
  customer_ref_field: "customerId",
  revenue_field: "total",
  refund_field: "refunded",
  refund_basis: "booking_created_net",
  amount_unit: "dollars",
  currency: "USD",
  confirmed_at: "2026-10-01T00:00:00Z",
  outcome_confirmed_at: "2026-10-14T00:00:00Z",
};
const COLUMNS = ["createdAt", "status", "finishedAt", "customerId", "total", "refunded"].map((name) => ({ name, type: "String", nullable: true }));

function spend(days: Array<[string, number]>, zones: Array<string | null> = [TZ, TZ]): FetchOk {
  return {
    ok: true,
    daily: days.map(([date, s]) => ({ date, parts: { spend: s } })),
    currency: "USD",
    row_count: days.length,
    truncated: false,
    caveats: [],
    params: { platforms: zones.map((z, i) => ({ platform: i ? "Google Ads" : "Meta", account_timezone: z })) },
  };
}

function fakeSession(rows = 10, agg: Record<string, unknown>[] = []) {
  const isWatermark = (p: Array<Record<string, { _id?: unknown; f?: unknown }>>) => p[1]?.$group?._id === null && "f" in (p[1]?.$group ?? {});
  return {
    mongo: () => ({
      aggregate: async (_c: string, p: Array<Record<string, { _id?: unknown; f?: unknown }>>) => (isWatermark(p) ? [{ n: rows, f: 0, c: 0 }] : agg),
    }),
  } as never;
}

function deps(over: Partial<OutcomeDeps> = {}): OutcomeDeps {
  return {
    getOutcomeMap: vi.fn(async () => ({ ok: true as const, map: MAP })),
    catalogColumns: vi.fn(async () => COLUMNS),
    spend: vi.fn(async () => spend([["2026-10-06", 300], ["2026-10-08", 300]])),
    connectedSlugs: vi.fn(async () => ["meta_ads", "google_ads", "operator_db"]),
    ledgerSeen: vi.fn(async () => []),
    withSession: vi.fn(async (_c, fn) => fn(fakeSession())),
    readRollup: vi.fn(async () => null),
    requestRefresh: vi.fn(async () => undefined),
    ...over,
  };
}

function rollup(days: OutcomeRollup["days"], map = MAP): OutcomeRollup {
  return { basis: outcomeFingerprint(map, TZ), through_day: "2026-10-14", first_seen_floor: "2025-01-01T00:00:00.000Z", source_watermark: "10|0|0", days, refreshed_at: "2026-10-15T08:00:00Z" };
}
const day = (d: string, first: number, u_cac = 0): OutcomeRollup["days"][number] => ({ d, first, u_cac, u_roas: 0, pos: 0, neg: 0, unr: 0 });

describe("finished-outcome metrics: refusals", () => {
  it("a per-channel ask (any breakdown) is unsupported_definition", async () => {
    const r = await fetchOutcomeMetric({ ...CTX, breakdown: "platform" }, W, "cac", deps());
    expect(r).toMatchObject({ ok: false, reason: "unsupported_definition" });
    expect((r as { message: string }).message).toMatch(/attribution mapping/);
  });

  it("an unmapped field is unsupported_definition and names what is missing", async () => {
    const d = deps({
      getOutcomeMap: vi.fn(async () => ({ ok: false as const, missing: ["customer_ref_field"], message: "Not confirmed yet: which field says who the customer is." })),
    });
    const r = await fetchOutcomeMetric(CTX, W, "cac", d);
    expect(r).toMatchObject({ ok: false, reason: "unsupported_definition" });
    expect((r as { message: string }).message).toMatch(/who the customer is/);
    expect(d.spend).not.toHaveBeenCalled();
  });

  it("a confirmed field that left the current catalog is unsupported_definition (re-confirm)", async () => {
    const r = await fetchOutcomeMetric(CTX, W, "cac", deps({ catalogColumns: vi.fn(async () => COLUMNS.filter((c) => c.name !== "finishedAt")) }));
    expect(r).toMatchObject({ ok: false, reason: "unsupported_definition" });
    expect((r as { message: string }).message).toMatch(/finishedAt/);
  });

  it("ROAS: refunds dated by refund day, or no revenue currency, are unsupported_definition; a currency mismatch is refused", async () => {
    const ev = await fetchOutcomeMetric(CTX, W, "roas", deps({ getOutcomeMap: vi.fn(async () => ({ ok: true as const, map: { ...MAP, refund_basis: "refund_event_day" as const } })) }));
    expect(ev).toMatchObject({ reason: "unsupported_definition" });
    const nc = await fetchOutcomeMetric(CTX, W, "roas", deps({ getOutcomeMap: vi.fn(async () => ({ ok: true as const, map: { ...MAP, currency: null } })) }));
    expect(nc).toMatchObject({ reason: "unsupported_definition" });
    const mm = await fetchOutcomeMetric(CTX, W, "roas", deps({ getOutcomeMap: vi.fn(async () => ({ ok: true as const, map: { ...MAP, currency: "EUR" } })) }));
    expect(mm).toMatchObject({ reason: "currency_mismatch" });
  });

  it("a failed spend read is not turned into a number", async () => {
    const r = await fetchOutcomeMetric(CTX, W, "cac", deps({ spend: vi.fn(async () => ({ ok: false as const, reason: "read_failed" as const, message: "Meta read failed." })) }));
    expect(r).toMatchObject({ ok: false, reason: "read_failed" });
  });
});

describe("finished-outcome metrics: values and bounds", () => {
  const { meta, impl } = catalogEntry("first_completed_cac")!;

  it("exact: spend / customers whose first finish falls in the week, from the rollup (no live scan)", async () => {
    const d = deps({ readRollup: vi.fn(async () => rollup([day("2026-10-01", 9), day("2026-10-06", 2), day("2026-10-08", 1)])) });
    const r = (await fetchOutcomeMetric(CTX, W, "cac", d)) as FetchOk;
    expect(r.ok).toBe(true);
    expect(r.estimate?.exact).toBe(true);
    expect(d.withSession).toHaveBeenCalledTimes(1);
    const agg = aggregate(meta, impl, r, W, "week");
    expect(agg.total).toBe(200);
    expect(agg.total_bounds).toEqual({ low: 200, high: 200 });
  });

  it("a stale rollup is not used: computed live once and a refresh is requested", async () => {
    const stale = { ...rollup([]), through_day: "2026-10-09" };
    const d = deps({ readRollup: vi.fn(async () => stale) });
    const live = vi.fn(async () => ({ unplaced: [], first: { days: [{ date: "2026-10-06", customers: 3 }], first_seen_floor: null } }));
    d.withSession = live as unknown as OutcomeDeps["withSession"];
    const r = (await fetchOutcomeMetric(CTX, W, "cac", d)) as FetchOk;
    expect(live).toHaveBeenCalled();
    expect(d.requestRefresh).toHaveBeenCalledWith("t1");
    expect(aggregate(meta, impl, r, W, "week").total).toBe(200);
  });

  it("orders changed since the rollup (watermark differs): computed live and a refresh is requested", async () => {
    const live = vi.fn(async (_c: MetricFetchCtx, fn: (s: never) => Promise<unknown>) =>
      fn(
        fakeSession(11, [
          { floor: [{ min: new Date("2025-01-01T00:00:00Z") }], days: [{ _id: "2026-10-06", n: 2 }] },
        ]),
      ),
    );
    const d = deps({ readRollup: vi.fn(async () => rollup([day("2026-10-06", 3)])), withSession: live as unknown as OutcomeDeps["withSession"] });
    const r = (await fetchOutcomeMetric(CTX, W, "cac", d)) as FetchOk;
    expect(d.requestRefresh).toHaveBeenCalledWith("t1");
    expect(r.estimate?.coverage.computed).toBe("live");
    expect(r.estimate?.coverage.rollup_skipped).toMatch(/changed/);
  });

  it("unplaced finished orders withhold the value; bounds allow each to move the count by one", async () => {
    const d = deps({ readRollup: vi.fn(async () => rollup([day("2026-10-06", 2, 1), day("2026-10-08", 1)])) });
    const r = (await fetchOutcomeMetric(CTX, W, "cac", d)) as FetchOk;
    expect(r.estimate?.exact).toBe(false);
    const agg = aggregate(meta, impl, r, W, "week");
    expect(agg.total).toBeNull();
    expect(agg.total_bounds).toEqual({ low: 150, high: 300 });
    expect(r.estimate?.assumptions.join(" ")).toMatch(/finishes after it is created/);
  });

  it("another paid ad platform connected: value withheld, only the lower bound (real spend is higher)", async () => {
    const d = deps({
      readRollup: vi.fn(async () => rollup([day("2026-10-06", 3)])),
      connectedSlugs: vi.fn(async () => ["meta_ads", "google_ads", "composio.tiktok_ads"]),
      ledgerSeen: vi.fn(async () => [{ platform: "tiktok", usd: 50, first_day: "2026-10-08", last_day: "2026-10-10" }]),
    });
    const r = (await fetchOutcomeMetric(CTX, W, "cac", d)) as FetchOk;
    const agg = aggregate(meta, impl, r, W, "week");
    expect(agg.total).toBeNull();
    expect(agg.total_bounds).toEqual({ low: 200, high: null });
    expect(r.estimate?.coverage.ledger_spend_not_counted).toEqual([{ platform: "tiktok", usd: 50, first_day: "2026-10-08", last_day: "2026-10-10" }]);
  });

  it("ad accounts on another time zone: neither value nor bound, and the fix is named", async () => {
    const d = deps({
      readRollup: vi.fn(async () => rollup([day("2026-10-06", 3)])),
      spend: vi.fn(async () => spend([["2026-10-06", 600]], ["America/New_York", "America/New_York"])),
    });
    const r = (await fetchOutcomeMetric(CTX, W, "cac", d)) as FetchOk;
    const agg = aggregate(meta, impl, r, W, "week");
    expect(agg.total).toBeNull();
    expect(agg.total_bounds).toEqual({ low: null, high: null });
    expect(r.estimate?.assumptions.join(" ")).toMatch(/Setting the reporting time zone to America\/New_York/);
  });

  it("ROAS: net = gross - refund by finish day; an unreadable revenue withholds that bucket", async () => {
    const roas = catalogEntry("completed_net_roas")!;
    const d = deps({
      readRollup: vi.fn(async () => rollup([])),
      withSession: vi.fn(async (_c: MetricFetchCtx, fn: (s: never) => Promise<unknown>) =>
        fn(
          fakeSession(10, [
            { _id: "2026-10-06", gross: 900, refund: 100, orders: 2, unreadable: 0 },
            { _id: "2026-10-08", gross: 400, refund: 0, orders: 1, unreadable: 0 },
          ]),
        ),
      ) as unknown as OutcomeDeps["withSession"],
    });
    const r = (await fetchOutcomeMetric(CTX, W, "roas", d)) as FetchOk;
    expect(aggregate(roas.meta, roas.impl, r, W, "week").total).toBe(2);
    expect(roas.impl.value({ gross: 10, refund: 0, spend: 5, unreadable: 1 })).toBeNull();
  });
});

describe("bound math", () => {
  it("CAC: [S/(C+U), S/(C-U)]; no upper bound with partial spend or when C <= U", () => {
    expect(cacBounds({ spend: 600, customers: 3 }, { unplaced: 1 })).toEqual({ low: 150, high: 300 });
    expect(cacBounds({ spend: 600, customers: 3 }, { unplaced: 1, spend_partial: 1 })).toEqual({ low: 150, high: null });
    expect(cacBounds({ spend: 600, customers: 1 }, { unplaced: 1 })).toEqual({ low: 300, high: null });
  });

  it("ROAS: unplaced net by sign; partial spend pulls the far side to 0; unreadable money gives no bound", () => {
    expect(roasBounds({ gross: 1000, refund: 0, spend: 500 }, { unplaced_pos: 500, unplaced_neg: -250 })).toEqual({ low: 1.5, high: 3 });
    expect(roasBounds({ gross: 1000, refund: 0, spend: 500 }, { unplaced_pos: 500, unplaced_neg: 0, spend_partial: 1 })).toEqual({ low: 0, high: 3 });
    expect(roasBounds({ gross: 0, refund: 300, spend: 100 }, { spend_partial: 1 })).toEqual({ low: -3, high: 0 });
    expect(roasBounds({ gross: 1000, refund: 0, spend: 500 }, { unplaced_unreadable: 1 })).toEqual({ low: null, high: null });
  });

  it("other paid platforms are recognised by slug, Meta and Google are not", () => {
    expect(["composio.tiktok_ads", "x_ads", "reddit_ads", "meta_ads", "google_ads", "tiktok", "stripe"].filter(isOtherPaidSlug)).toEqual([
      "composio.tiktok_ads",
      "x_ads",
      "reddit_ads",
    ]);
  });

  it("ROAS with an unreadable revenue anywhere is not exact, and says why", async () => {
    const d = deps({
      readRollup: vi.fn(async () => rollup([])),
      withSession: vi.fn(async (_c: MetricFetchCtx, fn: (s: never) => Promise<unknown>) => fn(fakeSession(10, [{ _id: "2026-10-06", gross: 900, refund: 0, orders: 2, unreadable: 1 }]))) as unknown as OutcomeDeps["withSession"],
    });
    const r = (await fetchOutcomeMetric(CTX, W, "roas", d)) as FetchOk;
    expect(r.estimate?.exact).toBe(false);
    expect(r.estimate?.assumptions.join(" ")).toMatch(/not a number/);
  });

  it("Postgres time fields with no time zone are refused", async () => {
    const pgMap = { ...MAP, engine: "postgres" as const, completed_at_field: "finished_at", date_field: "created_at", status_field: "status", customer_ref_field: "customer_id", revenue_field: "total", refund_field: "refunded" };
    const cols = [
      { name: "finished_at", type: "timestamp without time zone", nullable: true },
      { name: "created_at", type: "timestamp with time zone", nullable: true },
      ...["status", "customer_id", "total", "refunded"].map((name) => ({ name, type: "text", nullable: true })),
    ];
    const r = await fetchOutcomeMetric(CTX, W, "cac", deps({ getOutcomeMap: vi.fn(async () => ({ ok: true as const, map: pgMap })), catalogColumns: vi.fn(async () => cols) }));
    expect(r).toMatchObject({ ok: false, reason: "unsupported_definition" });
    expect((r as { message: string }).message).toMatch(/finished_at/);
  });
});
