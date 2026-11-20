import { describe, it, expect } from "vitest";
import { TEMPLATES, lensesForTemplate, MAX_LENSES } from "../classify";
import { RESEARCH_TEMPLATES } from "../output-schema";

describe("template registry", () => {
  it("defines exactly the 4 v1 templates", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...RESEARCH_TEMPLATES].sort());
  });
  it("never exceeds MAX_LENSES for any template", () => {
    for (const t of RESEARCH_TEMPLATES) expect(lensesForTemplate(t).length).toBeLessThanOrEqual(MAX_LENSES);
  });
  it("freeform falls back to a small generic lens set", () => {
    expect(lensesForTemplate("freeform")).toContain("overview");
  });
});
