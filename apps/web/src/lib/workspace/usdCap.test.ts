
import { describe, it, expect } from "vitest";
import { validateOptionalUsd } from "./usdCap";

describe("validateOptionalUsd", () => {
  it("treats blank (incl. whitespace) as an intentional clear → value null", () => {
    expect(validateOptionalUsd("")).toEqual({ ok: true, value: null });
    expect(validateOptionalUsd("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts finite numbers ≥ 0, including decimals and zero", () => {
    expect(validateOptionalUsd("0")).toEqual({ ok: true, value: 0 });
    expect(validateOptionalUsd("0.01")).toEqual({ ok: true, value: 0.01 });
    expect(validateOptionalUsd("1000.50")).toEqual({ ok: true, value: 1000.5 });
    expect(validateOptionalUsd("  25  ")).toEqual({ ok: true, value: 25 });
  });

  it("rejects negatives, non-numerics, and partial-numeric junk", () => {
    expect(validateOptionalUsd("-5")).toEqual({ ok: false });
    expect(validateOptionalUsd("abc")).toEqual({ ok: false });
    expect(validateOptionalUsd("5abc")).toEqual({ ok: false });
    expect(validateOptionalUsd("Infinity")).toEqual({ ok: false });
    expect(validateOptionalUsd("NaN")).toEqual({ ok: false });
  });
});
