
import { describe, it, expect } from "vitest";
import {
  isStoreSource,
  sourceForStore,
  storeStateForEvent,
  tierForStoreProduct,
} from "../store-rail";

describe("tierForStoreProduct", () => {
  it("maps every sellable product", () => {
    expect(tierForStoreProduct("zavi_starter_monthly")).toBe("starter");
    expect(tierForStoreProduct("zavi_growth_monthly")).toBe("growth");
    expect(tierForStoreProduct("zavi_pro_monthly")).toBe("pro");
    expect(tierForStoreProduct("zavi_starter_6mo")).toBe("starter");
    expect(tierForStoreProduct("zavi_growth_6mo")).toBe("growth");
    expect(tierForStoreProduct("zavi_pro_6mo")).toBe("pro");
  });

  it("accepts Google's subscription:basePlan form", () => {
    expect(tierForStoreProduct("zavi_growth_monthly:monthly")).toBe("growth");
    expect(tierForStoreProduct("zavi_pro_6mo:6mo")).toBe("pro");
  });

  it("refuses anything else", () => {
    expect(tierForStoreProduct("zavi_free_monthly")).toBeNull();
    expect(tierForStoreProduct("zavi_starter_yearly")).toBeNull();
    expect(tierForStoreProduct("other_starter_monthly")).toBeNull();
    expect(tierForStoreProduct("")).toBeNull();
    expect(tierForStoreProduct(undefined)).toBeNull();
    expect(tierForStoreProduct(42)).toBeNull();
  });
});

describe("sources", () => {
  it("maps the stores RevenueCat names", () => {
    expect(sourceForStore("APP_STORE")).toBe("app_store");
    expect(sourceForStore("PLAY_STORE")).toBe("play_store");
    expect(sourceForStore("TEST_STORE")).toBe("test_store");
  });

  it("ignores every other store", () => {
    for (const s of ["STRIPE", "AMAZON", "PADDLE", "RC_BILLING", "PROMOTIONAL", "ROKU", undefined]) {
      expect(sourceForStore(s)).toBeNull();
    }
  });

  it("recognises store sources but not stripe", () => {
    expect(isStoreSource("app_store")).toBe(true);
    expect(isStoreSource("play_store")).toBe(true);
    expect(isStoreSource("test_store")).toBe(true);
    expect(isStoreSource("stripe")).toBe(false);
    expect(isStoreSource(null)).toBe(false);
  });
});

describe("storeStateForEvent", () => {
  const END = Date.UTC(2026, 9, 24, 12, 0, 0);
  const base = { product_id: "zavi_growth_monthly", expiration_at_ms: END };

  it.each(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "SUBSCRIPTION_EXTENDED", "REFUND_REVERSED"])(
    "%s gives an active plan with the product's tier",
    (type) => {
      expect(storeStateForEvent({ type, ...base })).toEqual({
        kind: "state",
        tier: "growth",
        status: "active",
        cancelAtPeriodEnd: false,
        periodEnd: new Date(END).toISOString(),
        refund: false,
        refundReversed: type === "REFUND_REVERSED",
      });
    },
  );

  it("an expired REFUND_REVERSED restores no plan", () => {
    const s = storeStateForEvent({ type: "REFUND_REVERSED", ...base, event_timestamp_ms: END + 1 });
    expect(s).toMatchObject({ kind: "state", tier: null, status: "canceled", refundReversed: true });
  });

  it("only REFUND_REVERSED lifts a refund block", () => {
    expect(storeStateForEvent({ type: "REFUND_REVERSED", ...base })).toMatchObject({ refundReversed: true });
    expect(storeStateForEvent({ type: "RENEWAL", ...base })).toMatchObject({ refundReversed: false });
    expect(storeStateForEvent({ type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT", ...base })).toMatchObject({
      refundReversed: false,
    });
  });

  it("treats a trial period as trialing", () => {
    const s = storeStateForEvent({ type: "INITIAL_PURCHASE", period_type: "TRIAL", ...base });
    expect(s).toMatchObject({ kind: "state", status: "trialing" });
  });

  it("CANCELLATION keeps the plan until it expires", () => {
    const s = storeStateForEvent({ type: "CANCELLATION", cancel_reason: "UNSUBSCRIBE", ...base });
    expect(s).toMatchObject({ kind: "state", tier: "growth", status: "active", cancelAtPeriodEnd: true, refund: false });
  });

  it("CANCELLATION for customer support is a refund", () => {
    const s = storeStateForEvent({ type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT", ...base });
    expect(s).toMatchObject({ kind: "state", refund: true });
  });

  it("BILLING_ISSUE is past_due and keeps the tier", () => {
    const s = storeStateForEvent({ type: "BILLING_ISSUE", ...base });
    expect(s).toMatchObject({ kind: "state", tier: "growth", status: "past_due", cancelAtPeriodEnd: false });
  });

  it("EXPIRATION returns the workspace to free without needing a product", () => {
    const s = storeStateForEvent({ type: "EXPIRATION", expiration_at_ms: END });
    expect(s).toMatchObject({ kind: "state", tier: null, status: "canceled", cancelAtPeriodEnd: false });
  });

  it("PRODUCT_CHANGE is informational only", () => {
    expect(storeStateForEvent({ type: "PRODUCT_CHANGE", ...base })).toEqual({ kind: "ignore", reason: "PRODUCT_CHANGE" });
  });

  it.each(["TRANSFER", "SUBSCRIPTION_PAUSED", "NON_RENEWING_PURCHASE", "INVOICE_ISSUANCE"])("ignores %s", (type) => {
    expect(storeStateForEvent({ type, ...base })).toMatchObject({ kind: "ignore" });
  });

  it("reports a product it cannot map", () => {
    expect(storeStateForEvent({ type: "RENEWAL", product_id: "mystery" })).toEqual({ kind: "unknown_product" });
  });

  it("a missing expiry leaves the period end empty", () => {
    const s = storeStateForEvent({ type: "RENEWAL", product_id: "zavi_pro_monthly" });
    expect(s).toMatchObject({ kind: "state", periodEnd: null });
  });
});
