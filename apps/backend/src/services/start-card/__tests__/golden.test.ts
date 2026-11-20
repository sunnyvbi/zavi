
import { describe, it, expect } from "vitest";
import {
  START_CARD_DONE_FIXTURE,
  type StartCardAiEvidence,
  type StartCardDesignEvidence,
  type StartCardGoogleEvidence,
  type StartCardParts,
  type StartCardScore,
  type StartCardSeoEvidence,
} from "@zavi/shared";
import { aiPoints, designPoints, googlePoints, seoPoints } from "../checks/points";
import { buildCompare } from "../checks/compare";
import { scoreCard, SCORER_VERSION } from "../stages";

type Golden = {
  name: string;
  domain: string;
  rivals: string[];
  google?: StartCardGoogleEvidence;
  ai?: StartCardAiEvidence;
  seo?: StartCardSeoEvidence;
  design?: StartCardDesignEvidence;
  expected: StartCardScore;
};

const done = <E,>(evidence: E, points: number | null) =>
  points === null
    ? { state: "unavailable" as const, evidence: null, unavailable_reason: "not_measured", fetched_at: null }
    : { state: "done" as const, evidence, points, max_points: 20, fetched_at: null };

function score(g: Golden): StartCardScore {
  const parts: StartCardParts = {};
  parts.google = g.google ? done(g.google, googlePoints(g.google.position)) : undefined;
  parts.ai = g.ai ? done(g.ai, aiPoints(g.ai)) : undefined;
  parts.seo = g.seo ? done(g.seo, seoPoints(g.seo)) : undefined;
  parts.design = g.design ? done(g.design, designPoints(g.design)) : undefined;
  const cmp = buildCompare(g.domain, parts, g.rivals);
  if (cmp) parts.compare = done(cmp.evidence, cmp.points);
  return scoreCard(parts);
}

const perfectRender = { cta_above_fold: true, body_text_px: 16, overlapping_boxes: false, horizontal_scroll: false };
const brokenRender = { cta_above_fold: false, body_text_px: 12, overlapping_boxes: true, horizontal_scroll: true };
const goodSeo: StartCardSeoEvidence = {
  pages_checked: ["https://a.example/"],
  title: "Acme Dental | Family dentist in Leeds",
  meta_description: "Family and cosmetic dentistry in central Leeds. Same-week appointments and clear prices.",
  h1_count: 1,
  schema_types: ["Dentist"],
  robots_allows_root: true,
  sitemap_found: true,
  broken_links: [],
};

