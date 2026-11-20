import { describe, expect, it } from "vitest";
import { summarize, median, p90 } from "../lib/stats.mjs";

describe("median and p90", () => {
  it("median handles odd and even counts", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("p90 is nearest rank", () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(18);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(10);
    expect(p90([42])).toBe(42);
    expect(p90([])).toBeNull();
  });

  it("summarize excludes and counts nulls instead of treating them as zero", () => {
    const s = summarize([300, null, 100, undefined, NaN, 200, "50"]);
    expect(s).toEqual({ n: 3, nulls: 4, median: 200, p90: 300, mean: 200 });
  });

  it("summarize sorts numerically, not lexically", () => {
    expect(summarize([100, 9, 20]).median).toBe(20);
    expect(summarize([100, 9, 20, 5, 7, 8, 1000, 6, 4, 3]).p90).toBe(100);
  });

  it("all-null input yields null stats with the null count", () => {
    expect(summarize([null, null])).toEqual({ n: 0, nulls: 2, median: null, p90: null, mean: null });
  });
});
