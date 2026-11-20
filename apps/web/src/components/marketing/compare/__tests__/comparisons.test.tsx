// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { COMPARISONS, type Claim } from "@/lib/marketing/comparisons";
import { ComparePageBody } from "../ComparePageBody";
import { FaqStructuredData } from "../../StructuredData";
import { ABOUT_FAQ } from "../../aboutFaq";

afterEach(cleanup);

const claimsOf = (c: (typeof COMPARISONS)[number]): Claim[] => [...c.rows.map((r) => r.other), ...c.otherWins];

describe("comparison data", () => {
  it("has the eight chosen pages, no agency page and no Okara page", () => {
    expect(COMPARISONS.map((c) => c.slug).sort()).toEqual([
      "zavi-vs-chatgpt",
      "zavi-vs-genspark",
      "zavi-vs-grok",
      "zavi-vs-lovable",
      "zavi-vs-manus",
      "zavi-vs-meta-muse",
      "zavi-vs-polsia",
      "zavi-vs-sintra",
    ]);
  });

  for (const c of COMPARISONS) {
    it(`${c.slug}: every claim about ${c.other} has a quote, an https source and a real date`, () => {
      for (const claim of claimsOf(c)) {
        expect(claim.quote.trim().length, claim.text).toBeGreaterThan(5);
        expect(claim.sourceUrl, claim.text).toMatch(/^https:\/\//);
        expect(Number.isNaN(Date.parse(claim.seen)), claim.text).toBe(false);
      }
    });

    it(`${c.slug}: prints no competitor price anywhere`, () => {
      const printed = [c.intro, c.pickOther, c.pickZavi, ...claimsOf(c).map((x) => x.text), ...c.faq.map((f) => f.a)];
      for (const line of printed) expect(line).not.toMatch(/\$\d|\bper month\b|\/mo\b/i);
    });

    it(`${c.slug}: ${c.other} gets a non-empty 'better pick' section and Zavi's side names no model`, () => {
      expect(c.otherWins.length).toBeGreaterThan(0);
      expect(c.zaviWins.length).toBeGreaterThan(0);
      const zaviSide = [...c.zaviWins, ...c.rows.map((r) => r.zavi), c.pickZavi];
      for (const line of zaviSide) expect(line).not.toMatch(/\b(claude|gpt|gemini|anthropic|openai|sonnet|opus)\b/i);
    });

    it(`${c.slug}: the FAQ carries no prices`, () => {
      for (const f of c.faq) expect(`${f.q} ${f.a}`).not.toMatch(/\$\d/);
    });
  }
});

describe("the rendered page", () => {
  for (const c of COMPARISONS) {
    it(`${c.slug}: links a source for every claim, shows no price, shows every FAQ`, () => {
      const { container } = render(<ComparePageBody c={c} startHref="/start" />);
      const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      for (const claim of claimsOf(c)) expect(hrefs).toContain(claim.sourceUrl);
      expect(container.textContent).not.toMatch(/\$\d/);
      for (const f of c.faq) expect(container.textContent).toContain(f.a);
      expect(container.textContent).toContain(`Where ${c.other} is the better pick`);
    });
  }
});

describe("FAQ JSON-LD matches the visible FAQ", () => {
  const ld = (items: ReadonlyArray<{ q: string; a: string }>, path: string) => {
    const { container } = render(<FaqStructuredData path={path} items={items} />);
    return JSON.parse(container.querySelector("script")!.innerHTML);
  };

  it("emits each page's own FAQ rows under its own @id", () => {
    for (const c of COMPARISONS) {
      const data = ld(c.faq, `/compare/${c.slug}`);
      expect(data["@id"]).toBe(`https://www.zaviagent.com/compare/${c.slug}#faq`);
      expect(data.mainEntity.map((m: { name: string }) => m.name)).toEqual(c.faq.map((f) => f.q));
    }
    const about = ld(ABOUT_FAQ, "/about");
    expect(about["@id"]).toBe("https://www.zaviagent.com/about#faq");
    expect(about.mainEntity.map((m: { acceptedAnswer: { text: string } }) => m.acceptedAnswer.text)).toEqual(
      ABOUT_FAQ.map((f) => f.a),
    );
  });
});
