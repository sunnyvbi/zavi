import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE } from "../generic-dispatcher";

describe("PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE", () => {
  it("requires uploaded and public assets to bypass the dynamic image optimizer", () => {
    expect(PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE).toMatch(/uploaded|public\//i);
    expect(PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE).toContain("unoptimized");
    expect(PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE).toContain("/_next/image");
    expect(PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE).toMatch(/cold/i);
  });

  it("covers both new builds and later refines", () => {
    const src = readFileSync(join(__dirname, "..", "generic-dispatcher.ts"), "utf8");
    const injections = src.match(/\$\{PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE\}/g) ?? [];
    expect(injections).toHaveLength(2);
  });
});
