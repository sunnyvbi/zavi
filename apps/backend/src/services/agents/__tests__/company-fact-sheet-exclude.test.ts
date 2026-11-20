import { describe, expect, it } from "vitest";
import { renderCompanyFactSheet, type TenantFact } from "../company-fact-sheet";

const facts: TenantFact[] = [
  { key: "what_we_sell", value_text: "P2P car rental marketplace", source: "staff_reviewed", verified_at: new Date().toISOString() },
  { key: "who_we_serve", value_text: "busy professionals", source: "ai_estimated", verified_at: new Date().toISOString() },
];

describe("fact sheet — source exclusion", () => {
  it("renders every fact when nothing is excluded", () => {
    const out = renderCompanyFactSheet("UpcarAI", facts);
    expect(out).toContain("P2P car rental marketplace");
    expect(out).toContain("busy professionals");
  });

  it("drops only the excluded source, keeping the rest of the sheet intact", () => {
    const kept = facts.filter((f) => f.source !== "ai_estimated");
    const out = renderCompanyFactSheet("UpcarAI", kept);
    expect(out).toContain("P2P car rental marketplace");
    expect(out).not.toContain("busy professionals");
    expect(out).not.toMatch(/who they serve/i);
  });
});
