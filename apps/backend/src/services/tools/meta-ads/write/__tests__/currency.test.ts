
import { describe, expect, it } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import { evaluateBudgetCap } from "../_cap-evaluator";
import {
  DEFAULT_UNITS_PER_USD,
  assertWritableCurrency,
  bodyCurrencyMismatch,
  capInAccountUnits,
  formatMoney,
  minorToMajor,
  unitsPerUsdFromBlob,
} from "../_currency";

describe("writable currencies", () => {
  it("accepts USD and INR in any case, refuses the rest with the unsupported code", () => {
    expect(assertWritableCurrency("usd")).toBe("USD");
    expect(assertWritableCurrency(" INR ")).toBe("INR");
    try {
      assertWritableCurrency("JPY");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectedToolError);
      expect((e as ExpectedToolError).code).toBe("meta_ads_unsupported_currency");
    }
  });

  it("reads Graph minor units back as major units, and nothing for an unwritable account", () => {
    expect(minorToMajor("150000", "INR")).toBe(1500);
    expect(minorToMajor("1250", "USD")).toBe(12.5);
    expect(minorToMajor("1250", "JPY")).toBeNull();
    expect(minorToMajor("-5", "USD")).toBeNull();
    expect(minorToMajor(null, "USD")).toBeNull();
  });
});

describe("the exchange rate", () => {
  it("is 1 for USD without reading config", () => {
    expect(unitsPerUsdFromBlob(null, "USD")).toBe(1);
  });

  it("uses the staff-set rate, and the conservative default when none is set or it is junk", () => {
    expect(unitsPerUsdFromBlob({ ad_fx_units_per_usd: { INR: 83 } }, "INR")).toBe(83);
    expect(unitsPerUsdFromBlob({ ad_fx_units_per_usd: { INR: "84.5" } }, "inr")).toBe(84.5);
    expect(unitsPerUsdFromBlob({}, "INR")).toBe(DEFAULT_UNITS_PER_USD.INR);
    expect(unitsPerUsdFromBlob({ ad_fx_units_per_usd: { INR: -1 } }, "INR")).toBe(DEFAULT_UNITS_PER_USD.INR);
    expect(unitsPerUsdFromBlob({ ad_fx_units_per_usd: { INR: "abc" } }, "INR")).toBe(DEFAULT_UNITS_PER_USD.INR);
  });
});

describe("a USD cap against an INR budget", () => {
  const cap = { enabled: true, max_daily_budget_usd: 50, max_pct_change_per_run: 0.5, max_daily_total_change_usd: 100 };

  it("scales the money axes, never the percent, and keeps null axes null", () => {
    expect(capInAccountUnits(cap, 80)).toEqual({ ...cap, max_daily_budget_usd: 4000, max_daily_total_change_usd: 8000 });
    expect(capInAccountUnits({ ...cap, max_daily_total_change_usd: null }, 80).max_daily_total_change_usd).toBeNull();
    expect(capInAccountUnits(cap, 1)).toBe(cap);
  });

  it("refuses an unusable rate instead of producing a NaN cap that every amount passes", () => {
    for (const bad of [Number.NaN, 0, -80, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(() => capInAccountUnits(cap, bad)).toThrow(/Unusable exchange rate/);
    }
  });

  it("refuses ₹5,000/day under a $50 cap and allows ₹4,000, where the raw numbers would refuse both", () => {
    const inr = capInAccountUnits(cap, 80);
    const at = (proposed: number) =>
      evaluateBudgetCap({ proposed_daily_budget_usd: proposed, current_daily_budget_usd: 0, today_total_change_usd: 0, cap: inr });
    expect(at(5000)).toEqual({ within: false, reason: "over_absolute_ceiling" });
    expect(at(4000)).toEqual({ within: true });
  });

  it("converts the user-initiated bound, which has no daily axis", () => {
    const bound = { enabled: true as const, max_daily_budget_usd: 10_000, max_pct_change_per_run: 50 };
    expect(capInAccountUnits(bound, 80)).toEqual({ ...bound, max_daily_budget_usd: 800_000 });
  });
});

describe("a body in the wrong unit", () => {
  it("refuses a body whose currency is not the account's, and treats an absent one as USD", () => {
    expect(bodyCurrencyMismatch("INR", "INR")).toBeNull();
    expect(bodyCurrencyMismatch(undefined, "USD")).toBeNull();
    expect(bodyCurrencyMismatch(undefined, "INR")).toMatch(/^meta_ads_currency_mismatch: .*USD.*INR/);
    expect(bodyCurrencyMismatch("INR", "usd")).toMatch(/^meta_ads_currency_mismatch/);
  });
});

describe("display", () => {
  it("prints dollars exactly as before and rupees with Indian grouping", () => {
    expect(formatMoney(1000, "USD")).toBe("$1000");
    expect(formatMoney(12.5, undefined)).toBe("$12.5");
    expect(formatMoney(150000, "INR")).toBe("₹1,50,000");
  });
});

describe("approval card change rows carry the body currency", () => {
  it("shows an INR budget change in rupees and a USD one exactly as before", async () => {
    const { metaChangeRows } = await import("../_change-rows");
    const base = { ad_set_id: "123", daily_budget_usd: 3000, expected_current_daily_budget_usd: 2000, over_cap: false };
    const inr = metaChangeRows("meta_ads.update_ad_set_budget", { ...base, currency: "INR" });
    expect(inr?.rows[0]).toMatchObject({ before: "₹2,000/day", after: "₹3,000/day" });
    expect(inr?.change_sentence).not.toContain("$");
    const usd = metaChangeRows("meta_ads.update_ad_set_budget", base);
    expect(usd?.rows[0]).toMatchObject({ before: "$2,000/day", after: "$3,000/day" });
  });
});
