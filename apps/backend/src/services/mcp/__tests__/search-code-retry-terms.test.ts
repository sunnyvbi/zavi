
import { describe, it, expect } from "vitest";
import { pickRetryTerms } from "../internal/github";

describe("pickRetryTerms", () => {
  it("picks the subject + the most distinctive identifier (the Turo query)", () => {
    const terms = pickRetryTerms("turo linkedAccount externalAccount rentalLink");
    expect(terms[0]).toBe("turo");
    expect(terms).toContain("externalAccount");
    expect(terms.length).toBeLessThanOrEqual(2);
  });

  it("returns nothing for a single-term query (no retry to make)", () => {
    expect(pickRetryTerms("turo")).toEqual([]);
    expect(pickRetryTerms("   rentalCompanyProfileUrl  ")).toEqual([]);
  });

  it("drops stopwords so a retry is never on a filler word", () => {
    const terms = pickRetryTerms("how does the user profile feature work");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("how");
    expect(terms).not.toContain("feature");
  });

  it("strips surrounding punctuation but keeps identifier characters", () => {
    const terms = pickRetryTerms('"deposit_waiver", turoProfileUtils.ts');
    expect(terms[0]).toBe("deposit_waiver");
    expect(terms).toContain("turoProfileUtils.ts");
  });

  it("dedupes when the subject IS the longest term", () => {
    expect(pickRetryTerms("rentalCompanyProfileUrl url")).toEqual(["rentalCompanyProfileUrl"]);
  });
});
