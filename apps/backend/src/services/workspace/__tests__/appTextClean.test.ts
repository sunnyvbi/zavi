
import { describe, it, expect } from "vitest";
import { cleanAppTitle, cleanAppDescription, looksLikeBuildPlan } from "../appTextClean";

const REPORTED_TITLE = "# Design Marketplace —";
const REPORTED_DESCRIPTION =
  "[refine] # Build prompt — Design marketplace MVP (Phase 1) &gt; Copy everything " +
  "below the line into Claude Code / Cursor / Lovable / v0 / Bolt. &gt; It is scoped " +
  "to **Phase 1 only: portfolios + ready-made asset marketplace.** Hiring, escrow, " +
  "and subscriptions are deliberately excluded";

describe("cleanAppTitle — the reported case", () => {
  it("strips the markdown heading marker and the trailing em-dash", () => {
    expect(cleanAppTitle(REPORTED_TITLE)).toBe("Design Marketplace");
  });

  it("leaves an already-clean name untouched", () => {
    expect(cleanAppTitle("Design Marketplace")).toBe("Design Marketplace");
  });

  it("returns null when nothing survives, so the caller can fall back", () => {
    expect(cleanAppTitle("#")).toBeNull();
    expect(cleanAppTitle("   ")).toBeNull();
    expect(cleanAppTitle(null)).toBeNull();
    expect(cleanAppTitle(undefined)).toBeNull();
  });

  it("does not mangle legitimate punctuation inside a name", () => {
    expect(cleanAppTitle("Acme — Rentals & Co.")).toBe("Acme — Rentals & Co.");
  });
});

describe("cleanAppTitle — actual corrupted prod rows", () => {
  it("design-marketplace: heading marker + trailing em-dash", () => {
    expect(cleanAppTitle("# Design Marketplace —")).toBe("Design Marketplace");
  });

  it("ai-business-prompt: heading marker + trailing colon", () => {
    expect(cleanAppTitle("# AI Business Prompt:")).toBe("AI Business Prompt");
  });

  it("airbnb: bare &amp; mid-string, and a colon that must SURVIVE", () => {
    expect(
      cleanAppTitle(
        "Airbnb: Holiday Rentals, Cabins, Beach Houses, Unique Homes &amp; Experiences",
      ),
    ).toBe("Airbnb: Holiday Rentals, Cabins, Beach Houses, Unique Homes & Experiences");
  });
});

describe("cleanAppDescription — the reported case is now SUPPRESSED (2026-07-23)", () => {
  it("returns null: a build-prompt/plan paste must never reach a customer", () => {
    expect(cleanAppDescription(REPORTED_DESCRIPTION)).toBeNull();
  });
});

describe("cleanAppDescription — general contract", () => {
  it("suppresses a [refine] # Build prompt heading paste", () => {
    expect(cleanAppDescription("[refine] # Build prompt &gt; x")).toBeNull();
  });

  it("decodes double-encoded entities to the real character", () => {
    expect(cleanAppDescription("a &amp;gt; b")).toBe("a > b");
  });

  it("collapses whitespace and newlines", () => {
    expect(cleanAppDescription("a\n\n  b   c")).toBe("a b c");
  });

  it("returns null for empty/absent input", () => {
    expect(cleanAppDescription("")).toBeNull();
    expect(cleanAppDescription("   \n  ")).toBeNull();
    expect(cleanAppDescription(null)).toBeNull();
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "A marketplace for design assets. Buy, sell, and license work.";
    expect(cleanAppDescription(prose)).toBe(prose);
  });
});

describe("cleanAppDescription — plan-shape suppression (2026-07-23)", () => {
  it("suppresses the real /explore build objective (Approved plan + ## headings)", () => {
    const objective =
      "want to add explore page here there user can see our website features " +
      "like what we can provide to customers, pricing, etc.. Approved plan: " +
      "## Approach Create a new /explore route with a dedicated page component " +
      "## What changes - Add new ExplorePage component";
    expect(cleanAppDescription(objective)).toBeNull();
  });

  it("suppresses a bare two-heading paste with no other tell", () => {
    expect(cleanAppDescription("## Approach\nx\n## What changes\ny")).toBeNull();
  });

  it("keeps a genuine short description", () => {
    expect(cleanAppDescription("A marketplace for local fitness classes.")).toBe(
      "A marketplace for local fitness classes.",
    );
  });

  it("keeps a normal [refine] objective (command tag is NOT a plan signal)", () => {
    expect(cleanAppDescription("[refine] Add testimonials to the homepage")).toBe(
      "Add testimonials to the homepage",
    );
  });

  it("keeps prose that merely mentions 'build prompts' at the start", () => {
    expect(cleanAppDescription("Build prompts for your team faster.")).toBe(
      "Build prompts for your team faster.",
    );
  });
});

describe("looksLikeBuildPlan — unit", () => {
  it("true on a high-specificity scaffold phrase", () => {
    expect(looksLikeBuildPlan("… Approved plan: do X")).toBe(true);
    expect(looksLikeBuildPlan("Copy everything below into Cursor")).toBe(true);
    expect(looksLikeBuildPlan("Acceptance criteria: it works")).toBe(true);
  });

  it("true on >=2 markdown headings", () => {
    expect(looksLikeBuildPlan("## Approach\n## Scope")).toBe(true);
  });

  it("false on a lone heading, plain prose, or empty", () => {
    expect(looksLikeBuildPlan("## Overview\nWe rent cars")).toBe(false);
    expect(looksLikeBuildPlan("A tidy marketplace")).toBe(false);
    expect(looksLikeBuildPlan("")).toBe(false);
    expect(looksLikeBuildPlan(null)).toBe(false);
  });
});
