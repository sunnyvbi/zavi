import { describe, it, expect } from "vitest";
import { DEFAULT_PRODUCT_BUILD_MAX_USD, MAX_PRODUCT_BUILD_MAX_USD } from "../start-product-build";

describe("build lifetime cap", () => {
  it("defaults to the hard ceiling, $50", () => {
    expect(DEFAULT_PRODUCT_BUILD_MAX_USD).toBe(50);
    expect(DEFAULT_PRODUCT_BUILD_MAX_USD).toBeLessThanOrEqual(MAX_PRODUCT_BUILD_MAX_USD);
  });
});
