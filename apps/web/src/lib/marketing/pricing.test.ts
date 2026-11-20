import { describe, it, expect } from "vitest";
import { PRICING_FALLBACK, liveTier, nextTier, parsePublicPricing, tierDisplayName } from "./pricing";

const body = {
  tiers: [
    { slug: "free", name: "Free", usd: 0, monthly_credits: 0, daily_credits: 1000, includes: ["Chat with Zavi"] },
    { slug: "starter", name: "Starter", usd: 20, monthly_credits: 9000, daily_credits: 1000, includes: ["a"] },
    { slug: "growth", name: "Growth", usd: 120, monthly_credits: 48000, daily_credits: 1000, includes: ["b"] },
    { slug: "pro", name: "Pro", usd: 240, monthly_credits: 96000, daily_credits: 1000, includes: ["c"] },
  ],
  free_daily_credits: 1000,
  topup_packs: [{ usd: 20, credits: 9000 }],
  rungs: [{ usd: 50, credits: 20000 }],
};

describe("parsePublicPricing", () => {
  it("renders what the server sends", () => {
    const p = parsePublicPricing(body);
    expect(p.tiers.map((t) => t.slug)).toEqual(["free", "starter", "growth", "pro"]);
    expect(p.tiers[1].monthlyCredits).toBe(9000);
    expect(p.topupPacks).toEqual([{ usd: 20, credits: 9000 }]);
  });

  it("reads the six-month figures off the wire, falling back to the backend formula", () => {
    const wire = parsePublicPricing({
      ...body,
      tiers: body.tiers.map((t) => ({ ...t, six_month_usd: t.usd * 3, six_month_per_month_usd: t.usd / 2 })),
      six_month_discount_pct: 50,
    });
    expect(wire.tiers.map((t) => [t.sixMonthUsd, t.sixMonthPerMonthUsd])).toEqual([
      [0, 0],
      [60, 10],
      [360, 60],
      [720, 120],
    ]);
    expect(wire.sixMonthDiscountPct).toBe(50);
    const old = parsePublicPricing(body);
    expect(old.tiers[1].sixMonthPerMonthUsd).toBe(10);
    expect(old.sixMonthDiscountPct).toBe(50);
  });

  it("falls back wholesale on a stale backend that only sends rungs", () => {
    const p = parsePublicPricing({ rungs: body.rungs, free_daily_credits: 5000 });
    expect(p.tiers).toEqual(PRICING_FALLBACK.tiers);
    expect(p.topupPacks).toEqual(PRICING_FALLBACK.topupPacks);
    expect(p.freeDailyCredits).toBe(5000);
  });

  it("falls back when a tier is missing or malformed", () => {
    expect(parsePublicPricing({ tiers: body.tiers.slice(0, 3) }).tiers).toEqual(PRICING_FALLBACK.tiers);
    expect(parsePublicPricing(null)).toEqual(PRICING_FALLBACK);
  });

  it("fallback mirrors the backend defaults and has no em-dashes", () => {
    expect(PRICING_FALLBACK.tiers.map((t) => [t.usd, t.monthlyCredits])).toEqual([
      [0, 0],
      [20, 8000],
      [120, 48000],
      [240, 96000],
    ]);
    expect(JSON.stringify(PRICING_FALLBACK)).not.toMatch(/—/);
  });

  it("tier helpers", () => {
    expect(nextTier("free")).toBe("starter");
    expect(nextTier("pro")).toBeNull();
    expect(tierDisplayName("growth")).toBe("Growth");
  });
});

describe("liveTier", () => {
  it("reads the live tier, and a missing one from the fallback, never a literal", () => {
    const live = parsePublicPricing({ ...body, tiers: body.tiers.map((t) => (t.slug === "growth" ? { ...t, usd: 99 } : t)) });
    expect(liveTier(live, "growth").usd).toBe(99);
    const partial = { ...live, tiers: live.tiers.filter((t) => t.slug !== "pro") };
    expect(liveTier(partial, "pro")).toEqual(PRICING_FALLBACK.tiers.find((t) => t.slug === "pro"));
  });
});
