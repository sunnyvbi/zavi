
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import {
  BUSINESS_FEE_BPS,
  CREATOR_FEE_BPS,
  businessFeeCents,
  businessTotalCents,
  creatorFeeCents,
  creatorPayoutCents,
  feeBreakdown,
} from "@zavi/shared";
import {
  MAX_PRICE_CENTS,
  assertOrderFeesConsistent,
  computeCreatorFees,
} from "../order-fees";
import {
  CREATOR_PAYOUT_COUNTRIES,
  assertCreatorPayoutCountry,
  creatorPayoutCountrySupported,
} from "../payout-countries";

describe("computeCreatorFees", () => {
  it("splits the spec's worked example exactly ($150 -> 16500 / 12750 / 3750)", () => {
    const f = computeCreatorFees(15_000);
    expect(f.business_fee_cents).toBe(1_500);
    expect(f.business_total_cents).toBe(16_500);
    expect(f.creator_fee_cents).toBe(2_250);
    expect(f.creator_payout_cents).toBe(12_750);
    expect(f.zavi_gross_cents).toBe(3_750);
    expect(f.currency).toBe("usd");
  });

  const cases: Array<[number, number, number]> = [
    [1, 0, 0],
    [3, 0, 0],
    [5, 1, 1],
    [10, 1, 2],
    [15, 2, 2],
    [30, 3, 5],
    [333, 33, 50],
    [999, 100, 150],
    [1_005, 101, 151],
    [9_999, 1_000, 1_500],
    [15_000, 1_500, 2_250],
    [MAX_PRICE_CENTS, 1_000_000, 1_500_000],
  ];

  it.each(cases)("price %i cents -> business fee %i, creator fee %i", (price, bFee, cFee) => {
    const f = computeCreatorFees(price);
    expect(f.business_fee_cents).toBe(bFee);
    expect(f.creator_fee_cents).toBe(cFee);
    expect(f.business_total_cents).toBe(price + bFee);
    expect(f.creator_payout_cents).toBe(price - cFee);
    expect(f.zavi_gross_cents).toBe(bFee + cFee);
  });

  it("never pays a creator more than the price and never charges less than it", () => {
    for (let price = 1; price <= 2_000; price += 1) {
      const f = computeCreatorFees(price);
      expect(f.creator_payout_cents).toBeGreaterThan(0);
      expect(f.creator_payout_cents).toBeLessThanOrEqual(price);
      expect(f.business_total_cents).toBeGreaterThanOrEqual(price);
      expect(Number.isInteger(f.business_fee_cents)).toBe(true);
      expect(Number.isInteger(f.creator_fee_cents)).toBe(true);
    }
  });

  it("agrees with S5's original Math.round(bps) formula, cent for cent", () => {
    const s5 = (price: number, bps: number) => Math.round((price * bps) / 10_000);
    const probes = [
      ...Array.from({ length: 100_000 }, (_, i) => i + 1),
      999_999,
      1_000_000,
      1_000_005,
      9_999_995,
      MAX_PRICE_CENTS,
    ];
    for (const price of probes) {
      const f = computeCreatorFees(price);
      expect(f.business_fee_cents).toBe(s5(price, BUSINESS_FEE_BPS));
      expect(f.creator_fee_cents).toBe(s5(price, CREATOR_FEE_BPS));
    }
  });

  it("keeps the fee rates at the spec's 10% / 15%", () => {
    expect(BUSINESS_FEE_BPS).toBe(1000);
    expect(CREATOR_FEE_BPS).toBe(1500);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PRICE_CENTS + 1])(
    "refuses %s as a price",
    (bad) => {
      expect(() => computeCreatorFees(bad as number)).toThrowError(ExpectedToolError);
    },
  );
});

describe("assertOrderFeesConsistent (invariant 8)", () => {
  const order = {
    id: "o1",
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
  };

  it("passes an order whose stored fees match the rule", () => {
    expect(assertOrderFeesConsistent(order).business_total_cents).toBe(16_500);
  });

  it("refuses an order whose business fee drifted", () => {
    expect(() => assertOrderFeesConsistent({ ...order, business_fee_cents: 1_499 })).toThrowError(
      /do not match the fee rule/,
    );
  });

  it("refuses an order whose creator fee drifted", () => {
    expect(() => assertOrderFeesConsistent({ ...order, creator_fee_cents: 0 })).toThrowError(
      /do not match the fee rule/,
    );
  });
});

