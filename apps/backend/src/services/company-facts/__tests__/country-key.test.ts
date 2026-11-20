import { describe, expect, it } from "vitest";
import { CompanyFactsBody, FACT_KEYS, normalizeForKey } from "../write";

describe("country fact", () => {
  it("is a live key", () => {
    expect(FACT_KEYS).toContain("country");
  });

  it("accepts an ISO code in any case, normalized to capitals; empty clears it", () => {
    expect(CompanyFactsBody.safeParse({ facts: [{ key: "country", value: "us" }] }).success).toBe(true);
    expect(normalizeForKey("country", " us ").value).toBe("US");
    expect(CompanyFactsBody.safeParse({ facts: [{ key: "country", value: "" }] }).success).toBe(true);
  });

  it("refuses anything that is not an ISO country code", () => {
    for (const value of ["USA", "United States", "ZZ", "U"]) {
      expect(CompanyFactsBody.safeParse({ facts: [{ key: "country", value }] }).success, value).toBe(false);
    }
  });
});
