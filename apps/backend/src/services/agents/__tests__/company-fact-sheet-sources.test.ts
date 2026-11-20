import { describe, expect, it } from "vitest";
import { renderCompanyFactSheet, type TenantFact } from "../company-fact-sheet";

function fact(over: Partial<TenantFact>): TenantFact {
  return {
    key: "what_we_sell",
    value_text: "P2P car rental marketplace",
    source: "staff_reviewed",
    verified_at: new Date().toISOString(),
    ...over,
  } as TenantFact;
}

describe("company fact sheet — projected sources", () => {
  it("labels a staff_reviewed fact as reviewed by Zavi, not confirmed by the customer", () => {
    const out = renderCompanyFactSheet("UpcarAI", [fact({ source: "staff_reviewed" })]);
    expect(out).toContain("P2P car rental marketplace");
    expect(out).toMatch(/researched by Zavi/i);
    expect(out).toMatch(/not confirmed by your team/i);
    expect(out).not.toMatch(/(^|[^t] )confirmed by your team/i);
  });

  it("labels an ai_estimated fact as unconfirmed so the model discounts it", () => {
    const out = renderCompanyFactSheet("UpcarAI", [
      fact({ key: "who_we_serve", value_text: "busy professionals", source: "ai_estimated" }),
    ]);
    expect(out).toContain("busy professionals");
    expect(out).toMatch(/not confirmed by anyone/i);
  });
});
