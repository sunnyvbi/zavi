
import { describe, it, expect } from "vitest";
import { detectAnomaly, unusualWords, isBadMove, ANOMALY_Z, MIN_PRIOR_POINTS, ANOMALY_TRAILING_WEEKS } from "../anomaly";
import { addDays } from "../metric-time";

const END = "2026-09-27";

function series(f: (i: number, date: string) => number | null, days = 7 * ANOMALY_TRAILING_WEEKS + 1) {
  const start = addDays(END, -(days - 1));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    return { date, value: f(i, date) };
  });
}

const noisy = (i: number) => 100 + ((i * 7) % 13) - 6;

describe("detectAnomaly: the z gate", () => {
  it("fires on a value far below its 8 weeks (daily, same weekday agrees)", () => {
    const s = series((i, d) => (d === END ? 40 : noisy(i)));
    const v = detectAnomaly(s, { kind: "daily", isCount: true });
    expect(v.anomaly).toBe(true);
    if (!v.anomaly) return;
    expect(v.direction).toBe("down");
    expect(v.date).toBe(END);
    expect(v.z).toBeLessThanOrEqual(-ANOMALY_Z);
    expect(v.weekday_z).toBeLessThanOrEqual(-ANOMALY_Z);
    expect(v.typical).toBeGreaterThan(90);
  });

  it("fires upward too", () => {
    const s = series((i, d) => (d === END ? 180 : noisy(i)));
    const v = detectAnomaly(s, { kind: "daily", isCount: true });
    expect(v).toMatchObject({ anomaly: true, direction: "up" });
  });

  it("does not fire on an ordinary day", () => {
    const s = series((i, d) => (d === END ? 104 : noisy(i)));
    const v = detectAnomaly(s, { kind: "daily", isCount: true });
    expect(v).toMatchObject({ anomaly: false, reason: "within_normal" });
  });

  it("does not count the value in its own baseline", () => {
    const s = series((_, d) => (d === END ? 0 : 100));
    const v = detectAnomaly(s, { kind: "other", isCount: true });
    expect(v.anomaly).toBe(true);
    if (v.anomaly) expect(v.z).toBeCloseTo(-10, 5);
  });
});

describe("detectAnomaly: not enough history", () => {
  it(`needs at least ${MIN_PRIOR_POINTS} prior points`, () => {
    const s = series((i, d) => (d === END ? 0 : noisy(i)), MIN_PRIOR_POINTS);
    expect(detectAnomaly(s, { kind: "other", isCount: true })).toMatchObject({
      anomaly: false,
      reason: "not_enough_history",
      prior_points: MIN_PRIOR_POINTS - 1,
    });
    const s2 = series((i, d) => (d === END ? 0 : noisy(i)), MIN_PRIOR_POINTS + 1);
    expect(detectAnomaly(s2, { kind: "other", isCount: true }).anomaly).toBe(true);
  });

  it("a daily series needs 6 prior SAME weekdays, not just 6 days", () => {
    const s = series((i, d) => (d === END ? 0 : noisy(i)), 22);
    expect(detectAnomaly(s, { kind: "daily", isCount: true })).toMatchObject({ anomaly: false, reason: "not_enough_history" });
  });

  it("missing values are not points, and no value on the day is no verdict", () => {
    const gaps = series((i, d) => (d === END ? 0 : i % 2 === 0 ? null : 100), 12);
    expect(detectAnomaly(gaps, { kind: "other", isCount: true })).toMatchObject({ anomaly: false, reason: "not_enough_history" });
    const none = series((i, d) => (d === END ? null : noisy(i)));
    expect(detectAnomaly(none, { kind: "daily", isCount: true, date: END })).toMatchObject({ anomaly: false, reason: "no_value" });
  });

  it("only reads the 8 weeks before the day", () => {
    const s = series((i, d) => (d === END ? 40 : i < 60 ? (i % 2 ? 0 : 300) : noisy(i)), 140);
    const v = detectAnomaly(s, { kind: "daily", isCount: true });
    expect(v.anomaly).toBe(true);
  });
});

describe("detectAnomaly: same-weekday seasonality", () => {
  const sunday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay() === 0;

  it("a normal quiet Sunday is NOT an anomaly, even though it is far below the overall mean", () => {
    const s = series((i, d) => (sunday(d) ? 30 + (i % 3) : 100 + (i % 5)));
    const v = detectAnomaly(s, { kind: "daily", isCount: true });
    expect(v.anomaly).toBe(false);
    if (!v.anomaly) expect(v.reason).toBe("weekday_normal");
  });

  it("the same drop on a series that is not daily fires on the z gate alone", () => {
    const s = series((i, d) => (sunday(d) ? 30 + (i % 3) : 100 + (i % 5)));
    expect(detectAnomaly(s, { kind: "other", isCount: true }).anomaly).toBe(true);
  });

  it("a Sunday far below other Sundays IS an anomaly, and its typical is a normal Sunday", () => {
    const s = series((i, d) => (d === END ? 2 : sunday(d) ? 30 + (i % 3) : 100 + (i % 5)));
    const v = detectAnomaly(s, { kind: "daily", isCount: true });
    expect(v.anomaly).toBe(true);
    if (v.anomaly) expect(Math.round(v.typical)).toBeGreaterThanOrEqual(30);
    if (v.anomaly) expect(Math.round(v.typical)).toBeLessThanOrEqual(32);
  });

  it("the two gates must agree in direction", () => {
    const s = series((i, d) => (d === END ? 46 : sunday(d) ? 30 + (i % 3) : 150 + (i % 5)));
    const v = detectAnomaly(s, { kind: "daily", isCount: true });
    expect(v).toMatchObject({ anomaly: false, reason: "weekday_normal" });
  });
});

describe("detectAnomaly: sd floor", () => {
  it("a flat money series needs a 5%+ move, and flat zero is no verdict", () => {
    const flat = (last: number) => series((_, d) => (d === END ? last : 1000), 20);
    expect(detectAnomaly(flat(1060), { kind: "other", isCount: false })).toMatchObject({ anomaly: false });
    expect(detectAnomaly(flat(1110), { kind: "other", isCount: false }).anomaly).toBe(true);
    const zero = series((_, d) => (d === END ? 5 : 0), 20);
    expect(detectAnomaly(zero, { kind: "other", isCount: false })).toMatchObject({ anomaly: false, reason: "flat_history" });
  });

  it("a small count needs more than a one-off wobble (sqrt floor)", () => {
    const s = series((_, d) => (d === END ? 2 : 1), 20);
    expect(detectAnomaly(s, { kind: "other", isCount: true })).toMatchObject({ anomaly: false, reason: "within_normal" });
  });
});

describe("plain words", () => {
  it("never shows the z number", () => {
    expect(unusualWords(2.1)).toBe("outside its normal range");
    expect(unusualWords(-3.5)).toBe("well outside its normal range");
    expect(unusualWords(6)).toBe("far outside its normal range");
    for (const z of [2, 3, 4, 9]) expect(unusualWords(z)).not.toMatch(/\d|z=/);
  });

  it("judges a move against the metric's direction", () => {
    expect(isBadMove("up", "down")).toBe(true);
    expect(isBadMove("up", "up")).toBe(false);
    expect(isBadMove("down", "up")).toBe(true);
    expect(isBadMove("context", "up")).toBeNull();
  });
});
