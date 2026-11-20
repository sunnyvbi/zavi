import { describe, expect, it } from "vitest";
import { classifyMetricMode, classifyTargetMetric } from "../goal-metric-vocab";
import { measureGoalMetric, type MeasureDeps } from "../goal-metric-resolver";
import { minusDays, sumBookingValue, ROLLUP_MAX_AGE_MS } from "../booking-value";

const NOW = new Date("2026-10-11T12:00:00Z");

function deps(o: { bv?: number | "unknown" | null; net?: boolean; stripe?: number | "unknown" | null; bookingsCount?: number | null }): MeasureDeps {
  return {
    readNativeStep: async () => null,
    readOperatorFunnelBookings: async () => o.bookingsCount ?? null,
    readOperatorNewUsers: async () => null,
    readStripeMrr: async () => null,
    readStripeGrossRevenue: async () => (typeof o.stripe === "number" ? o.stripe : null),
    readStripeGrossState: async () => o.stripe ?? null,
    readBookingValue30d: async () => (o.bv == null || o.bv === "unknown" ? (o.bv ?? null) : { usd: o.bv, net_of_refunds: o.net ?? true }),
  };
}
const measure = (metric: string, d: MeasureDeps, measure_source: string | null = null) =>
  measureGoalMetric({ tenant_id: "t-1", target_metric: metric, goal_created_at: "2026-10-01T00:00:00Z", now: NOW, deps: d, measure_source });

describe("classifier: money words are dollars, never a booking count", () => {
  it.each(["gmv", "GMV", "booked value", "booking value", "gross merchandise value", "gross bookings", "rental revenue", "sales value", "order volume"])(
    "must catch: %s is a money goal",
    (m) => {
      expect(classifyTargetMetric(m)).toEqual({ kind: "booking_value" });
      expect(classifyMetricMode(m)).toBe("auto");
    },
  );
  it.each([
    ["bookings", "operator_funnel"],
    ["weekly rentals", "operator_funnel"],
    ["revenue", "unresolved"],
    ["average order value", "unresolved"],
    ["gross revenue", "stripe_gross_revenue"],
  ])("must not catch: %s stays %s", (m, kind) => {
    expect(classifyTargetMetric(m).kind).toBe(kind);
  });
});

describe("measuring a money goal", () => {
  it("must catch: 'booked value' is measured in dollars from the bookings database, not the booking count", async () => {
    const r = await measure("booked value", deps({ bv: 212_000, bookingsCount: 140 }));
    expect(r).toEqual({ measured: true, value: 212_000, source: "booking_value", unit: "usd" });
  });

  it("only Stripe available (a store with no booking mapping): measured from Stripe, labelled", async () => {
    expect(await measure("gmv", deps({ stripe: 48_500 }))).toEqual({ measured: true, value: 48_500, source: "stripe_gross_revenue", unit: "usd" });
  });

  it("must catch: both sources -> not measured, both candidates side by side with definitions and 30-day numbers", async () => {
    const r = await measure("gmv", deps({ bv: 52_400, stripe: 61_250.5 }));
    expect(r).toMatchObject({ measured: false, reason: "pick_money_source" });
    if (r.measured) throw new Error("unreachable");
    expect(r.candidates).toEqual([
      expect.objectContaining({ source: "booking_value", label: "Bookings database", value_30d_usd: 52_400, definition: "Booking value from your bookings database, net of refunds" }),
      expect.objectContaining({ source: "stripe_gross_revenue", label: "Stripe", value_30d_usd: 61_250.5 }),
    ]);
  });

  it("must catch: a booking mapping whose rollup is gappy or stale is a source that is down, not absent: Stripe is NOT adopted unpicked", async () => {
    expect(await measure("gmv", deps({ bv: "unknown", stripe: 61_250.5 }))).toEqual({ measured: false, reason: "money_source_unknown" });
    expect(await measure("gmv", deps({ bv: 52_400, stripe: "unknown" }))).toEqual({ measured: false, reason: "money_source_unknown" });
  });

  it("a founder's pick measures from that source only, even with both available", async () => {
    expect(await measure("gmv", deps({ bv: 52_400, stripe: 61_250.5 }), "stripe_gross_revenue")).toMatchObject({ measured: true, value: 61_250.5, source: "stripe_gross_revenue" });
    expect(await measure("gmv", deps({ bv: 52_400, stripe: 61_250.5 }), "booking_value")).toMatchObject({ measured: true, value: 52_400, source: "booking_value" });
  });

  it("a picked source that is unreadable is unmeasured, never the other source", async () => {
    expect(await measure("gmv", deps({ bv: null, stripe: 70_000 }), "booking_value")).toEqual({ measured: false, reason: "booking_value_unavailable" });
  });

  it("no money source: unmeasured, never the booking count", async () => {
    expect(await measure("gmv", deps({ bookingsCount: 140 }))).toEqual({ measured: false, reason: "money_source_unavailable" });
  });
});

