import { describe, it, expect } from "vitest";
import { navLooksSideEffecting } from "../browser-action-gate";

describe("navLooksSideEffecting", () => {
  it("flags action-verb path segments", () => {
    for (const u of [
      "https://app.vendor.com/confirm",
      "https://app.vendor.com/confirm-email?token=abc",
      "https://app.vendor.com/account/delete",
      "https://app.vendor.com/unsubscribe",
      "https://app.vendor.com/billing/cancel_subscription",
      "https://app.vendor.com/approve/123",
      "https://app.vendor.com/pay",
      "https://app.vendor.com/checkout",
    ]) {
      expect(navLooksSideEffecting(u), u).toBe(true);
    }
  });

  it("flags action query keys", () => {
    for (const u of [
      "https://app.vendor.com/x?action=delete",
      "https://app.vendor.com/x?do=remove",
      "https://app.vendor.com/x?cmd=purge",
      "https://app.vendor.com/list?unsubscribe=1",
    ]) {
      expect(navLooksSideEffecting(u), u).toBe(true);
    }
  });

  it("does NOT flag ordinary navigation (no false positives)", () => {
    for (const u of [
      "https://app.vendor.com/",
      "https://app.vendor.com/dashboard",
      "https://app.vendor.com/confirmation",
      "https://app.vendor.com/reports/2026",
      "https://app.vendor.com/settings/profile",
      "https://www.linkedin.com/feed/",
      "https://app.vendor.com/search?q=deleted+files",
    ]) {
      expect(navLooksSideEffecting(u), u).toBe(false);
    }
  });

  it("returns false for an unparseable URL", () => {
    expect(navLooksSideEffecting("::::not a url")).toBe(false);
  });
});
