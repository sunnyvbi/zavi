import { describe, it, expect } from "vitest";
import {
  CREDIT_USD,
  costToCredits,
  creditsToUsd,
  reserveEstimateFor,
  DEFAULT_RESERVE_ESTIMATE_CREDITS,
  isInsufficientCreditsError,
  creditsEnforcedFromBlob,
  isHeavyDispatch,
  HEAVY_DISPATCH_THRESHOLD_CREDITS,
  CREDIT_SOFT_WARN_THRESHOLD,
  creditUsagePctUsed,
  shouldSoftWarnCredits,
} from "../credits";

describe("isInsufficientCreditsError", () => {
  it("matches the reserve_run_credits out-of-credits raise", () => {
    expect(isInsufficientCreditsError({ message: "insufficient_credits" })).toBe(true);
    expect(isInsufficientCreditsError({ message: 'new row ... raised exception "insufficient_credits"' })).toBe(true);
  });
  it("does not match other errors / nullish", () => {
    expect(isInsufficientCreditsError({ message: "permission denied" })).toBe(false);
    expect(isInsufficientCreditsError({ message: "" })).toBe(false);
    expect(isInsufficientCreditsError(null)).toBe(false);
    expect(isInsufficientCreditsError(undefined)).toBe(false);
    expect(isInsufficientCreditsError({})).toBe(false);
  });
});

describe("credits — cost→credit conversion (Viktor peg 1cr = $0.0025)", () => {
  it("pegs one credit at $0.0025", () => {
    expect(CREDIT_USD).toBe(0.0025);
  });

  it("converts real run cost to credits via ceil(cost/0.0025)", () => {
    expect(costToCredits(0.0025)).toBe(1);
    expect(costToCredits(0.005)).toBe(2);
    expect(costToCredits(0.36)).toBe(144);
    expect(costToCredits(0.87)).toBe(348);
    expect(costToCredits(5)).toBe(2000);
  });

  it("ALWAYS rounds up (a sub-credit run still costs 1 credit — never free)", () => {
    expect(costToCredits(0.0001)).toBe(1);
    expect(costToCredits(0.00251)).toBe(2);
  });

  it("debits 0 for non-positive / nullish cost (SQL refunds the hold instead)", () => {
    expect(costToCredits(0)).toBe(0);
    expect(costToCredits(-1)).toBe(0);
    expect(costToCredits(null)).toBe(0);
    expect(costToCredits(undefined)).toBe(0);
    expect(costToCredits(NaN)).toBe(0);
    expect(costToCredits(Infinity)).toBe(0);
  });

  it("creditsToUsd is the inverse peg, floored at 0", () => {
    expect(creditsToUsd(400)).toBeCloseTo(1.0, 10);
    expect(creditsToUsd(0)).toBe(0);
    expect(creditsToUsd(-5)).toBe(0);
  });
});

describe("credits — per-slug reserve estimate", () => {
  it("holds a large estimate for builds (engineer/product-builder)", () => {
    expect(reserveEstimateFor("engineer")).toBe(2000);
    expect(reserveEstimateFor("product-builder")).toBe(2400);
  });

  it("holds a small estimate for cheap ops/execution agents", () => {
    expect(reserveEstimateFor("operator")).toBe(160);
    expect(reserveEstimateFor("support-lead")).toBe(160);
  });

  it("falls back to the default for an unknown slug", () => {
    expect(reserveEstimateFor("some-new-agent")).toBe(DEFAULT_RESERVE_ESTIMATE_CREDITS);
  });

  it("never returns below 1", () => {
    expect(reserveEstimateFor("anything")).toBeGreaterThanOrEqual(1);
  });

  it("the engineer hold comfortably covers a typical build's settle (no overdraft)", () => {
    expect(reserveEstimateFor("engineer")).toBeGreaterThanOrEqual(costToCredits(5));
  });
});

describe("creditsEnforcedFromBlob — read-side mirror of SQL _credits_enforced(tenant)", () => {
  const T = "73db45ff-457e-4541-bc8f-bdb625390204";
  const OTHER = "00000000-0000-0000-0000-000000000001";

  it("inert: global off + empty/absent allowlist ⇒ false for any tenant", () => {
    expect(creditsEnforcedFromBlob(null, T)).toBe(false);
    expect(creditsEnforcedFromBlob({}, T)).toBe(false);
    expect(creditsEnforcedFromBlob({ credits_enforced: false }, T)).toBe(false);
    expect(creditsEnforcedFromBlob({ credits_enforced_allowlist: [] }, T)).toBe(false);
  });

  it("global flag on ⇒ true for every tenant", () => {
    expect(creditsEnforcedFromBlob({ credits_enforced: true }, T)).toBe(true);
    expect(creditsEnforcedFromBlob({ credits_enforced: true, credits_enforced_allowlist: [] }, OTHER)).toBe(true);
  });

  it("canary: tenant in allowlist ⇒ true (this is the read/write parity the migration adds)", () => {
    expect(creditsEnforcedFromBlob({ credits_enforced: false, credits_enforced_allowlist: [T] }, T)).toBe(true);
  });

  it("canary is tenant-scoped: a tenant NOT in the allowlist stays false", () => {
    expect(creditsEnforcedFromBlob({ credits_enforced: false, credits_enforced_allowlist: [T] }, OTHER)).toBe(false);
  });

  it("defensive: a malformed (non-array) allowlist never throws and reads false", () => {
    expect(creditsEnforcedFromBlob({ credits_enforced_allowlist: "oops" as unknown }, T)).toBe(false);
    expect(creditsEnforcedFromBlob({ credits_enforced_allowlist: { [T]: true } as unknown }, T)).toBe(false);
  });
});

