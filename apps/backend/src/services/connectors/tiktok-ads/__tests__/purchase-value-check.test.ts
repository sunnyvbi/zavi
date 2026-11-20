import { describe, expect, it, vi } from "vitest";
import { checkedPurchaseValue } from "../composio-read";

const row = (value: number | null, count: number | null, per: number | null) => ({ total_complete_payment_rate: value, complete_payment: count, value_per_complete_payment: per });

describe("checkedPurchaseValue", () => {
  it("keeps the value when it agrees with count x value-per-purchase", () => {
    expect(checkedPurchaseValue(row(180.5, 2, 90.25), "a/c")).toBe(180.5);
    expect(checkedPurchaseValue(row(100, 3, 33.33), "a/c")).toBe(100);
  });
  it("a value that does not agree (e.g. it really is a rate) is unknown, and logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkedPurchaseValue(row(0.04, 2, 90.25), "a/c")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("purchase value check failed for a/c"));
    warn.mockRestore();
  });
  it("zero purchases: only a zero value stands", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkedPurchaseValue(row(0, 0, 0), "a/c")).toBe(0);
    expect(checkedPurchaseValue(row(12, 0, 0), "a/c")).toBeNull();
    warn.mockRestore();
  });
  it("a companion figure missing: unverified, so unknown", () => {
    expect(checkedPurchaseValue(row(50, 1, null), "a/c")).toBeNull();
    expect(checkedPurchaseValue(row(0.04, 2, null), "a/c")).toBeNull();
    expect(checkedPurchaseValue(row(50, null, 50), "a/c")).toBeNull();
  });
  it("a missing value stays unknown", () => {
    expect(checkedPurchaseValue(row(null, 2, 90), "a/c")).toBeNull();
  });
});
