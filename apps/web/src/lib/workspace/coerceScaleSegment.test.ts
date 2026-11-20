
import { describe, it, expect } from "vitest";
import { coerceScaleSegment } from "./useBuildProduct";

describe("coerceScaleSegment", () => {
  it("passes the four known bands through unchanged", () => {
    expect(coerceScaleSegment("pre_revenue")).toBe("pre_revenue");
    expect(coerceScaleSegment("early")).toBe("early");
    expect(coerceScaleSegment("scaling")).toBe("scaling");
    expect(coerceScaleSegment("mature")).toBe("mature");
  });

  it("maps unset / unknown / wrong-typed values to '' (neutral)", () => {
    expect(coerceScaleSegment("")).toBe("");
    expect(coerceScaleSegment(null)).toBe("");
    expect(coerceScaleSegment(undefined)).toBe("");
    expect(coerceScaleSegment("enterprise")).toBe("");
    expect(coerceScaleSegment(3)).toBe("");
    expect(coerceScaleSegment({ scaling: true })).toBe("");
  });
});
