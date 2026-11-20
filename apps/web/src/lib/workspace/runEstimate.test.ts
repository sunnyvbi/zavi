import { describe, it, expect } from "vitest";
import {
  creditBannerDismissSignature,
  creditBannerState,
  creditCellClass,
  creditMeterModel,
  creditPercentLeft,
  creditResetLine,
  isCreditBannerDismissible,
  MIN_RESERVE_ESTIMATE_CREDITS,
  reserveEstimateFor,
} from "./runEstimate";

const LOW = 0.1;

describe("creditBannerState (in-chat credit banner)", () => {
  it("depleted when remaining is below the cheapest reservable run — even if > 0", () => {
    expect(creditBannerState(50, 40000, LOW)).toBe("depleted");
    expect(creditBannerState(MIN_RESERVE_ESTIMATE_CREDITS - 1, 40000, LOW)).toBe("depleted");
    expect(creditBannerState(0, 40000, LOW)).toBe("depleted");
  });

  it("NOT depleted the moment the balance can afford the cheapest run", () => {
    expect(creditBannerState(MIN_RESERVE_ESTIMATE_CREDITS, 40000, LOW)).not.toBe("depleted");
  });

  it("low when spendable but within the 10% nudge band", () => {
    expect(creditBannerState(300, 40000, LOW)).toBe("low");
    expect(creditBannerState(4000, 40000, LOW)).toBe("low");
  });

  it("none when healthy", () => {
    expect(creditBannerState(4001, 40000, LOW)).toBe("none");
    expect(creditBannerState(40000, 40000, LOW)).toBe("none");
  });

  it("no overlap between low and depleted at the min-reserve boundary", () => {
    expect(creditBannerState(MIN_RESERVE_ESTIMATE_CREDITS, 40000, LOW)).toBe("low");
  });

  it("zero allowance never reports low (no meaningful denominator), only depleted/none", () => {
    expect(creditBannerState(500, 0, LOW)).toBe("none");
    expect(creditBannerState(10, 0, LOW)).toBe("depleted");
  });
});

describe("reserve-estimate mirror sanity", () => {
  it("MIN_RESERVE is the cheapest reserve anywhere, not the default", () => {
    expect(MIN_RESERVE_ESTIMATE_CREDITS).toBe(160);
    expect(MIN_RESERVE_ESTIMATE_CREDITS).toBeLessThan(reserveEstimateFor("some-unknown-slug"));
  });

  it("no agent can reserve less than MIN", () => {
    for (const slug of ["pm", "qa", "operator", "meta_ads", "engineer", "some-unknown-slug"]) {
      expect(reserveEstimateFor(slug)).toBeGreaterThanOrEqual(MIN_RESERVE_ESTIMATE_CREDITS);
    }
  });
  it("heavy agents stay above the min", () => {
    expect(reserveEstimateFor("engineer")).toBeGreaterThan(MIN_RESERVE_ESTIMATE_CREDITS);
  });
});

describe("creditCellClass (StatusBar credit cell color)", () => {
  it("coral (strong) when depleted — the P2 bug: 50 credits was neutral while the banner said 'out of credits'", () => {
    expect(creditCellClass(50, 80000)).toBe("text-coral");
    expect(creditCellClass(0, 80000)).toBe("text-coral");
    expect(creditCellClass(MIN_RESERVE_ESTIMATE_CREDITS - 1, 80000)).toBe("text-coral");
  });
  it("marigold (nudge) when low — spendable but ≤10% of the allowance", () => {
    expect(creditCellClass(4000, 80000)).toBe("text-marigoldDeep");
    expect(creditCellClass(8000, 80000)).toBe("text-marigoldDeep");
  });
  it("neutral (empty) when healthy — above 10%", () => {
    expect(creditCellClass(50000, 80000)).toBe("");
    expect(creditCellClass(8001, 80000)).toBe("");
  });
  it("depleted-only fallback when allowance is null/0 (pre-backend-deploy) — never suppresses the hard stop", () => {
    expect(creditCellClass(50, null)).toBe("text-coral");
    expect(creditCellClass(50, undefined)).toBe("text-coral");
    expect(creditCellClass(50000, null)).toBe("");
  });
});

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER_TENANT = "e0fe9ea8-0000-0000-0000-000000000000";
const AUG = "2026-08-01";
const SEP = "2026-09-01";

describe("isCreditBannerDismissible (SAFETY INVARIANT)", () => {
  it("depleted is NEVER dismissible — every send 402s, so the card is the only explanation", () => {
    expect(isCreditBannerDismissible("depleted")).toBe(false);
  });
  it("the two advisory states are dismissible", () => {
    expect(isCreditBannerDismissible("low")).toBe(true);
    expect(isCreditBannerDismissible("approaching")).toBe(true);
  });
  it("healthy renders nothing, so it is not dismissible either", () => {
    expect(isCreditBannerDismissible("none")).toBe(false);
  });
});

