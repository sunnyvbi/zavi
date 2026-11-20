
import { describe, it, expect } from "vitest";
import {
  creditsPerUsdFromBlob,
  creditsPerUsdRejection,
  creditTiersFromBlob,
  creditTiersRejection,
  patchTouchesPricing,
  pricingFromBlob,
  DEFAULT_CREDITS_PER_USD,
  DEFAULT_PRICING,
  MIN_CREDITS_PER_USD,
  MAX_CREDITS_PER_USD,
  MAX_TIER_CREDITS,
  type PricingConfig,
} from "../credit-rate";
import {
  SELF_SERVE_USD_RUNGS,
  POPULAR_USD_RUNG_INDEX,
  isSelfServeUsd,
  creditsForUsd,
  creditsForUsdCents,
  selfServeLadder,
  usdRungForCredits,
  stripeQuantityForUsd,
  selfServeUsdForCents,
  stripeCreditUnitAmountCents,
} from "../plans";

const rate = (n: number): PricingConfig => ({ creditsPerUsd: n, tiers: {} });
const volumes = (cfg: PricingConfig) => selfServeLadder(cfg).map((r) => r.credits);

const LEGACY_VOLUMES = [
  20_000, 30_000, 40_000, 80_000, 120_000, 160_000, 200_000, 300_000, 400_000,
  600_000, 800_000, 1_200_000, 1_600_000, 2_000_000, 3_000_000, 4_000_000,
  5_000_000, 6_000_000, 8_000_000, 10_000_000, 12_000_000,
];

describe("creditsPerUsdFromBlob", () => {
  it("reads a number", () => {
    expect(creditsPerUsdFromBlob({ credits_per_usd: 1000 })).toBe(1000);
  });

  it("reads a numeric string (the admin JSON editor can emit either)", () => {
    expect(creditsPerUsdFromBlob({ credits_per_usd: "1000" })).toBe(1000);
    expect(creditsPerUsdFromBlob({ credits_per_usd: " 1000 " })).toBe(1000);
  });

  it("floors a fractional rate — fractional credits do not exist", () => {
    expect(creditsPerUsdFromBlob({ credits_per_usd: 400.9 })).toBe(400);
  });

  it("returns null for absent / malformed / out-of-range values", () => {
    expect(creditsPerUsdFromBlob({})).toBeNull();
    expect(creditsPerUsdFromBlob(null)).toBeNull();
    expect(creditsPerUsdFromBlob({ credits_per_usd: "abc" })).toBeNull();
    expect(creditsPerUsdFromBlob({ credits_per_usd: 0 })).toBeNull();
    expect(creditsPerUsdFromBlob({ credits_per_usd: -5 })).toBeNull();
    expect(creditsPerUsdFromBlob({ credits_per_usd: MAX_CREDITS_PER_USD + 1 })).toBeNull();
  });

  it("accepts the range boundaries", () => {
    expect(creditsPerUsdFromBlob({ credits_per_usd: MIN_CREDITS_PER_USD })).toBe(MIN_CREDITS_PER_USD);
    expect(creditsPerUsdFromBlob({ credits_per_usd: MAX_CREDITS_PER_USD })).toBe(MAX_CREDITS_PER_USD);
  });
});

describe("creditsPerUsdRejection — the admin PATCH guard", () => {
  it("accepts a sane rate", () => {
    expect(creditsPerUsdRejection(1000)).toBeNull();
    expect(creditsPerUsdRejection("1000")).toBeNull();
  });

  it("rejects a rate that would sell dollars for nothing", () => {
    expect(creditsPerUsdRejection(0)).toBeTruthy();
    expect(creditsPerUsdRejection(-1)).toBeTruthy();
  });

  it("rejects a fat-fingered extra zero past the ceiling", () => {
    expect(creditsPerUsdRejection(10_000_000)).toBeTruthy();
  });

  it("rejects non-numeric junk", () => {
    expect(creditsPerUsdRejection("free")).toBeTruthy();
    expect(creditsPerUsdRejection(null)).toBeTruthy();
    expect(creditsPerUsdRejection({})).toBeTruthy();
  });
});

