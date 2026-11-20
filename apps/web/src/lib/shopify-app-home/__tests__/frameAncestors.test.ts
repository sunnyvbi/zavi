import { describe, expect, it } from "vitest";
import { shopifyFrameAncestors } from "../frameAncestors";

describe("shopifyFrameAncestors", () => {
  it("allows Shopify to frame the data-free shell", () => {
    expect(shopifyFrameAncestors()).toBe("frame-ancestors https://admin.shopify.com https://*.myshopify.com");
  });

  it("never includes a caller-provided shop host", () => {
    expect(shopifyFrameAncestors()).toBe("frame-ancestors https://admin.shopify.com https://*.myshopify.com");
  });
});
