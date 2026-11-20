import { describe, it, expect } from "vitest";
import { connectionDataFor, normalizeShopSubdomain } from "../connection-data";

describe("normalizeShopSubdomain", () => {
  it("accepts the bare store name and strips a pasted myshopify URL down to it", () => {
    expect(normalizeShopSubdomain("zavi-test-store")).toBe("zavi-test-store");
    expect(normalizeShopSubdomain("  Zavi-Test-Store.myshopify.com ")).toBe("zavi-test-store");
    expect(normalizeShopSubdomain("https://zavi-test-store.myshopify.com/admin")).toBe("zavi-test-store");
  });
  it("rejects anything that is not a myshopify subdomain", () => {
    for (const bad of ["", "-lead", "a b", "acme.com", "x".repeat(101), 42, null, undefined]) {
      expect(normalizeShopSubdomain(bad)).toBeNull();
    }
  });
});

describe("connectionDataFor", () => {
  it("sends nothing for a toolkit with no per-account field", () => {
    expect(connectionDataFor("notion", { connection_data: { subdomain: "x" } })).toEqual({ ok: true, data: undefined });
  });
  it("names the missing field for shopify so the client can ask for it", () => {
    const r = connectionDataFor("shopify", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field.key).toBe("subdomain");
    expect(connectionDataFor("shopify", { connection_data: { subdomain: "bad name" } }).ok).toBe(false);
  });
  it("returns the normalized subdomain under the field key", () => {
    expect(connectionDataFor("shopify", { connection_data: { subdomain: "Zavi-Test-Store.myshopify.com" } })).toEqual({
      ok: true,
      data: { subdomain: "zavi-test-store" },
    });
  });
});