describe("the ladder at the DEFAULT rate is the legacy ladder (no-op guarantee)", () => {
  it("derives exactly the 21 legacy credit volumes", () => {
    expect(volumes(rate(DEFAULT_CREDITS_PER_USD))).toEqual(LEGACY_VOLUMES);
  });

  it("keeps $1,000 / 400,000 credits as the Popular rung", () => {
    expect(SELF_SERVE_USD_RUNGS[POPULAR_USD_RUNG_INDEX]).toBe(1000);
    expect(creditsForUsd(1000, rate(DEFAULT_CREDITS_PER_USD))).toBe(400_000);
  });

  it("keeps the $50 entry rung at 20,000 credits", () => {
    expect(creditsForUsd(50, rate(DEFAULT_CREDITS_PER_USD))).toBe(20_000);
  });

  it("charges the same Stripe quantity the credit-derived math used to", () => {
    for (let i = 0; i < SELF_SERVE_USD_RUNGS.length; i++) {
      expect(stripeQuantityForUsd(SELF_SERVE_USD_RUNGS[i])).toBe(LEGACY_VOLUMES[i] / 1000);
    }
  });
});

describe("changing the rate moves CREDITS, never the bill", () => {
  it("400 → 1000 gives 2.5x the credits for the same $50", () => {
    expect(creditsForUsd(50, rate(400))).toBe(20_000);
    expect(creditsForUsd(50, rate(1000))).toBe(50_000);
  });

  it("leaves the Stripe quantity (and therefore the charge) untouched", () => {
    expect(stripeQuantityForUsd(50)).toBe(20);
    expect(stripeQuantityForUsd(30_000)).toBe(12_000);
  });

  it("rerates the whole ladder", () => {
    expect(volumes(rate(1000))).toEqual(SELF_SERVE_USD_RUNGS.map((u) => u * 1000));
  });
});

describe("ladder trust boundary", () => {
  it("accepts only whole-dollar rungs on the ladder", () => {
    expect(isSelfServeUsd(50)).toBe(true);
    expect(isSelfServeUsd(30_000)).toBe(true);
    expect(isSelfServeUsd(51)).toBe(false);
    expect(isSelfServeUsd(49.99)).toBe(false);
    expect(isSelfServeUsd(0)).toBe(false);
    expect(isSelfServeUsd(-50)).toBe(false);
    expect(isSelfServeUsd("50")).toBe(false);
    expect(isSelfServeUsd(35_000)).toBe(false);
  });

  it("every rung divides cleanly into the Stripe unit price (no rounded bills)", () => {
    for (const usd of SELF_SERVE_USD_RUNGS) {
      const q = stripeQuantityForUsd(usd);
      expect(q).not.toBeNull();
      expect(Number.isInteger(q)).toBe(true);
      expect(q! * stripeCreditUnitAmountCents()).toBe(usd * 100);
    }
  });

  it("refuses an amount that isn't a whole multiple of the unit price", () => {
    expect(stripeQuantityForUsd(51)).toBeNull();
    expect(stripeQuantityForUsd(0)).toBeNull();
  });

  it("maps a paid CENT amount back to its rung, and rejects anything else", () => {
    expect(selfServeUsdForCents(5_000)).toBe(50);
    expect(selfServeUsdForCents(3_000_000)).toBe(30_000);
    expect(selfServeUsdForCents(4_999)).toBeNull();
    expect(selfServeUsdForCents(5_100)).toBeNull();
    expect(selfServeUsdForCents(0)).toBeNull();
    expect(selfServeUsdForCents(null)).toBeNull();
    expect(selfServeUsdForCents(5_000.5)).toBeNull();
  });
});

describe("legacy credit-volume posts from a pre-2026-09-09 web bundle", () => {
  it("resolves a legacy volume back to its dollar rung at the live rate", () => {
    expect(usdRungForCredits(20_000, rate(400))).toBe(50);
    expect(usdRungForCredits(400_000, rate(400))).toBe(1000);
    expect(usdRungForCredits(50_000, rate(1000))).toBe(50);
  });

  it("refuses a volume computed under a SUPERSEDED rate (clean 400, not a re-price)", () => {
    expect(usdRungForCredits(20_000, rate(1000))).toBeNull();
  });

  it("refuses junk", () => {
    expect(usdRungForCredits(12_345, rate(400))).toBeNull();
    expect(usdRungForCredits("20000", rate(400))).toBeNull();
    expect(usdRungForCredits(null, rate(400))).toBeNull();
  });
});

