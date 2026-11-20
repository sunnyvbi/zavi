
import { describe, it, expect } from "vitest";
import { renderCompanyBrief, stripLeadingTitle } from "../brief";
import type { CompanyFacts } from "../facts";

const record = (over: Partial<CompanyFacts> = {}): CompanyFacts => ({
  name: "Acme",
  nameIsWorkspaceLabel: false,
  website: null,
  competitors: [],
  facts: {},
  ...over,
});

const fact = (value: string) => ({ value, source: "human_confirmed" as const, verified_at: null });

describe("renderCompanyBrief", () => {
  it("returns null only when there is genuinely nothing to say", () => {
    expect(renderCompanyBrief(record())).toBeNull();
  });

  it("prints the socials that made the record non-empty", () => {
    const body = renderCompanyBrief(record({ facts: { linkedin_url: fact("https://lnkd.in/acme") } }));
    expect(body).not.toBeNull();
    expect(body).toContain("https://lnkd.in/acme");
    expect(body).toContain("LinkedIn");
  });

  it("prints a website-only record", () => {
    const body = renderCompanyBrief(record({ website: "https://acme.com" }));
    expect(body).toContain("https://acme.com");
  });

  it("prints a competitors-only record", () => {
    const body = renderCompanyBrief(record({ competitors: ["Globex"] }));
    expect(body).toContain("Globex");
  });

  it("opens with the story", () => {
    const body = renderCompanyBrief(record({ facts: { company_story: fact("We rent cars.") } }));
    expect(body).toContain("We rent cars.");
    expect(body!.indexOf("We rent cars.")).toBeLessThan(body!.indexOf("generated from the company record"));
  });

  it("never returns a body that prints nothing but the boilerplate", () => {
    const cases: CompanyFacts[] = [
      record({ facts: { linkedin_url: fact("https://lnkd.in/a") } }),
      record({ facts: { instagram_url: fact("https://instagram.com/a") } }),
      record({ facts: { facebook_url: fact("https://facebook.com/a") } }),
      record({ facts: { x_url: fact("https://x.com/a") } }),
      record({ facts: { what_we_sell: fact("Fleet software") } }),
      record({ website: "https://acme.com" }),
      record({ competitors: ["Globex"] }),
    ];
    for (const r of cases) {
      const body = renderCompanyBrief(r);
      expect(body).not.toBeNull();
      const withoutBoilerplate = body!
        .replace("# Acme", "")
        .replace(/_This brief is generated.*$/s, "")
        .replace("## What they have told us", "")
        .trim();
      expect(withoutBoilerplate.length).toBeGreaterThan(0);
    }
  });
});

describe("a story that still carries its anchor title", () => {
  it("does not print a second heading above the story", () => {
    const body = renderCompanyBrief(
      record({ facts: { company_story: fact("# Company\n\nWe rent cars from local owners.") } }),
    )!;

    expect(body).toContain("We rent cars from local owners.");
    expect(body).not.toContain("# Company");
    expect(body.split("\n").filter((l) => /^#\s/.test(l))).toHaveLength(1);
  });

  it("leaves a section heading alone", () => {
    const body = renderCompanyBrief(
      record({ facts: { company_story: fact("## What it is\n\nA marketplace.") } }),
    )!;
    expect(body).toContain("## What it is");
  });

  it("leaves a plain story untouched", () => {
    expect(stripLeadingTitle("We rent cars.")).toBe("We rent cars.");
  });

  it("treats a title-only story as empty", () => {
    expect(stripLeadingTitle("# Company\n")).toBe("");
  });
});

describe("stripLeadingTitle edges", () => {
  it("keeps an INDENTED `#` line — four spaces is a code block, not a title", () => {
    const story = "    # Usage\n\nWe help teams ship faster.";
    expect(stripLeadingTitle(story)).toBe(story.trim());
  });

  it("still strips a heading indented up to three spaces, which markdown allows", () => {
    expect(stripLeadingTitle("   # Company\n\nWe rent cars.")).toBe("We rent cars.");
  });

  it("strips a heading that ends at EOF with no trailing newline", () => {
    expect(stripLeadingTitle("# Company")).toBe("");
  });

  it("skips blank lines before the heading", () => {
    expect(stripLeadingTitle("\n\n# Company\n\nWe rent cars.")).toBe("We rent cars.");
  });

  it("handles CRLF", () => {
    expect(stripLeadingTitle("# Company\r\n\r\nWe rent cars.")).toBe("We rent cars.");
  });

  it("leaves `#hashtag` alone — a heading needs a space", () => {
    expect(stripLeadingTitle("#growth is our whole strategy.")).toBe("#growth is our whole strategy.");
  });

  it("leaves a second H1 further down alone", () => {
    const story = "We rent cars.\n\n# Later heading\n\nMore.";
    expect(stripLeadingTitle(story)).toBe(story);
  });

  it("removes exactly one heading per pass, which is why it runs once", () => {
    const once = stripLeadingTitle("# Company\n\n# Real Heading\n\nBody.");
    expect(once).toBe("# Real Heading\n\nBody.");
    expect(stripLeadingTitle(once)).toBe("Body.");
  });
});
