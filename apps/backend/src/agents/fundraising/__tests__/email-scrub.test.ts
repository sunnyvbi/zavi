import { describe, it, expect } from "vitest";
import { __test__ } from "../post-run";

const { stripFabricatedEmails, extractExcludedSection } = __test__;

describe("stripFabricatedEmails — enforces the no-fabricated-email contract", () => {
  it("converts a firm-domain email to a bare site and keeps the handle", () => {
    expect(stripFabricatedEmails("anamitra@afore.vc / @anamitra")).toBe(
      "afore.vc / @anamitra",
    );
    expect(stripFabricatedEmails("charles@precursorvc.com / @chudson")).toBe(
      "precursorvc.com / @chudson",
    );
    expect(
      stripFabricatedEmails("aholidayiii@645Ventures.com / @aholidayiii"),
    ).toBe("645ventures.com / @aholidayiii");
    expect(
      stripFabricatedEmails("darianshirazi+external@gradient.com / @darian314"),
    ).toBe("gradient.com / @darian314");
  });

  it("when the email is the ONLY hint, keeps the real firm domain (not empty)", () => {
    expect(stripFabricatedEmails("hunter@homebrew.co")).toBe("homebrew.co");
    expect(stripFabricatedEmails("mitra@southparkcommons.com")).toBe(
      "southparkcommons.com",
    );
  });

  it("handle-first ordering is preserved", () => {
    expect(stripFabricatedEmails("@hunterwalk / hunter@homebrew.co")).toBe(
      "@hunterwalk / homebrew.co",
    );
  });

  it("DROPS generic mail-provider addresses entirely (domain carries no firm signal)", () => {
    expect(stripFabricatedEmails("someone@gmail.com / @x")).toBe("@x");
    expect(stripFabricatedEmails("founder@outlook.com")).toBe("");
  });

  it("leaves handles, sites, and empty hints untouched", () => {
    expect(stripFabricatedEmails("@naval")).toBe("@naval");
    expect(stripFabricatedEmails("afore.vc")).toBe("afore.vc");
    expect(stripFabricatedEmails("afore.vc / @anamitra")).toBe(
      "afore.vc / @anamitra",
    );
    expect(stripFabricatedEmails("")).toBe("");
    expect(stripFabricatedEmails(undefined as unknown as string)).toBe("");
  });

  it("scrubs an email embedded in outreach copy too", () => {
    expect(
      stripFabricatedEmails("Reach me, intro via charles@precursorvc.com please"),
    ).toBe("Reach me, intro via precursorvc.com please");
  });
});

describe("extractExcludedSection — preserves the narrowing-ask honesty note through rebuild", () => {
  it("extracts a 'Considered but excluded' section up to the next heading", () => {
    const md = [
      "## Investor shortlist",
      "### Tier 1",
      "- Foo",
      "### Considered but excluded",
      "- Bar — leads at Series A, not pre-seed",
      "- Baz — co-invests, does not lead",
      "## Sources",
      "- x",
    ].join("\n");
    const out = extractExcludedSection(md);
    expect(out).toContain("Considered but excluded");
    expect(out).toContain("Bar — leads at Series A");
    expect(out).toContain("Baz — co-invests");
    expect(out).not.toContain("## Sources");
    expect(out).not.toContain("Tier 1");
  });

  it("matches a 'Did NOT qualify' heading and runs to end-of-string", () => {
    const md = [
      "## Shortlist",
      "### Tier 1",
      "- Foo",
      "### Did NOT qualify as pre-seed leads",
      "- Conviction — does not lead",
    ].join("\n");
    const out = extractExcludedSection(md);
    expect(out).toContain("Did NOT qualify");
    expect(out).toContain("Conviction — does not lead");
  });

  it("returns empty when there is no excluded section", () => {
    expect(extractExcludedSection("## Shortlist\n### Tier 1\n- Foo")).toBe("");
    expect(extractExcludedSection("")).toBe("");
  });
});
