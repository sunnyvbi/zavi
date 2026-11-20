
import { describe, it, expect } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import {
  toBudgetMinorUnits,
  detectCbo,
  assertNoNameCollision,
  assertGraphWriteSucceeded,
} from "../_helpers";

describe("assertGraphWriteSucceeded", () => {
  it("accepts {success:true}", () => {
    expect(() => assertGraphWriteSucceeded({ success: true }, "budget update")).not.toThrow();
  });
  it("accepts a body that echoes an id (no success field)", () => {
    expect(() => assertGraphWriteSucceeded({ id: "123" }, "status change")).not.toThrow();
  });
  it("THROWS on {success:false} (200 with a failed write — the dangerous no-op)", () => {
    expect(() => assertGraphWriteSucceeded({ success: false }, "budget update")).toThrow(
      ExpectedToolError,
    );
  });
  it("THROWS on an {error} envelope", () => {
    expect(() =>
      assertGraphWriteSucceeded({ error: { message: "bad", code: 100 } }, "status change"),
    ).toThrow(ExpectedToolError);
  });
  it("THROWS on an unexpected response with no success/id confirmation", () => {
    expect(() => assertGraphWriteSucceeded({}, "budget update")).toThrow(ExpectedToolError);
    expect(() => assertGraphWriteSucceeded(null, "budget update")).toThrow(ExpectedToolError);
    expect(() => assertGraphWriteSucceeded("ok", "budget update")).toThrow(ExpectedToolError);
  });
});

describe("toBudgetMinorUnits", () => {
  it("converts whole USD to integer cents", () => {
    expect(toBudgetMinorUnits(5, "USD")).toBe(500);
  });

  it("converts fractional USD to cents", () => {
    expect(toBudgetMinorUnits(12.34, "USD")).toBe(1234);
    expect(toBudgetMinorUnits(0.1, "USD")).toBe(10);
  });

  it("normalizes lowercase currency code", () => {
    expect(toBudgetMinorUnits(5, "usd")).toBe(500);
  });

  it("converts INR to integer paise", () => {
    expect(toBudgetMinorUnits(1500, "INR")).toBe(150000);
    expect(toBudgetMinorUnits(99.5, "inr")).toBe(9950);
  });

  it("rejects a currency whose minor-unit scale is not verified", () => {
    try {
      toBudgetMinorUnits(5, "EUR");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectedToolError);
      expect((e as ExpectedToolError).code).toBe("meta_ads_unsupported_currency");
    }
  });

  it("rejects zero / negative / non-finite amounts", () => {
    for (const bad of [0, -5, NaN, Infinity, -Infinity]) {
      try {
        toBudgetMinorUnits(bad, "USD");
        throw new Error(`should have thrown for ${bad}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ExpectedToolError);
        expect((e as ExpectedToolError).code).toBe("meta_ads_invalid_budget");
      }
    }
  });
});

describe("detectCbo", () => {
  it("is true when the campaign carries a daily budget", () => {
    expect(detectCbo({ daily_budget: "5000" })).toBe(true);
  });

  it("is true when the campaign carries a lifetime budget", () => {
    expect(detectCbo({ lifetime_budget: "100000" })).toBe(true);
  });

  it("is false when no campaign-level budget is set", () => {
    expect(detectCbo({})).toBe(false);
    expect(detectCbo({ daily_budget: "0" })).toBe(false);
    expect(detectCbo({ daily_budget: null })).toBe(false);
    expect(detectCbo({ daily_budget: undefined })).toBe(false);
  });
});

describe("assertNoNameCollision", () => {
  it("passes when the name is unused", () => {
    expect(() => assertNoNameCollision(["Alpha", "Beta"], "Gamma")).not.toThrow();
  });

  it("throws on an exact collision", () => {
    try {
      assertNoNameCollision(["Alpha", "Beta"], "Alpha");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectedToolError);
      expect((e as ExpectedToolError).code).toBe("meta_ads_adset_name_exists");
    }
  });

  it("throws on a case-insensitive / whitespace collision", () => {
    expect(() => assertNoNameCollision(["a b"], "A B")).toThrow(ExpectedToolError);
    expect(() => assertNoNameCollision([" Foo "], "foo")).toThrow(ExpectedToolError);
  });
});
