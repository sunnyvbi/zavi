import { describe, it, expect } from "vitest";
import { isStoreSource, managedElsewhereCopy, MANAGED_IN_SHOPIFY_COPY, MANAGED_IN_STORE_COPY, toSource, toSubscription } from "./billingSubscription";

const base = { tier: "growth", term: "monthly", status: "active", current_period_end: null };

describe("isStoreSource", () => {
  it("is true for every plan billed outside Stripe", () => {
    expect(isStoreSource("app_store")).toBe(true);
    expect(isStoreSource("play_store")).toBe(true);
    expect(isStoreSource("test_store")).toBe(true);
    expect(isStoreSource("shopify")).toBe(true);
  });
  it("is false for stripe, missing and unknown values", () => {
    expect(isStoreSource("stripe")).toBe(false);
    expect(isStoreSource(undefined)).toBe(false);
    expect(isStoreSource(null)).toBe(false);
    expect(isStoreSource("paypal")).toBe(false);
  });
});

describe("toSource", () => {
  it("treats a missing or unknown source as stripe", () => {
    expect(toSource(undefined)).toBe("stripe");
    expect(toSource(null)).toBe("stripe");
    expect(toSource("mystery")).toBe("stripe");
  });
  it("keeps a known store source", () => {
    expect(toSource("play_store")).toBe("play_store");
    expect(toSource("shopify")).toBe("shopify");
  });
});

describe("managedElsewhereCopy", () => {
  it("names Shopify for a Shopify plan and the stores otherwise", () => {
    expect(managedElsewhereCopy("shopify")).toBe(MANAGED_IN_SHOPIFY_COPY);
    expect(managedElsewhereCopy("app_store")).toBe(MANAGED_IN_STORE_COPY);
    expect(managedElsewhereCopy(undefined)).toBe(MANAGED_IN_STORE_COPY);
  });
});

describe("toSubscription source", () => {
  it("an older backend with no source reads as stripe", () => {
    const s = toSubscription(base);
    expect(s?.source).toBe("stripe");
    expect(isStoreSource(s?.source)).toBe(false);
  });
  it("parses a store plan with a null term and no scheduled change", () => {
    const s = toSubscription({ ...base, term: null, source: "app_store", scheduled_change: null });
    expect(s?.source).toBe("app_store");
    expect(s?.term).toBeNull();
    expect(s?.scheduledChange).toBeNull();
    expect(isStoreSource(s?.source)).toBe(true);
  });
});
