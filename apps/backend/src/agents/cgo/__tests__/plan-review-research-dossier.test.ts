import { describe, expect, it } from "vitest";
import { buildDossier, reviewAndRevisePlan, unsourcedNumbers } from "../plan-review";
import type { ParsedStrategy } from "../strategy";

function research(): Record<string, unknown> {
  return {
    site: { https: true, pages_indexed: 41 },
    guard: { flagged: [] },
    domain: "example.com",
    provenance: { source: "intake" },
    competitors: [{ name: "Rival Co", url: "https://rival.example" }],
    marketplace: null,
    page_checks: [{ url: "https://example.com/", h1: "Rent a car near you" }],
    site_checks: [{ check: "robots", ok: true }],
    sitemap_urls: Array.from({ length: 120 }, (_, i) => `https://example.com/cities/city-${i}`),
    dossier_facts: [
      ...Array.from({ length: 40 }, (_, i) => ({ fact: `filler fact ${i} ${"y".repeat(150)}`, url: "https://example.com/" })),
      { fact: "The about page says 4,850 hosts list on the site.", url: "https://example.com/about" },
    ],
    research_pages: Array.from({ length: 6 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      title: `Page ${i}`,
      text_excerpt: i === 4
        ? `Founded in Austin. We now have 3,200 cars across five states. ${"z".repeat(6000)}`
        : "w".repeat(7000),
    })),
  };
}

const plan = (summary: string, evidence: string): ParsedStrategy => ({
  north_star: { metric: "bookings", why: "", provenance: "" },
  summary,
  constraint: { statement: "Too few renters find a car", lever_family: "acquisition", evidence, confidence: "medium" },
  channel_bets: [], gaps: [], unmeasured: [], basis_evidence: [],
} as unknown as ParsedStrategy);

describe("intake research in the review dossier", () => {
  it("keeps a page figure that sits far past 20K of the raw research JSON", () => {
    const r = research();
    expect(JSON.stringify(r).replace(/,/g, "").indexOf("3200")).toBeGreaterThan(20_000);
    const dossier = buildDossier({ research: r });
    expect(dossier).toContain("3,200 cars");
    expect(unsourcedNumbers(plan("A rental marketplace with 3,200 cars.", "4,850 hosts list on the site."), dossier)).toEqual([]);
  });

  it("still flags a figure the research never contained", () => {
    const dossier = buildDossier({ research: research() });
    expect(unsourcedNumbers(plan("A marketplace with 3,200 cars and 91,000 renters.", "4,850 hosts list."), dossier)).toEqual(["91000"]);
  });

  it("keeps verified facts ahead of the sitemap and page text, and every page is represented", () => {
    const r = research();
    r.sitemap_urls = Array.from({ length: 2000 }, (_, i) => `https://example.com/very/long/path/for/city-${i}`);
    const dossier = buildDossier({ research: r });
    expect(dossier).toContain("4,850 hosts");
    expect(dossier.indexOf("dossier_facts:")).toBeLessThan(dossier.indexOf("sitemap_urls:"));
    const line = dossier.split("\n").find((l) => l.startsWith("research_pages: "))!;
    const pages = JSON.parse(line.slice("research_pages: ".length));
    expect(pages.map((p: { url: string }) => p.url)).toEqual(Array.from({ length: 6 }, (_, i) => `https://example.com/page-${i}`));
  });

  it("stays inside the dossier bound and leaves room for uploaded facts and tool reads", () => {
    const r = research();
    r.research_pages = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/p${i}`, title: "", text_excerpt: "v".repeat(8000) }));
    const dossier = buildDossier(
      { interview: [{ question: "Q", answer: "a".repeat(12_000) }], research: r, past_work: [{ fact: "uploaded deck says 777 bookings" }] },
      [{ name: "web_fetch__fetch", status: "ok", output_preview: "tool read says 8,800 visits" }],
    );
    expect(dossier.length).toBeLessThanOrEqual(60_000);
    expect(dossier).not.toContain("[truncated]");
    expect(dossier).toContain("777 bookings");
    expect(dossier).toContain("8,800 visits");
    expect(dossier).toContain("4,850 hosts");
  });

  it("does not call a figure invented when only the bounded copy cut it", async () => {
    const r = research();
    r.research_pages = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/p${i}`, title: "", text_excerpt: "q".repeat(6000) + (i === 7 ? " we serve 12,345 active members" : ""),
    }));
    expect(buildDossier({ research: r })).not.toContain("12,345");
    const seen: Array<Array<{ problem: string }>> = [];
    const pass = { scores: { constraint: 9, target: 9, actions: 9, effects: 9, grounding: 9 }, overall: 9, pass: true, issues: [], unsupported_facts: [] };
    await reviewAndRevisePlan(
      { strategy: plan("A club with 12,345 active members.", "4,850 hosts list on the site."), payload: { research: r } },
      { now: () => 0, critique: async ({ structuralIssues }) => { seen.push(structuralIssues); return pass; }, revise: async () => "" },
    );
    expect(seen[0].map((i) => i.problem).join(" ")).not.toMatch(/12345/);
    seen.length = 0;
    await reviewAndRevisePlan(
      { strategy: plan("A club with 12,345 active members and 66,000 fans.", "4,850 hosts list."), payload: { research: r } },
      { now: () => 0, critique: async ({ structuralIssues }) => { seen.push(structuralIssues); return pass; }, revise: async () => "" },
    );
    expect(seen[0].map((i) => i.problem).join(" ")).toMatch(/66000/);
  });

  it("keeps every page even when earlier fields are large", () => {
    const r = research();
    for (const k of ["page_checks", "site_checks", "site", "competitors", "provenance", "guard"]) r[k] = "e".repeat(20_000);
    r.dossier_facts = "f".repeat(40_000);
    const dossier = buildDossier({ interview: [{ question: "Q", answer: "a".repeat(12_000) }], research: r, past_work: ["u".repeat(15_000)] },
      [{ name: "web_fetch__fetch", status: "ok", output_preview: "r".repeat(20_000) }]);
    for (let i = 0; i < 6; i++) expect(dossier).toContain(`https://example.com/page-${i}`);
    expect(dossier.length).toBeLessThanOrEqual(60_000);
  });

  it("fits pages with long titles and URLs into a small share, and never exceeds the cap", () => {
    const r = { research_pages: Array.from({ length: 40 }, (_, i) => ({ url: `https://example.com/${"u".repeat(290)}${i}`, title: "t".repeat(200), text_excerpt: "x".repeat(8000) })) };
    const dossier = buildDossier({ research: r });
    expect(dossier.length).toBeLessThanOrEqual(60_000);
    const line = dossier.split("\n").find((l) => l.startsWith("research_pages: "))!;
    expect(JSON.parse(line.slice("research_pages: ".length))).toHaveLength(40);
  });

  it("handles research that is not an object", () => {
    expect(buildDossier({ research: ["only", "a", "list"] })).toContain('["only","a","list"]');
  });
});
