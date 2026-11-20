import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { goldenDirForSlug, runtimeSlugForGoldenDir, GOLDEN_DIRS } from "@/services/agents/eval/golden-dir";

describe("goldenDirForSlug", () => {
  it("maps the 5 renamed runtime slugs to their old golden dirs", () => {
    expect(goldenDirForSlug("engineer")).toBe("cto-engineer");
    expect(goldenDirForSlug("performance-marketer")).toBe("ads-manager");
    expect(goldenDirForSlug("pm")).toBe("product-pm");
    expect(goldenDirForSlug("qa")).toBe("qa-engineer");
    expect(goldenDirForSlug("growth-lead")).toBe("growth-orchestrator");
  });

  it("is identity for un-renamed slugs", () => {
    expect(goldenDirForSlug("operator")).toBe("operator");
    expect(goldenDirForSlug("chief-of-staff")).toBe("chief-of-staff");
    expect(goldenDirForSlug("advisor")).toBe("advisor");
  });

  it("round-trips via runtimeSlugForGoldenDir", () => {
    for (const slug of ["engineer", "performance-marketer", "pm", "qa", "growth-lead", "operator"]) {
      expect(runtimeSlugForGoldenDir(goldenDirForSlug(slug))).toBe(slug);
    }
  });

  it("every runtime slug resolves to an EXISTING golden dir (no silent no-op)", () => {
    const root = join(__dirname, "..", "..", "..", "eval", "agent-faithfulness");
    for (const slug of ["engineer", "performance-marketer", "pm", "qa", "operator", "chief-of-staff", "advisor", "growth-lead"]) {
      const dir = goldenDirForSlug(slug);
      expect(GOLDEN_DIRS).toContain(dir);
      expect(existsSync(join(root, dir, "goldens.json"))).toBe(true);
    }
  });
});
