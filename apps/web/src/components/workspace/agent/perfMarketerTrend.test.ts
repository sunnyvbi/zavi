
import { describe, expect, it } from "vitest";
import {
  METRICS,
  MIN_COVERAGE_GAP_DAYS,
  anchorsAgree,
  baselineFor,
  buildRows,
  clampSelection,
  coverageShortfallDays,
  defaultSelectionFor,
  latestValue,
  missingDaysFor,
  stalenessDays,
  tileDomain,
  toChartRows,
  type DeliveryPoint,
  type MoneyPoint,
  type Row,
} from "./perfMarketerTrend";

function delivery(date: string, over: Partial<DeliveryPoint> = {}): DeliveryPoint {
  return {
    date,
    spend_usd: 100,
    impressions: 1000,
    clicks: 20,
    ctr_percent: 2,
    cpc_usd: 5,
    cpm_usd: 100,
    maturing: false,
    ...over,
  };
}

function money(date: string, over: Partial<MoneyPoint> = {}): MoneyPoint {
  return {
    date,
    bookings: 4,
    revenue_usd: 800,
    mer: 8,
    cost_per_booking_usd: 25,
    ...over,
  };
}

describe("invariant 1 — a missing day is never rendered as zero", () => {
  it("leaves bookings NULL when the rollup has no row for that day", () => {
    const rows = buildRows(
      [delivery("2026-07-01"), delivery("2026-07-02"), delivery("2026-07-03")],
      [money("2026-07-01"), money("2026-07-03")],
      true,
    );
    expect(rows[1].bookings).toBeNull();
    expect(rows[1].revenue_usd).toBeNull();
    expect(rows[1].mer).toBeNull();
    expect(rows[1].cost_per_booking_usd).toBeNull();
  });

  it("preserves a REAL zero — a zero-booking day is not the same as a missing day", () => {
    const rows = buildRows(
      [delivery("2026-07-01")],
      [money("2026-07-01", { bookings: 0, revenue_usd: 0, mer: 0, cost_per_booking_usd: null })],
      true,
    );
    expect(rows[0].bookings).toBe(0);
    expect(rows[0].bookings).not.toBeNull();
  });

  it("nulls every money metric when the tenant has no confirmed mapping", () => {
    const rows = buildRows([delivery("2026-07-01")], [money("2026-07-01")], false);
    expect(rows[0].bookings).toBeNull();
    expect(rows[0].mer).toBeNull();
    expect(rows[0].spend_usd).toBe(100);
  });
});

describe("invariant 2 — a gap stays a gap", () => {
  it("emits a null index for a null raw so recharts breaks the line", () => {
    const rows = buildRows(
      [delivery("2026-07-01"), delivery("2026-07-02"), delivery("2026-07-03")],
      [money("2026-07-01"), money("2026-07-03", { bookings: 8 })],
      true,
    );
    const chart = toChartRows(rows, ["bookings"]);
    expect(chart[0].idx_bookings).toBe(100);
    expect(chart[1].raw_bookings).toBeNull();
    expect(chart[1].idx_bookings).toBeNull();
    expect(chart[2].idx_bookings).toBe(200);
  });

  it("counts the holes so the UI can warn about them", () => {
    const rows = buildRows(
      ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"].map((d) => delivery(d)),
      [money("2026-07-01")],
      true,
    );
    expect(missingDaysFor(rows, "bookings")).toBe(3);
    expect(missingDaysFor(rows, "spend_usd")).toBe(0);
  });
});

describe("invariant 3 — a ratio is shown with its inputs", () => {
  const merDef = METRICS.find((m) => m.key === "mer")!;
  const cpbDef = METRICS.find((m) => m.key === "cost_per_booking_usd")!;
  const ctrDef = METRICS.find((m) => m.key === "ctr_percent")!;

  it("exposes the denominator that makes a huge MER legible as an artifact", () => {
    const row = buildRows(
      [delivery("2026-07-07", { spend_usd: 2 })],
      [money("2026-07-07", { revenue_usd: 680, mer: 340 })],
      true,
    )[0];
    expect(merDef.inputs?.(row)).toBe("$680 revenue ÷ $2 spend");
  });

  it("shows spend ÷ bookings behind cost per booking", () => {
    const row = buildRows(
      [delivery("2026-07-02", { spend_usd: 300 })],
      [money("2026-07-02", { bookings: 12, cost_per_booking_usd: 25 })],
      true,
    )[0];
    expect(cpbDef.inputs?.(row)).toBe("$300 spend ÷ 12 bookings");
  });

  it("shows clicks ÷ impressions behind CTR", () => {
    const row = buildRows([delivery("2026-07-02")], [], false)[0];
    expect(ctrDef.inputs?.(row)).toBe("20 clicks ÷ 1,000 impressions");
  });

  it("returns null inputs rather than inventing a denominator when data is missing", () => {
    const row = buildRows([delivery("2026-07-02")], [], false)[0];
    expect(merDef.inputs?.(row)).toBeNull();
    expect(cpbDef.inputs?.(row)).toBeNull();
  });

  it("classifies every already-normalized metric as a ratio", () => {
    const ratios = METRICS.filter((m) => m.kind === "ratio").map((m) => m.key).sort();
    expect(ratios).toEqual(
      ["cost_per_booking_usd", "cpc_usd", "cpm_usd", "ctr_percent", "mer"].sort(),
    );
  });
});

