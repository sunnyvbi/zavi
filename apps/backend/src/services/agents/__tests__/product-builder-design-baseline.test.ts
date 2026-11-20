import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { PRODUCT_BUILDER_DESIGN_BASELINE } from "../generic-dispatcher";

describe("PRODUCT_BUILDER_DESIGN_BASELINE", () => {
  it("sets the bar that bland/default is a FAIL, not just broken", () => {
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/look like a funded product/i);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/create-next-app/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/screenshot for a launch/i);
  });

  it("tells the builder to CHOOSE an aesthetic that fits the product (not one fixed skin)", () => {
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/CHOOSE A DIRECTION/);
    for (const dir of ["marketplace", "SaaS", "premium"]) {
      expect(PRODUCT_BUILDER_DESIGN_BASELINE).toContain(dir);
    }
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/direction drives your DISPLAY FONT \+ BRAND ACCENT/i);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/Poppins|Sora|Plus Jakarta/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/Fraunces|Newsreader|Libre Caslon/);
  });

  it("folds the inline block's concrete mechanism in (8-token system + sticky header + footer + motion), forces LIGHT theme (no OS dark flip), Inter/zinc demoted to fallback", () => {
    for (const tok of ["--bg", "--surface-2", "--border", "--text-muted", "--accent", "--accent-fg"]) {
      expect(PRODUCT_BUILDER_DESIGN_BASELINE).toContain(tok);
    }
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/LIGHT EDITORIAL, ALWAYS/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/renders LIGHT for EVERY visitor regardless of their OS/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/DO \*\*NOT\*\* ship a .*prefers-color-scheme: dark.* override/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/sticky top-0/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/backdrop-blur/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/<footer>/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/fade-in-up/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/DEFAULT\/FALLBACK/);
  });

  it("injects exactly ONE design baseline into the codegen prompt (no contradictory inline duplicate)", () => {
    const src = readFileSync(
      join(__dirname, "..", "generic-dispatcher.ts"),
      "utf8",
    );
    expect(src).not.toContain("DESIGN BASELINE (non-negotiable polish floor for every generated app)");
    const injections = src.match(/\$\{PRODUCT_BUILDER_DESIGN_BASELINE\}/g) ?? [];
    expect(injections).toHaveLength(1);
  });

  it("prescribes the always-apply craft rules (type, color, hero artifact, imagery, components, seeded data)", () => {
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/next\/font/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/TWO real fonts/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/SELF-HOST the fonts via .*next\/font/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/NEVER add a raw .*fonts\.googleapis\.com/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/COLOR SYSTEM/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/NOT stock blue-600/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/HERO WITH A PRODUCT ARTIFACT/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/wrong-subject photo or a broken image/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/random\/unkeyed remote image services/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/onError/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/emoji as the primary visual asset/i);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/lucide-react/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/SEED RICH, REALISTIC DATA/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/stranded single card/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/LIGHT EDITORIAL, ALWAYS/);
    expect(PRODUCT_BUILDER_DESIGN_BASELINE).toMatch(/DECORATIVE ELEMENTS MUST NOT OVERFLOW/);
  });
});