describe("isHeavyDispatch — heavy-build confirmation threshold (>=1000cr)", () => {
  it("threshold is 1000 credits", () => {
    expect(HEAVY_DISPATCH_THRESHOLD_CREDITS).toBe(1000);
  });

  it("TRUE for the two expensive build agents", () => {
    expect(isHeavyDispatch("engineer")).toBe(true);
    expect(isHeavyDispatch("product-builder")).toBe(true);
  });

  it("FALSE for the rest of the fleet (all <= 500cr)", () => {
    for (const slug of [
      "operator",
      "pm",
      "support-lead",
      "dispute-response",
      "chief-of-staff",
      "qa",
      "performance-marketer",
      "growth-lead",
      "research",
      "advisor",
      "fundraising",
    ]) {
      expect(isHeavyDispatch(slug), slug).toBe(false);
    }
  });

  it("FALSE for an unknown slug (default reserve 160)", () => {
    expect(isHeavyDispatch("some-unknown-agent")).toBe(false);
  });
});

describe("Move 14 — low-spendable-credits soft-warn (warning-only)", () => {
  it("threshold constant is 0.8 (warn at ≤20% of allowance spendable)", () => {
    expect(CREDIT_SOFT_WARN_THRESHOLD).toBe(0.8);
  });

  describe("creditUsagePctUsed — pure fraction used", () => {
    it("computes used / allowance", () => {
      expect(creditUsagePctUsed(40000, 32000)).toBeCloseTo(0.8, 10);
      expect(creditUsagePctUsed(40000, 31600)).toBeCloseTo(0.79, 10);
      expect(creditUsagePctUsed(80000, 80000)).toBe(1);
    });
    it("floors used at 0 and guards a zero/negative/non-finite allowance", () => {
      expect(creditUsagePctUsed(40000, -5)).toBe(0);
      expect(creditUsagePctUsed(0, 100)).toBe(0);
      expect(creditUsagePctUsed(-1, 100)).toBe(0);
      expect(creditUsagePctUsed(Number.NaN, 100)).toBe(0);
      expect(creditUsagePctUsed(Infinity, 100)).toBe(0);
    });
    it("can exceed 1 when included_used overran the allowance", () => {
      expect(creditUsagePctUsed(40000, 44000)).toBeCloseTo(1.1, 10);
    });
  });

  describe("shouldSoftWarnCredits — spendability warn + all three gates", () => {
    const ON = { enforced: true, flagEnabled: true };

    it("topped-up wallet (healthy effective) ⇒ NO warn even at 80% included used", () => {
      const { pct_used, warn } = shouldSoftWarnCredits({
        allowance: 40000,
        used: 32000,
        effectiveAvailable: 40643,
        ...ON,
      });
      expect(pct_used).toBeCloseTo(0.8, 10);
      expect(warn).toBe(false);
    });

    it("just above the 20%-remaining boundary ⇒ NO warn", () => {
      const { warn } = shouldSoftWarnCredits({ allowance: 40000, used: 32000, effectiveAvailable: 8001, ...ON });
      expect(warn).toBe(false);
    });

    it("at the 20%-remaining boundary ⇒ warn (inclusive, matches LOW's ≤)", () => {
      const { warn } = shouldSoftWarnCredits({ allowance: 40000, used: 32000, effectiveAvailable: 8000, ...ON });
      expect(warn).toBe(true);
    });

    it("overdrawn (negative effective) ⇒ warn (raw signed value, not floored)", () => {
      const { warn } = shouldSoftWarnCredits({ allowance: 40000, used: 40000, effectiveAvailable: -50, ...ON });
      expect(warn).toBe(true);
    });

    it("flag OFF ⇒ NO warn surfaced even when spendable is depleted", () => {
      const { warn } = shouldSoftWarnCredits({
        allowance: 40000,
        used: 40000,
        effectiveAvailable: 0,
        enforced: true,
        flagEnabled: false,
      });
      expect(warn).toBe(false);
    });

    it("credits NOT enforced ⇒ NO warn even with the flag on and spendable low", () => {
      const { warn } = shouldSoftWarnCredits({
        allowance: 40000,
        used: 39000,
        effectiveAvailable: 1000,
        enforced: false,
        flagEnabled: true,
      });
      expect(warn).toBe(false);
    });

    it("zero allowance ⇒ NO warn (no denominator band, no divide-by-zero)", () => {
      const { warn } = shouldSoftWarnCredits({ allowance: 0, used: 0, effectiveAvailable: 0, ...ON });
      expect(warn).toBe(false);
    });

    it("still returns included-usage pct_used for display when it does not warn (flag OFF)", () => {
      const { pct_used, warn } = shouldSoftWarnCredits({
        allowance: 40000,
        used: 36000,
        effectiveAvailable: 100,
        enforced: true,
        flagEnabled: false,
      });
      expect(pct_used).toBeCloseTo(0.9, 10);
      expect(warn).toBe(false);
    });

    it("is tenant-scoped: one tenant's warn never bleeds into another's decision", () => {
      const tenantA = shouldSoftWarnCredits({ allowance: 40000, used: 38000, effectiveAvailable: 5000, enforced: true, flagEnabled: true });
      const tenantB = shouldSoftWarnCredits({ allowance: 40000, used: 38000, effectiveAvailable: 5000, enforced: true, flagEnabled: false });
      expect(tenantA.warn).toBe(true);
      expect(tenantB.warn).toBe(false);
    });
  });
});