const GOLDENS: Golden[] = [
  {
    name: "the shared done fixture (bakery, rank 2 of 3)",
    domain: "brightloaf.example",
    rivals: ["crumbhouse.example", "rollingpin.example"],
    google: START_CARD_DONE_FIXTURE.parts.google!.evidence!,
    ai: START_CARD_DONE_FIXTURE.parts.ai!.evidence!,
    seo: START_CARD_DONE_FIXTURE.parts.seo!.evidence!,
    design: START_CARD_DONE_FIXTURE.parts.design!.evidence!,
    expected: START_CARD_DONE_FIXTURE.score!,
  },
  {
    name: "strong site that beats both rivals",
    domain: "a.example",
    rivals: ["b.example", "c.example"],
    google: { search_term: "dentist leeds", locale: "GB", results_checked: 100, position: 2, rivals: [{ domain: "b.example", position: 5 }, { domain: "c.example", position: null }] },
    ai: {
      prompt: "p",
      engines: [
        { engine: "chatgpt", answered: true, mentioned: true, rivals_mentioned: ["b.example"] },
        { engine: "gemini", answered: true, mentioned: true, rivals_mentioned: [] },
        { engine: "perplexity", answered: true, mentioned: true, rivals_mentioned: [] },
        { engine: "claude", answered: true, mentioned: true, rivals_mentioned: ["c.example"] },
      ],
    },
    seo: { ...goodSeo, rivals: [{ domain: "b.example", points: 14 }, { domain: "c.example", points: 10 }] },
    design: {
      pagespeed: { performance: 95, accessibility: 96 },
      render: perfectRender,
      rivals: [
        { domain: "b.example", render: brokenRender, points: 0 },
        { domain: "c.example", render: perfectRender, points: 20 },
      ],
    },
    expected: { total: 100, out_of: 100, by_check: { google: 20, ai: 20, seo: 20, design: 20, compare: 20 } },
  },
  {
    name: "no DataForSEO (Google + AI unavailable), weak site, last of 2",
    domain: "a.example",
    rivals: ["b.example"],
    seo: {
      pages_checked: ["https://a.example/"],
      title: "Home",
      meta_description: null,
      h1_count: 2,
      schema_types: [],
      robots_allows_root: null,
      sitemap_found: false,
      broken_links: [],
      rivals: [{ domain: "b.example", points: 10 }],
    },
    design: { pagespeed: null, render: brokenRender, rivals: [{ domain: "b.example", render: perfectRender, points: 20 }] },
    expected: { total: 3, out_of: 60, by_check: { google: null, ai: null, seo: 3, design: 0, compare: 0 } },
  },
  {
    name: "engines error, PageSpeed only, no rival with a site",
    domain: "a.example",
    rivals: [],
    google: { search_term: "invoicing software", locale: "US", results_checked: 100, position: 15, rivals: [] },
    ai: {
      prompt: "p",
      engines: [
        { engine: "chatgpt", answered: true, mentioned: true, rivals_mentioned: [] },
        { engine: "gemini", answered: false, mentioned: null },
        { engine: "perplexity", answered: true, mentioned: false, rivals_mentioned: [] },
        { engine: "claude", answered: true, mentioned: false, rivals_mentioned: [] },
      ],
    },
    seo: { ...goodSeo, meta_description: "Too short", broken_links: [{ url: "https://a.example/x", status: 404 }] },
    design: { pagespeed: { performance: 55, accessibility: 92 }, render: null, rivals: [] },
    expected: { total: 44, out_of: 80, by_check: { google: 10, ai: 7, seo: 13, design: 14, compare: null } },
  },
  {
    name: "tie for first shares the better rank",
    domain: "a.example",
    rivals: ["b.example", "c.example"],
    google: { search_term: "yoga studio austin", locale: "US", results_checked: 100, position: null, rivals: [{ domain: "b.example", position: null }, { domain: "c.example", position: 40 }] },
    ai: {
      prompt: "p",
      engines: [
        { engine: "chatgpt", answered: true, mentioned: false, rivals_mentioned: ["b.example"] },
        { engine: "gemini", answered: true, mentioned: true, rivals_mentioned: [] },
        { engine: "perplexity", answered: true, mentioned: false, rivals_mentioned: [] },
        { engine: "claude", answered: true, mentioned: false, rivals_mentioned: [] },
      ],
    },
    seo: { ...goodSeo, rivals: [{ domain: "b.example", points: 20 }, { domain: "c.example", points: 6 }] },
    design: {
      pagespeed: null,
      render: { ...perfectRender, body_text_px: 13 },
      rivals: [
        { domain: "b.example", render: { ...perfectRender, body_text_px: 13 }, points: 16 },
        { domain: "c.example", render: brokenRender, points: 0 },
      ],
    },
    expected: { total: 61, out_of: 100, by_check: { google: 0, ai: 5, seo: 20, design: 16, compare: 20 } },
  },
];

describe("golden scores", () => {
  it("scorer version is pinned (bump it when a rule changes)", () => {
    expect(SCORER_VERSION).toBe("1");
  });

  for (const g of GOLDENS) {
    it(g.name, () => {
      expect(score(g)).toEqual(g.expected);
      expect(score(g)).toEqual(score(g));
    });
  }

  it("the fixture's compare ranking is what buildCompare produces", () => {
    const f = START_CARD_DONE_FIXTURE.parts;
    const built = buildCompare("brightloaf.example", f, ["crumbhouse.example", "rollingpin.example"])!;
    expect(built.evidence.ranking).toEqual(f.compare!.evidence!.ranking);
    expect(built.points).toBe(f.compare!.points);
  });

  it("one rival missing a check drops that check or that rival, never the whole comparison", () => {
    const f = structuredClone(START_CARD_DONE_FIXTURE.parts);
    const seo = f.seo!.evidence!;
    seo.rivals = (seo.rivals ?? []).filter((r) => r.domain !== "crumbhouse.example");
    const built = buildCompare("brightloaf.example", f, ["crumbhouse.example", "rollingpin.example"])!;
    expect(built).not.toBeNull();
    expect(built.evidence.checks_used).not.toContain("seo");
    expect(built.evidence.ranking).toHaveLength(3);
  });

  it("a rival with no measured check at all is left out; the others are still ranked", () => {
    const f = structuredClone(START_CARD_DONE_FIXTURE.parts);
    const built = buildCompare("brightloaf.example", f, ["crumbhouse.example", "rollingpin.example", "ghost.example"])!;
    expect(built.evidence.ranking.map((r) => r.domain)).not.toContain("ghost.example");
    expect(built.evidence.ranking).toHaveLength(3);
  });
});
