import { describe, expect, it } from "vitest";
import {
  areProfileFieldsLocked,
  isResearchableWebsite,
  matchesActiveResearch,
} from "./competitorResearchState";

describe("competitor research form guards", () => {
  it("starts only for complete public-looking HTTP URLs", () => {
    expect(isResearchableWebsite("https://acme.com/pricing")).toBe(true);
    expect(isResearchableWebsite("http://acme.com")).toBe(true);
    expect(isResearchableWebsite("acme.com")).toBe(false);
    expect(isResearchableWebsite("javascript:alert(1)")).toBe(false);
    expect(isResearchableWebsite("https://user:pass@acme.com")).toBe(false);
  });

  it("rejects late results from an old URL or request", () => {
    const active = {
      activeGeneration: 3,
      responseGeneration: 3,
      activeRequestId: "new",
      responseRequestId: "new",
      activeWebsite: "https://new.example/",
      responseWebsite: "https://new.example/",
    };
    expect(matchesActiveResearch(active)).toBe(true);
    expect(matchesActiveResearch({ ...active, responseGeneration: 2 })).toBe(false);
    expect(matchesActiveResearch({ ...active, responseRequestId: "old" })).toBe(false);
    expect(matchesActiveResearch({ ...active, responseWebsite: "https://old.example/" })).toBe(false);
  });

  it("locks all profile controls only while AI research is running", () => {
    expect(areProfileFieldsLocked("researching")).toBe(true);
    expect(areProfileFieldsLocked("complete")).toBe(false);
    expect(areProfileFieldsLocked("failed")).toBe(false);
  });
});