describe("creditBannerDismissSignature", () => {
  it("returns null for depleted — the invariant, enforced a second time at the persist layer", () => {
    expect(creditBannerDismissSignature("depleted", TENANT, AUG)).toBeNull();
    expect(creditBannerDismissSignature("none", TENANT, AUG)).toBeNull();
  });

  it("is stable for the same (state, tenant, period)", () => {
    expect(creditBannerDismissSignature("low", TENANT, AUG)).toBe(
      creditBannerDismissSignature("low", TENANT, AUG),
    );
  });

  it("ESCALATION resets: a dismissed 80% card must not suppress the low card", () => {
    const approaching = creditBannerDismissSignature("approaching", TENANT, AUG);
    const low = creditBannerDismissSignature("low", TENANT, AUG);
    expect(approaching).not.toBeNull();
    expect(approaching).not.toBe(low);
  });

  it("PERIOD ROLLOVER resets: last month's dismissal must not silence this month", () => {
    expect(creditBannerDismissSignature("low", TENANT, AUG)).not.toBe(
      creditBannerDismissSignature("low", TENANT, SEP),
    );
  });

  it("does not bleed across tenants", () => {
    expect(creditBannerDismissSignature("low", TENANT, AUG)).not.toBe(
      creditBannerDismissSignature("low", OTHER_TENANT, AUG),
    );
  });

  it("null period_end → null (never persist): a dismissal with no period would NEVER rotate back on", () => {
    expect(creditBannerDismissSignature("low", TENANT, null)).toBeNull();
    expect(creditBannerDismissSignature("approaching", TENANT, null)).toBeNull();
  });

  it("unresolved tenant (auth still hydrating) → null: nothing to key on, so don't persist", () => {
    expect(creditBannerDismissSignature("low", undefined, AUG)).toBeNull();
    expect(creditBannerDismissSignature("low", null, AUG)).toBeNull();
    expect(creditBannerDismissSignature("low", "", AUG)).toBeNull();
  });
});

describe("creditResetLine", () => {
  it("plural subject takes 'reset', is lowercase, and carries the preposition", () => {
    expect(creditResetLine("Aug 1")).toBe("Your credits reset on Aug 1.");
  });
});

describe("creditMeterModel", () => {
  it("no top-ups: total is the allowance and used + left === total", () => {
    const m = creditMeterModel(98_039, 300_000, 0, "none");
    expect(m.total).toBe(300_000);
    expect(m.pctLabel).toBe(33);
    expect(201_961 + 98_039).toBe(m.total);
  });

  it("topped-up tenant: purchased credits widen the denominator instead of pinning the bar full", () => {
    const m = creditMeterModel(50_000, 300_000, 50_000, "none");
    expect(m.total).toBe(350_000);
    expect(m.pctLabel).toBe(14);
    expect(m.fillPct).toBeLessThan(100);
  });

  it("never exceeds 100% even if remaining somehow outruns the pool", () => {
    const m = creditMeterModel(999_999, 1_000, 0, "none");
    expect(m.fillPct).toBe(100);
    expect(m.pctLabel).toBe(100);
  });

  it("depleted paints an EMPTY bar regardless of the residual balance", () => {
    const m = creditMeterModel(50, 300_000, 0, "depleted");
    expect(m.fillPct).toBe(0);
    expect(m.total).toBe(300_000);
  });

  it("low state still fills proportionally (the colour carries the warning, not the width)", () => {
    const m = creditMeterModel(15_000, 300_000, 0, "low");
    expect(m.pctLabel).toBe(5);
  });

  it("no pool at all → null pct label, never a fabricated 0%", () => {
    const m = creditMeterModel(0, 0, 0, "depleted");
    expect(m.total).toBe(0);
    expect(m.pctLabel).toBeNull();
    expect(m.fillPct).toBe(0);
  });

  it("purchased-only tenant gets a real denominator", () => {
    const m = creditMeterModel(500, 0, 500, "none");
    expect(m.total).toBe(500);
    expect(m.pctLabel).toBe(100);
  });

  it("negative inputs cannot inflate the pool", () => {
    const m = creditMeterModel(0, -5, -5, "depleted");
    expect(m.total).toBe(0);
    expect(m.pctLabel).toBeNull();
  });
});

describe("creditPercentLeft (the in-chat card's headline figure)", () => {
  it("is the share of the ALLOWANCE, so it agrees with the trigger", () => {
    expect(creditPercentLeft(30_000, 150_000)).toBe(20);
    expect(creditPercentLeft(15_000, 150_000)).toBe(10);
    expect(creditPercentLeft(150_000, 150_000)).toBe(100);
  });

  it("returns null when there is no allowance to divide by", () => {
    expect(creditPercentLeft(500, 0)).toBeNull();
    expect(creditPercentLeft(500, -1)).toBeNull();
    expect(creditPercentLeft(500, Number.NaN)).toBeNull();
  });

  it("floors a positive balance at 1%, but a zero balance really is 0", () => {
    expect(creditPercentLeft(1, 150_000)).toBe(1);
    expect(creditPercentLeft(0, 150_000)).toBe(0);
    expect(creditPercentLeft(-5, 150_000)).toBe(0);
  });

  it("clamps at 100", () => {
    expect(creditPercentLeft(300_000, 150_000)).toBe(100);
  });
});
