import { describe, it, expect } from "vitest";
import { PRODUCT_BUILDER_VISUAL_BASELINE } from "../generic-dispatcher";

describe("PRODUCT_BUILDER_VISUAL_BASELINE", () => {
  it("frames user content as untrusted LENGTH that must never overflow the viewport", () => {
    expect(PRODUCT_BUILDER_VISUAL_BASELINE).toMatch(/untrusted LENGTH/);
    expect(PRODUCT_BUILDER_VISUAL_BASELINE).toMatch(/NEVER break, overflow the viewport, or push a horizontal scrollbar/);
  });

  it("prescribes the field-aware containment primitives (not blanket truncation)", () => {
    for (const primitive of ["truncate", "line-clamp-2", "break-words", "min-w-0"]) {
      expect(PRODUCT_BUILDER_VISUAL_BASELINE).toContain(primitive);
    }
    expect(PRODUCT_BUILDER_VISUAL_BASELINE).toMatch(/Flex\/grid children MUST set/);
    expect(PRODUCT_BUILDER_VISUAL_BASELINE).toMatch(/never hide a price, status, or quantity/i);
  });

  it("mandates a mobile (375px) pass and a concrete 200-char acceptance bar", () => {
    expect(PRODUCT_BUILDER_VISUAL_BASELINE).toMatch(/375px/);
    expect(PRODUCT_BUILDER_VISUAL_BASELINE).toMatch(/200-character/);
  });
});
