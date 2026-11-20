
import { describe, it, expect } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import { assertNoBudgetDrift } from "../_drift-guard";

describe("assertNoBudgetDrift", () => {
  it("passes when expected matches live exactly", () => {
    expect(() => assertNoBudgetDrift(2500, 2500)).not.toThrow();
  });

  it("throws when live has drifted upward", () => {
    try {
      assertNoBudgetDrift(2500, 2600);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectedToolError);
      expect((e as ExpectedToolError).code).toBe("meta_ads_budget_drift");
    }
  });

  it("throws when live has drifted downward", () => {
    expect(() => assertNoBudgetDrift(2500, 2000)).toThrow(ExpectedToolError);
  });

  it("throws when live is zero / unset", () => {
    expect(() => assertNoBudgetDrift(2500, 0)).toThrow(ExpectedToolError);
  });
});
