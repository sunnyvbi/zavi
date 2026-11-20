import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/settings", () => ({ getNumberSetting: vi.fn(async () => 60), getBoolSetting: vi.fn(async () => false) }));

import { fastSiteBuildPrompt, fastSiteEditPrompt, fastSiteRefinePrompt, VISUAL_QUALITY_CONTRACT } from "../fast-build-prompt";

const BASE = { companyName: "Shop", targetRepo: "o/r", idea: "a bakery in Leeds" };
const HEAD = "### Visual quality contract";

describe("visual quality contract", () => {
  it("leads the first pass once, after the founder's idea and before the rules", () => {
    for (const v of [{}, { backend: "pooled" as const }, { referenceUrls: ["https://x.supabase.co/a.jpg"] }]) {
      const p = fastSiteBuildPrompt({ ...BASE, ...v });
      expect(p.split(HEAD).length - 1).toBe(1);
      const ideaEnd = p.indexOf("</untrusted_product_idea>");
      expect(ideaEnd).toBeGreaterThan(-1);
      expect(ideaEnd).toBeLessThan(p.indexOf(HEAD));
      expect(p.indexOf(HEAD)).toBeLessThan(p.indexOf("### Rules"));
    }
  });

  it("is the founder's text word for word", () => {
    const p = fastSiteBuildPrompt(BASE);
    expect(p).toContain("Customize the starter deliberately; do not retain its defaults by accident.");
    expect(p).toContain("consistent with the founder’s references.");
    expect(p).toContain("Do not claim visual verification you could not perform.");
    expect(VISUAL_QUALITY_CONTRACT).not.toContain("—");
  });

  it("stays out of fix, refine and edit passes", () => {
    const passes = [
      fastSiteBuildPrompt({ ...BASE, repairSignal: "zavi:home failed", repairAttempt: 1 }),
      fastSiteRefinePrompt({ targetRepo: "o/r", request: "make the header blue", backend: "pooled" }),
      fastSiteEditPrompt({ targetRepo: "o/r", request: "change the title", backend: "pooled" }),
    ];
    for (const p of passes) expect(p).not.toContain(HEAD);
  });
});
