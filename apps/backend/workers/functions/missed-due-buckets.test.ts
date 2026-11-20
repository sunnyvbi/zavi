import { describe, it, expect } from "vitest";
import { missedDueBuckets } from "./cron-match";

describe("missedDueBuckets", () => {
  it("a weekday 9am cron has ZERO missed buckets over a weekend", () => {
    const since = new Date("2026-06-05T09:06:00Z");
    const now = new Date("2026-06-06T12:00:00Z");
    expect(missedDueBuckets("0 9 * * 1-5", since, now)).toBe(0);
  });

  it("counts daily-cron fires missed since last_fired", () => {
    const since = new Date("2026-06-03T09:06:00Z");
    const now = new Date("2026-06-05T12:00:00Z");
    expect(missedDueBuckets("0 9 * * *", since, now)).toBe(2);
  });

  it("null last_fired counts due buckets over the bounded lookback", () => {
    const now = new Date("2026-06-05T12:00:00Z");
    expect(missedDueBuckets("0 9 * * *", null, now, 7)).toBeGreaterThanOrEqual(6);
  });

  it("returns 0 when last_fired is in the future (clock skew safety)", () => {
    const now = new Date("2026-06-05T12:00:00Z");
    const future = new Date("2026-06-05T13:00:00Z");
    expect(missedDueBuckets("0 9 * * *", future, now)).toBe(0);
  });
});
