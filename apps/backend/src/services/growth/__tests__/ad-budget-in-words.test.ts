import { describe, expect, it } from "vitest";
import { adBudgetInWords } from "../goal-owner";

describe("adBudgetInWords", () => {
  it("money left but no daily room is never '$0 left' (the review misread exactly this)", () => {
    const s = adBudgetInWords(180.22, 0);
    expect(s).toContain("$180.22 of this month's ad budget is not spent or held yet");
    expect(s).toContain("no room for new daily ad spend");
    expect(s).not.toMatch(/\$0(\.00)? left/);
  });
  it("names the daily room when there is some", () => {
    expect(adBudgetInWords(2000, 85.5)).toBe("$2,000.00 of this month's ad budget is not spent or held yet; up to $85.50 a day of new ad spend still fits.");
  });
  it("no forecast: only the money left", () => {
    expect(adBudgetInWords(567.23, null)).toBe("$567.23 of this month's ad budget is not spent or held yet.");
  });
  it("an overcommitted month reads $0.00, not a negative", () => {
    expect(adBudgetInWords(-310.45, 0)).toMatch(/^\$0\.00 of this month/);
  });
});
