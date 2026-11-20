import { describe, it, expect } from "vitest";
import { adFatigue, rankAdsWithFatigue, type AdDay } from "../ad-fatigue";

function days(n: number, row: Omit<AdDay, "date">, endDay = 31): AdDay[] {
  return Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(endDay - n + 1 + i).padStart(2, "0")}`, ...row }));
}

describe("adFatigue: an ad against its own past", () => {
  it("a CTR that fell 40% against its own baseline is fatigued", () => {
    const series = { ad_id: "a", days: [...days(14, { impressions: 1000, clicks: 20, spend_usd: 10, results: 1 }, 23), ...days(7, { impressions: 1000, clicks: 12, spend_usd: 10, results: 1 })] };
    const f = adFatigue(series);
    expect(f.fatigue).toBe("fatigued");
    expect(f.ctr_drop).toBeCloseTo(0.4, 5);
  });
  it("a steady CTR is fresh, whatever the frequency", () => {
    const series = { ad_id: "a", days: days(21, { impressions: 1000, clicks: 20, spend_usd: 10, results: 1 }) };
    expect(adFatigue(series).fatigue).toBe("fresh");
  });
  it("too few impressions is unknown, never fatigued", () => {
    const series = { ad_id: "a", days: [...days(14, { impressions: 10, clicks: 5, spend_usd: 1, results: 0 }, 23), ...days(7, { impressions: 10, clicks: 0, spend_usd: 1, results: 0 })] };
    expect(adFatigue(series).fatigue).toBe("unknown");
  });
});

describe("rankAdsWithFatigue", () => {
  it("cheapest cost per result first; fatigued after fresh; no result after any result; no spend last", () => {
    const fresh = (id: string, spend: number, results: number) => ({ ad_id: id, days: days(21, { impressions: 1000, clicks: 20, spend_usd: spend, results }) });
    const tired = {
      ad_id: "tired-cheap",
      days: [...days(14, { impressions: 1000, clicks: 30, spend_usd: 1, results: 1 }, 23), ...days(7, { impressions: 1000, clicks: 10, spend_usd: 1, results: 1 })],
    };
    const ranked = rankAdsWithFatigue([fresh("pricey", 30, 1), tired, fresh("cheap", 5, 1), fresh("no-result", 5, 0), fresh("idle", 0, 0)]);
    expect(ranked.map((r) => r.ad_id)).toEqual(["cheap", "pricey", "tired-cheap", "no-result", "idle"]);
    expect(ranked[0].cost_per_result).toBe(5);
  });
});