describe("review fixes", () => {
  it("a mapping that does not net refunds is described as before refunds", async () => {
    const r = await measure("gmv", deps({ bv: 50_000, net: false, stripe: 60_000 }));
    if (r.measured) throw new Error("unreachable");
    expect(r.candidates?.[0]).toMatchObject({ definition: "Booking value from your bookings database, before refunds" });
  });
  it("the 30-day window is 30 calendar dates, whatever the clock (no DST drift)", () => {
    expect(minusDays("2026-03-20", 29)).toBe("2026-02-19");
    expect(minusDays("2026-11-05", 29)).toBe("2026-10-07");
  });
  it("a rollup refreshed before the mapping was (re)confirmed is not used", () => {
    const fresh = new Date(NOW.getTime() - 3_600_000).toISOString();
    const confirmedAfter = new Date(NOW.getTime() - 600_000).toISOString();
    expect(sumBookingValue([{ day: "2026-10-10", revenue_native: 5, refreshed_at: fresh }], "2026-09-12", "2026-10-11", NOW, confirmedAfter)).toEqual({ predates_mapping: true });
  });
  it("a cached row in another currency is not summed as dollars", () => {
    const fresh = new Date(NOW.getTime() - 3_600_000).toISOString();
    expect(sumBookingValue([{ day: "2026-10-10", revenue_native: 5, refreshed_at: fresh, currency: "EUR" }], "2026-09-12", "2026-10-11", NOW)).toEqual({ predates_mapping: true });
  });
});

describe("sumBookingValue (trailing window from the cached rollup)", () => {
  const fresh = new Date(NOW.getTime() - 3_600_000).toISOString();
  const old = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();
  const fullBatch = (from: string, to: string, value: (day: string) => number) => {
    const rows = [];
    for (let d = from; d <= to; d = minusDays(d, -1)) rows.push({ day: d, revenue_native: value(d), refreshed_at: fresh });
    return rows;
  };

  it("must catch: sums the TRAILING 30 days (Sep 12 - Oct 11), not month-to-date", () => {
    const rows = fullBatch("2026-09-12", "2026-10-11", (d) => (d < "2026-10-01" ? 1000 : 100));
    expect(sumBookingValue(rows, minusDays("2026-10-11", 29), "2026-10-11", NOW)).toEqual({ usd: 20_100 });
    expect(minusDays("2026-10-11", 29)).toBe("2026-09-12");
  });

  it("must catch: a missing day in the latest batch makes the total unknown, never a partial sum", () => {
    const rows = fullBatch("2026-09-12", "2026-10-11", () => 500).filter((r) => r.day !== "2026-09-20");
    expect(sumBookingValue(rows, "2026-09-12", "2026-10-11", NOW)).toEqual({ missing_days: true });
  });

  it("only the latest batch counts: a day covered only by an older refresh is missing", () => {
    const rows = fullBatch("2026-09-12", "2026-10-11", () => 10).map((r) => (r.day === "2026-10-01" ? { ...r, refreshed_at: old } : r));
    expect(sumBookingValue(rows, "2026-09-12", "2026-10-11", NOW)).toEqual({ missing_days: true });
  });

  it("explicit zero days (no bookings) count as zero, and rows outside the window are ignored", () => {
    const rows = [...fullBatch("2026-09-12", "2026-10-11", (d) => (d === "2026-10-11" ? 250.5 : 0)), { day: "2026-09-01", revenue_native: 9999, refreshed_at: fresh }];
    expect(sumBookingValue(rows, "2026-09-12", "2026-10-11", NOW)).toEqual({ usd: 250.5 });
  });

  it("a stale or empty rollup is not a zero", () => {
    const stale = new Date(NOW.getTime() - ROLLUP_MAX_AGE_MS - 60_000).toISOString();
    expect(sumBookingValue([{ day: "2026-10-10", revenue_native: 5, refreshed_at: stale }], "2026-09-12", "2026-10-11", NOW)).toEqual({ stale: true });
    expect(sumBookingValue([], "2026-09-12", "2026-10-11", NOW)).toEqual({ stale: true });
  });
});

describe("the rollup refresh writes every day of its window", () => {
  it("a day with no bookings gets an explicit zero row, so the measurer can tell it from a missing day", async () => {
    const { withZeroDays } = await import("../../../../workers/functions/booking-rollup-refresh");
    const out = withZeroDays([{ date: "2026-10-02", bookings: 3, revenue_native: 450 }], "2026-10-01", "2026-10-04", true);
    expect(out).toEqual([
      { date: "2026-10-01", bookings: 0, revenue_native: 0 },
      { date: "2026-10-02", bookings: 3, revenue_native: 450 },
      { date: "2026-10-03", bookings: 0, revenue_native: 0 },
      { date: "2026-10-04", bookings: 0, revenue_native: 0 },
    ]);
    expect(withZeroDays([], "2026-10-01", "2026-10-01", false)).toEqual([{ date: "2026-10-01", bookings: 0, revenue_native: null }]);
  });
});