describe("invariant 4 — staleness is measured, not narrated", () => {
  it("reports how far behind the window the rollup is", () => {
    expect(stalenessDays("2026-07-17T04:11:00Z", "2026-07-25")).toBe(8);
  });

  it("is zero when the rollup is current or ahead", () => {
    expect(stalenessDays("2026-07-25T23:00:00Z", "2026-07-25")).toBe(0);
    expect(stalenessDays("2026-07-26T01:00:00Z", "2026-07-25")).toBe(0);
  });

  it("is zero — never NaN — when either side is absent or unparseable", () => {
    expect(stalenessDays(null, "2026-07-25")).toBe(0);
    expect(stalenessDays("2026-07-17T04:11:00Z", null)).toBe(0);
    expect(stalenessDays("not-a-date", "2026-07-25")).toBe(0);
  });
});

describe("invariant 4b — a cached snapshot cannot pose as the range you picked", () => {
  it("measures how far short of the requested end the data stops", () => {
    expect(coverageShortfallDays("2026-07-17", "2026-07-25")).toBe(8);
  });

  it("is zero when the data reaches or passes the requested end", () => {
    expect(coverageShortfallDays("2026-07-25", "2026-07-25")).toBe(0);
    expect(coverageShortfallDays("2026-07-26", "2026-07-25")).toBe(0);
  });

  it("treats one day of ordinary ad-platform lag as not worth warning about", () => {
    expect(coverageShortfallDays("2026-07-24", "2026-07-25")).toBeLessThan(
      MIN_COVERAGE_GAP_DAYS,
    );
    expect(coverageShortfallDays("2026-07-23", "2026-07-25")).toBeGreaterThanOrEqual(
      MIN_COVERAGE_GAP_DAYS,
    );
  });

  it("is zero — never NaN — when either side is absent or unparseable", () => {
    expect(coverageShortfallDays(null, "2026-07-25")).toBe(0);
    expect(coverageShortfallDays("2026-07-17", null)).toBe(0);
    expect(coverageShortfallDays("garbage", "2026-07-25")).toBe(0);
  });
});

