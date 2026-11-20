
import { describe, expect, it } from "vitest";
import { adCurrencySymbol } from "./adCurrency";
import { decisionConsequence } from "@/app/approvals/decisionCopy";
import { handlerPreview } from "@/app/approvals/approvalsHelpers";
import { budgetDelta } from "@/components/agents/decisionSupport";

const CLASS = "meta_ads.update_ad_set_budget_review";
const inr = { ad_set_id: "1", name: "Diwali", daily_budget_usd: 3000, expected_current_daily_budget_usd: 2000, currency: "INR" };
const legacy = { ad_set_id: "1", name: "Diwali", daily_budget_usd: 30, expected_current_daily_budget_usd: 20 };

describe("Meta budget cards", () => {
  it("picks the symbol from the body's currency, USD when absent", () => {
    expect(adCurrencySymbol("INR")).toBe("₹");
    expect(adCurrencySymbol(undefined)).toBe("$");
    expect(adCurrencySymbol("usd")).toBe("$");
  });

  it("an INR body reads in rupees on the consequence, the preview and the delta", () => {
    expect(decisionConsequence(CLASS, CLASS, inr).approve).toContain("from ₹2000 to ₹3000/day");
    expect(handlerPreview(CLASS, inr)).toContain("₹2000 → ₹3000/day");
    expect(budgetDelta(CLASS, inr).dailyLabel).toBe("+₹1,000/day");
  });

  it("a body without a currency reads in dollars, unchanged", () => {
    expect(decisionConsequence(CLASS, CLASS, legacy).approve).toContain("from $20 to $30/day");
    expect(handlerPreview(CLASS, legacy)).toContain("$20 → $30/day");
    expect(budgetDelta(CLASS, legacy).dailyLabel).toBe("+$10/day");
  });
});
