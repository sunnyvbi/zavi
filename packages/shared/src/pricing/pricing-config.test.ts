import { describe, expect, it } from "vitest";
import raw from "./pricing.config.json";
import { PRICING_CONFIG, includesForTier, parsePricingConfig, sixMonthDiscountPct } from "./pricing-config";

const clone = () => JSON.parse(JSON.stringify(raw));

describe("pricing.config.json", () => {
  it("loads and prices the four tiers", () => {
    expect(Object.keys(PRICING_CONFIG.tiers)).toEqual(["free", "starter", "growth", "pro"]);
    expect(sixMonthDiscountPct()).toBeGreaterThan(0);
  });

  it("rejects a six-month price above six monthly payments", () => {
    const c = clone();
    c.tiers.growth.six_month_usd = 999;
    expect(() => parsePricingConfig(c)).toThrow(/tiers.growth.six_month_usd must not exceed/);
  });

  it("rejects a top-up pack that matches no tier price", () => {
    const c = clone();
    c.topup_usd_packs = [50];
    expect(() => parsePricingConfig(c)).toThrow(/topup_usd_packs entry 50/);
  });

  it("rejects two paid tiers at one price", () => {
    const c = clone();
    c.tiers.pro.monthly_usd = c.tiers.growth.monthly_usd;
    expect(() => parsePricingConfig(c)).toThrow(/share a monthly_usd/);
  });

  it("rejects a feature row with an unknown tier or a duplicated key", () => {
    const c = clone();
    c.features[0].min_tier = "gold";
    c.features[1].key = c.features[2].key;
    expect(() => parsePricingConfig(c)).toThrow(/features\[0\]\.min_tier[\s\S]*is duplicated/);
  });

  it("lists each tier's own rows under a lead-in, one line per channel, no coming-soon marker", () => {
    const starter = includesForTier("starter");
    expect(starter[0]).toBe("Everything in Free, plus:");
    expect(starter).toContain("Instagram");
    expect(includesForTier("free")).toContain("Build and publish websites and apps (uses your credits)");
    expect(starter.some((l) => /build/i.test(l))).toBe(false);
    expect(includesForTier("growth")).toEqual(["Everything in Starter, plus:", "UGC Videos (real creators)", "TikTok", "YouTube"]);
    expect(starter).not.toContain("TikTok");
    expect(includesForTier("free")[0]).toBe("Website analysis and 30-day growth plan");
    for (const t of ["free", "starter", "growth", "pro"] as const) {
      expect(includesForTier(t).join("\n")).not.toMatch(/coming soon/i);
    }
  });
});
