import { describe, it, expect } from "vitest";

import {
  DEFAULT_BUILDER_CAPS,
  OPERATOR_OPT_IN_BUILDER_CAPS,
  PRODUCT_BUILD_BUILDER_CAPS,
} from "../from-sandbox-fs";

describe("builder cap tiers (Devin-parity default raise)", () => {
  it("DEFAULT tier = 5000 lines / 512KB / 2MB (the new every-tenant default)", () => {
    expect(DEFAULT_BUILDER_CAPS.maxChangedLines).toBe(5000);
    expect(DEFAULT_BUILDER_CAPS.diffByteCap).toBe(512 * 1024);
    expect(DEFAULT_BUILDER_CAPS.maxPostImageBytes).toBe(2 * 1024 * 1024);
  });

  it("OPERATOR_OPT_IN tier = XL 15000 lines / 1MB / 4MB (allowlist lever)", () => {
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.maxChangedLines).toBe(15_000);
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.diffByteCap).toBe(1024 * 1024);
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.maxPostImageBytes).toBe(4 * 1024 * 1024);
  });

  it("tier ordering holds: DEFAULT < OPERATOR_OPT_IN < PRODUCT_BUILD on every dimension", () => {
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.maxChangedLines).toBeGreaterThan(
      DEFAULT_BUILDER_CAPS.maxChangedLines,
    );
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.diffByteCap).toBeGreaterThan(
      DEFAULT_BUILDER_CAPS.diffByteCap,
    );
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.maxPostImageBytes).toBeGreaterThan(
      DEFAULT_BUILDER_CAPS.maxPostImageBytes,
    );
    expect(PRODUCT_BUILD_BUILDER_CAPS.maxChangedLines).toBeGreaterThan(
      OPERATOR_OPT_IN_BUILDER_CAPS.maxChangedLines,
    );
    expect(PRODUCT_BUILD_BUILDER_CAPS.diffByteCap).toBeGreaterThan(
      OPERATOR_OPT_IN_BUILDER_CAPS.diffByteCap,
    );
    expect(PRODUCT_BUILD_BUILDER_CAPS.maxPostImageBytes).toBeGreaterThan(
      OPERATOR_OPT_IN_BUILDER_CAPS.maxPostImageBytes,
    );
  });
});