describe("payout-country gate (invariant 7)", () => {
  it("matches the SQL creator_payout_country_supported list exactly", () => {
    const sql = readFileSync(
      join(__dirname, "../../../../../../supabase/migrations/20260911200000_creator_network_s1.sql"),
      "utf8",
    );
    const body = sql.split("create or replace function creator_payout_country_supported")[1];
    expect(body).toBeTruthy();
    const arrayLiteral = body.slice(body.indexOf("array["), body.indexOf("]), false)"));
    const sqlCountries = new Set(
      Array.from(arrayLiteral.matchAll(/'([A-Z]{2})'/g)).map((m) => m[1]),
    );
    expect(sqlCountries.size).toBeGreaterThan(30);
    expect([...sqlCountries].sort()).toEqual([...CREATOR_PAYOUT_COUNTRIES].sort());
  });

  it.each(["US", "us", " ca ", "GB", "CH", "DE", "NO", "IS", "LI"])(
    "%s is inside Stripe's payout reach",
    (cc) => {
      expect(creatorPayoutCountrySupported(cc)).toBe(true);
      expect(() => assertCreatorPayoutCountry(cc)).not.toThrow();
    },
  );

  it.each(["IN", "NG", "BR", "AU", "JP", "", "ZZ"])("%s is outside it", (cc) => {
    expect(creatorPayoutCountrySupported(cc)).toBe(false);
    expect(() => assertCreatorPayoutCountry(cc)).toThrowError(
      /outside Stripe's payout reach/,
    );
  });

  it.each([null, undefined])("treats %s as unsupported (fail closed)", (cc) => {
    expect(creatorPayoutCountrySupported(cc)).toBe(false);
    expect(() => assertCreatorPayoutCountry(cc)).toThrow();
  });
});

describe("creator fee split (helper-level API, shared package)", () => {
  it("matches the spec's worked example: $150 package", () => {
    const price = 15000;
    expect(businessTotalCents(price)).toBe(16500);
    expect(creatorPayoutCents(price)).toBe(12750);
  });

  it("is 10% on the business side and 15% on the creator side", () => {
    expect(BUSINESS_FEE_BPS).toBe(1000);
    expect(CREATOR_FEE_BPS).toBe(1500);
    expect(businessFeeCents(10000)).toBe(1000);
    expect(creatorFeeCents(10000)).toBe(1500);
  });

  it("never produces a fractional cent", () => {
    for (let price = 1; price <= 2000; price += 1) {
      expect(Number.isInteger(businessFeeCents(price))).toBe(true);
      expect(Number.isInteger(creatorFeeCents(price))).toBe(true);
      expect(Number.isInteger(businessTotalCents(price))).toBe(true);
      expect(Number.isInteger(creatorPayoutCents(price))).toBe(true);
    }
  });

  it("the total is always price + fee, and the payout is always price - fee", () => {
    for (const price of [1, 7, 99, 333, 12345, 999999, 10_000_000]) {
      expect(businessTotalCents(price)).toBe(price + businessFeeCents(price));
      expect(creatorPayoutCents(price)).toBe(price - creatorFeeCents(price));
      expect(creatorPayoutCents(price)).toBeGreaterThanOrEqual(0);
    }
  });

  it("rounds half up, deterministically", () => {
    expect(businessFeeCents(5)).toBe(1);
    expect(creatorFeeCents(10)).toBe(2);
  });

  it("refuses anything that is not a whole number of cents", () => {
    expect(() => businessFeeCents(10.5)).toThrow(/integer number of cents/);
    expect(() => creatorFeeCents(-1)).toThrow(/integer number of cents/);
  });

  it("feeBreakdown reports one consistent set of numbers", () => {
    expect(feeBreakdown(15000)).toEqual({
      price_cents: 15000,
      business_fee_cents: 1500,
      business_total_cents: 16500,
      creator_fee_cents: 2250,
      creator_payout_cents: 12750,
    });
  });

  it("the order-level split agrees with the helper-level split", () => {
    for (const price of [1, 5, 99, 333, 1_005, 15_000, 999_999, MAX_PRICE_CENTS]) {
      const order = computeCreatorFees(price);
      expect(order.business_fee_cents).toBe(businessFeeCents(price));
      expect(order.creator_fee_cents).toBe(creatorFeeCents(price));
      expect(order.business_total_cents).toBe(businessTotalCents(price));
      expect(order.creator_payout_cents).toBe(creatorPayoutCents(price));
    }
  });
});

describe("one fee implementation only (invariant 8, by construction)", () => {
  it("has exactly one creators/fees source file in the repo", () => {
    const repoRoot = join(__dirname, "../../../../../..");
    const candidates = [
      "packages/shared/src/creators/fees.ts",
      "apps/backend/src/services/creators/fees.ts",
      "apps/web/src/lib/creator-fees.ts",
      "apps/web/src/lib/creators/fees.ts",
    ];
    const present = candidates.filter((p) => existsSync(join(repoRoot, p)));
    expect(present).toEqual(["packages/shared/src/creators/fees.ts"]);
  });

  it("order-fees.ts contains no fee arithmetic of its own", () => {
    const src = readFileSync(join(__dirname, "../order-fees.ts"), "utf8");
    expect(src).not.toMatch(/Math\.(round|floor|ceil)/);
    expect(src).not.toMatch(/10_?000\s*\)/);
    expect(src).toContain('from "@zavi/shared"');
  });
});