describe("invariant 5 — no two series share an indistinguishable hue", () => {
  const rgb = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const dist = (a: string, b: string) =>
    Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

  it("assigns a unique color to every metric", () => {
    const colors = METRICS.map((m) => m.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("keeps every pair visually separated", () => {
    for (const a of METRICS) {
      for (const b of METRICS) {
        if (a.key >= b.key) continue;
        expect(
          dist(a.color, b.color),
          `${a.label} (${a.color}) vs ${b.label} (${b.color}) are too close`,
        ).toBeGreaterThan(60);
      }
    }
  });

  it("keeps the three previously-colliding pairs far apart", () => {
    const c = (k: string) => METRICS.find((m) => m.key === k)!.color;
    expect(dist(c("mer"), c("cost_per_booking_usd"))).toBeGreaterThan(80);
    expect(dist(c("cpc_usd"), c("bookings"))).toBeGreaterThan(80);
    expect(dist(c("clicks"), c("revenue_usd"))).toBeGreaterThan(80);
  });
});

describe("invariant 6 — a stated baseline is the baseline actually used", () => {
  const rows = (): Row[] =>
    buildRows(
      [
        delivery("2026-07-01", { spend_usd: 0 }),
        delivery("2026-07-02", { spend_usd: 50 }),
        delivery("2026-07-03", { spend_usd: 75, maturing: true }),
      ],
      [],
      false,
    );

  it("returns the anchor DATE alongside the value, so the caption cannot drift", () => {
    expect(baselineFor(rows(), "spend_usd")).toEqual({ value: 50, date: "2026-07-02" });
  });

  it("prefers a settled day over a still-settling one", () => {
    const r = buildRows(
      [
        delivery("2026-07-01", { spend_usd: 0, maturing: true }),
        delivery("2026-07-02", { spend_usd: 40, maturing: true }),
        delivery("2026-07-03", { spend_usd: 90, maturing: false }),
      ],
      [],
      false,
    );
    expect(baselineFor(r, "spend_usd")?.date).toBe("2026-07-03");
  });

  it("falls back to a maturing day only when no settled day is usable", () => {
    const r = buildRows(
      [
        delivery("2026-07-01", { spend_usd: 0, maturing: false }),
        delivery("2026-07-02", { spend_usd: 40, maturing: true }),
      ],
      [],
      false,
    );
    expect(baselineFor(r, "spend_usd")?.date).toBe("2026-07-02");
  });

  it("returns null when nothing in the window is divisible", () => {
    const r = buildRows([delivery("2026-07-01", { spend_usd: 0 })], [], false);
    expect(baselineFor(r, "spend_usd")).toBeNull();
  });

  it("detects when lines anchor on different days", () => {
    const r = buildRows(
      [
        delivery("2026-07-01", { spend_usd: 10, clicks: 0 }),
        delivery("2026-07-02", { spend_usd: 20, clicks: 5 }),
      ],
      [],
      false,
    );
    expect(anchorsAgree(r, ["spend_usd"])).toBe(true);
    expect(anchorsAgree(r, ["spend_usd", "clicks"])).toBe(false);
  });
});

describe("tile scaling + headline value", () => {
  it("floors a volume domain at zero so a small dip cannot look like a collapse", () => {
    expect(tileDomain([980, 1000, 1020], "volume")[0]).toBe(0);
  });

  it("pads a ratio domain around the data instead of flooring it", () => {
    const [lo, hi] = tileDomain([2.0, 2.4], "ratio");
    expect(lo).toBeGreaterThan(1.9);
    expect(lo).toBeLessThan(2.0);
    expect(hi).toBeGreaterThan(2.4);
  });

  it("handles a flat or empty series without collapsing the axis", () => {
    expect(tileDomain([], "volume")).toEqual([0, 1]);
    expect(tileDomain([0, 0], "volume")).toEqual([0, 1]);
    expect(tileDomain([5, 5], "ratio")).toEqual([0, 6]);
  });

  it("takes the headline number from the last day that HAS data", () => {
    const rows = buildRows(
      [delivery("2026-07-01"), delivery("2026-07-02"), delivery("2026-07-03")],
      [money("2026-07-01", { bookings: 9 })],
      true,
    );
    expect(latestValue(rows, "bookings")).toEqual({ value: 9, date: "2026-07-01" });
  });

  it("returns null rather than zero when a metric has no data at all", () => {
    const rows = buildRows([delivery("2026-07-01")], [], true);
    expect(latestValue(rows, "bookings")).toBeNull();
  });
});

describe("metric picker: 2 to 5 unique metrics", () => {
  const delivery = METRICS.filter((m) => !m.money);

  it("drops duplicates and metrics that are not available", () => {
    expect(clampSelection(["spend_usd", "spend_usd", "mer", "clicks"], delivery)).toEqual([
      "spend_usd",
      "clicks",
    ]);
  });

  it("pads up to the floor with default-on metrics first", () => {
    expect(clampSelection(["clicks"], delivery)).toEqual(["clicks", "spend_usd"]);
    expect(clampSelection([], delivery)).toEqual(["spend_usd", "ctr_percent"]);
  });

  it("caps at the ceiling, keeping the first five picked", () => {
    const all = METRICS.map((m) => m.key);
    expect(clampSelection(all, METRICS)).toEqual(all.slice(0, 5));
  });

  it("defaults to Spend + cost/booking when money is available, else Spend + CPC", () => {
    expect(defaultSelectionFor("meta", METRICS)).toEqual(["spend_usd", "cost_per_booking_usd"]);
    expect(defaultSelectionFor("meta", delivery)).toEqual(["spend_usd", "cpc_usd"]);
    expect(defaultSelectionFor("google", METRICS)).toEqual(["spend_usd", "cpc_usd"]);
    expect(defaultSelectionFor(undefined, METRICS)).toEqual(["spend_usd", "cost_per_booking_usd"]);
  });
});
