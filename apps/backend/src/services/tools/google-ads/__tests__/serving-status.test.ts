import { describe, it, expect } from "vitest";
import { servingReasonWords, servingWhy } from "../_serving-status";

describe("servingReasonWords / servingWhy", () => {
  it("known reasons in plain words, unknown ones readable, placeholders and repeats dropped", () => {
    expect(servingReasonWords(["HAS_ADS_DISAPPROVED", "UNSPECIFIED", "SOMETHING_NEW", "HAS_ADS_DISAPPROVED"])).toEqual(["its ads were disapproved", "something new"]);
  });
  it("no reason: Google's status is named, never a guessed cause", () => {
    expect(servingWhy({ primary_status: "NOT_ELIGIBLE", reasons: [] })).toBe("Google lists it as not eligible, with no reason given");
    expect(servingWhy({ primary_status: null, reasons: [] })).toBe("Google gave no reason");
    expect(servingWhy({ primary_status: "LIMITED", reasons: ["BUDGET_CONSTRAINED", "BIDDING_STRATEGY_LEARNING"] })).toBe("its budget is too small; its bid strategy is still learning");
  });
});