describe("credit_tiers — per-tier overrides", () => {
  it("an override wins for its rung and leaves every other rung on the rate", () => {
    const cfg: PricingConfig = { creditsPerUsd: 400, tiers: { 50: 25_000, 200: 150_000 } };
    expect(creditsForUsd(50, cfg)).toBe(25_000);
    expect(creditsForUsd(200, cfg)).toBe(150_000);
    expect(creditsForUsd(300, cfg)).toBe(120_000);
    expect(creditsForUsd(1000, cfg)).toBe(400_000);
  });

  it("a tier may be set to 0 (sold, grants nothing) without falling back to the rate", () => {
    expect(creditsForUsd(50, { creditsPerUsd: 400, tiers: { 50: 0 } })).toBe(0);
  });

  it("tiers ride through the whole ladder and the cents path alike", () => {
    const cfg: PricingConfig = { creditsPerUsd: 400, tiers: { 50: 25_000 } };
    expect(selfServeLadder(cfg)[0]).toEqual({ usd: 50, credits: 25_000 });
    expect(creditsForUsdCents(5_000, cfg)).toBe(25_000);
  });

  it("an OFF-ladder paid amount has no tier, so it falls back to the linear rate", () => {
    const cfg: PricingConfig = { creditsPerUsd: 400, tiers: { 50: 25_000 } };
    expect(creditsForUsdCents(5_250, cfg)).toBe(21_000);
  });
});

describe("creditTiersFromBlob", () => {
  it("reads numbers and numeric strings, keyed by dollar rung", () => {
    expect(creditTiersFromBlob({ credit_tiers: { "50": 25_000, "200": "150000" } })).toEqual({
      50: 25_000,
      200: 150_000,
    });
  });

  it("DROPS a malformed entry individually — one bad row must not reprice the rest", () => {
    expect(
      creditTiersFromBlob({
        credit_tiers: { "50": "abc", "200": -5, "300": 120_000, notanumber: 1 },
      }),
    ).toEqual({ 300: 120_000 });
  });

  it("returns an empty map for absent / non-object / array values", () => {
    expect(creditTiersFromBlob({})).toEqual({});
    expect(creditTiersFromBlob(null)).toEqual({});
    expect(creditTiersFromBlob({ credit_tiers: [1, 2] })).toEqual({});
    expect(creditTiersFromBlob({ credit_tiers: "nope" })).toEqual({});
  });

  it("rejects a tier above the int4 ceiling the SQL also guards", () => {
    expect(creditTiersFromBlob({ credit_tiers: { "50": MAX_TIER_CREDITS + 1 } })).toEqual({});
  });
});

describe("pricingFromBlob", () => {
  it("falls back to the historical defaults on an empty blob", () => {
    expect(pricingFromBlob({})).toEqual(DEFAULT_PRICING);
    expect(pricingFromBlob(null).creditsPerUsd).toBe(DEFAULT_CREDITS_PER_USD);
  });

  it("a bad rate does not discard good tiers, and vice versa", () => {
    expect(pricingFromBlob({ credits_per_usd: "junk", credit_tiers: { "50": 25_000 } })).toEqual({
      creditsPerUsd: DEFAULT_CREDITS_PER_USD,
      tiers: { 50: 25_000 },
    });
  });
});

describe("creditTiersRejection — the admin PATCH guard", () => {
  it("accepts a well-formed map, and null (clear all overrides)", () => {
    expect(creditTiersRejection({ "50": 25_000 })).toBeNull();
    expect(creditTiersRejection(null)).toBeNull();
  });

  it("rejects a non-object, a bad key, and a bad value", () => {
    expect(creditTiersRejection([1, 2])).toBeTruthy();
    expect(creditTiersRejection({ free: 100 })).toBeTruthy();
    expect(creditTiersRejection({ "50": "lots" })).toBeTruthy();
    expect(creditTiersRejection({ "50": -1 })).toBeTruthy();
    expect(creditTiersRejection({ "50": MAX_TIER_CREDITS + 1 })).toBeTruthy();
  });
});

describe("patchTouchesPricing — decides whether to run the mid-period resync", () => {
  it("fires for either pricing key", () => {
    expect(patchTouchesPricing({ credits_per_usd: 500 })).toBe(true);
    expect(patchTouchesPricing({ credit_tiers: {} })).toBe(true);
  });

  it("does not fire for unrelated config", () => {
    expect(patchTouchesPricing({ free_daily_credits: 5000 })).toBe(false);
    expect(patchTouchesPricing({})).toBe(false);
  });
});

describe("the webhook's paid-amount → credits derivation", () => {
  it("grants the legacy volume for the legacy billed amount at the default rate", () => {
    expect(creditsForUsdCents(20 * 250, rate(DEFAULT_CREDITS_PER_USD))).toBe(20_000);
    expect(creditsForUsdCents(400 * 250, rate(DEFAULT_CREDITS_PER_USD))).toBe(400_000);
  });

  it("follows the live rate for the same billed amount", () => {
    expect(creditsForUsdCents(20 * 250, rate(1000))).toBe(50_000);
  });
});
