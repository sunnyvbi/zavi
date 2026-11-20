
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  tierForPriceId,
  tierPriceId,
  packTierForUsd,
  packTierForCents,
  billingConfigured,
} from "../plans";

const KEYS = [
  "STRIPE_PLATFORM_SECRET_KEY",
  "STRIPE_PRICE_STARTER_MONTHLY", "STRIPE_PRICE_GROWTH_MONTHLY", "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_STARTER_6MO", "STRIPE_PRICE_GROWTH_6MO", "STRIPE_PRICE_PRO_6MO",
  "STRIPE_PRICE_CREDITS_UNIT",
  "STRIPE_PRICE_SOLO_MONTHLY", "STRIPE_PRICE_SOLO_ANNUAL",
  "STRIPE_PRICE_TEAM_MONTHLY", "STRIPE_PRICE_TEAM_ANNUAL",
  "STRIPE_PRICE_FULL_MONTHLY", "STRIPE_PRICE_FULL_ANNUAL",
];
const saved: Record<string, string | undefined> = {};

function setTiers() {
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_s";
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_g";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_p";
}

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("tierForPriceId", () => {
  it("maps each configured tier price back to its tier", () => {
    setTiers();
    expect(tierForPriceId("price_s")).toBe("starter");
    expect(tierForPriceId("price_g")).toBe("growth");
    expect(tierForPriceId("price_p")).toBe("pro");
    expect(tierPriceId("pro")).toBe("price_p");
  });

  it("maps a six-month price back to the same tier as its monthly one", () => {
    setTiers();
    process.env.STRIPE_PRICE_STARTER_6MO = "price_s6";
    process.env.STRIPE_PRICE_GROWTH_6MO = "price_g6";
    process.env.STRIPE_PRICE_PRO_6MO = "price_p6";
    expect(tierForPriceId("price_s6")).toBe("starter");
    expect(tierForPriceId("price_g6")).toBe("growth");
    expect(tierForPriceId("price_p6")).toBe("pro");
    expect(tierPriceId("pro", "6mo")).toBe("price_p6");
  });

  it("unknown / empty / unset prices map to null", () => {
    setTiers();
    expect(tierForPriceId("price_other")).toBeNull();
    expect(tierForPriceId(undefined)).toBeNull();
    expect(tierForPriceId("")).toBeNull();
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    expect(tierForPriceId("price_p")).toBeNull();
  });

  it("a blank env var never matches", () => {
    process.env.STRIPE_PRICE_STARTER_MONTHLY = "  ";
    expect(tierPriceId("starter")).toBeNull();
    expect(tierForPriceId("  ")).toBeNull();
  });
});

describe("top-up packs", () => {
  it("maps 20/120/240 to starter/growth/pro", () => {
    expect(packTierForUsd(20)).toBe("starter");
    expect(packTierForUsd(120)).toBe("growth");
    expect(packTierForUsd(240)).toBe("pro");
    expect(packTierForCents(2000)).toBe("starter");
    expect(packTierForCents(12000)).toBe("growth");
    expect(packTierForCents(24000)).toBe("pro");
  });

  it.each([50, 0, -20, 20.5, "20", null, undefined, 1000])("rejects non-pack usd %s", (v) => {
    expect(packTierForUsd(v)).toBeNull();
  });

  it.each([5000, 2001, 1999, 0, -2000, 20, "2000", null])("rejects non-pack cents %s", (v) => {
    expect(packTierForCents(v)).toBeNull();
  });
});

describe("billingConfigured", () => {
  it("false without the platform key even with all prices", () => {
    setTiers();
    expect(billingConfigured()).toBe(false);
  });

  it("true with key + all three tier prices", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    setTiers();
    expect(billingConfigured()).toBe(true);
  });

  it("false with key + only some tier prices and no legacy unit price", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_s";
    process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_g";
    expect(billingConfigured()).toBe(false);
  });

  it("true with key + legacy unit price only (dogfood sub)", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_unit";
    expect(billingConfigured()).toBe(true);
  });

  it("legacy team price alone no longer configures billing", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team";
    expect(billingConfigured()).toBe(false);
  });

  it("false when two tier prices share an ID", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    setTiers();
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_g";
    expect(billingConfigured()).toBe(false);
  });

  it("false when a six-month price reuses another tier's monthly ID", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    setTiers();
    process.env.STRIPE_PRICE_PRO_6MO = "price_s";
    expect(billingConfigured()).toBe(false);
  });

  it("false when a tier price duplicates the unit price", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    setTiers();
    process.env.STRIPE_PRICE_CREDITS_UNIT = "price_s";
    expect(billingConfigured()).toBe(false);
  });

  it("false when a tier price duplicates a legacy plan price", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_x";
    setTiers();
    process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_p";
    expect(billingConfigured()).toBe(false);
  });
});
