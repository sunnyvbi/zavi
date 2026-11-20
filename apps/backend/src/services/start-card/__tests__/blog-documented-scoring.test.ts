import { describe, it, expect } from "vitest";
import { aiPointsFromCounts, comparePoints, designPoints, googlePoints, pagespeedPart, rankOf, renderPart, rivalDesignPoints, seoBreakdown } from "../checks/points";
import { RANKED_MAX_RANK } from "../checks/ranked-terms";
import { CARD_SEO_PAGES } from "../checks/seo";
import { MEASURE_SCRIPT } from "../checks/render";

const render = (over: Partial<Parameters<typeof renderPart>[0]> = {}) =>
  ({ cta_above_fold: true, body_text_px: 16, overlapping_boxes: false, horizontal_scroll: false, ...over }) as Parameters<typeof renderPart>[0];

describe("scoring rules stated in the growth-score blog post", () => {
  it("Google: 1-3 = 20, 4-10 = 15, 11-20 = 10, 21-100 = 4, not found = 0; ranked-term path tops out at 20", () => {
    expect([1, 3, 4, 10, 11, 20, 21, 100].map(googlePoints)).toEqual([20, 20, 15, 15, 10, 10, 4, 4]);
    expect(googlePoints(null)).toBe(0);
    expect(RANKED_MAX_RANK).toBe(20);
  });
  it("AI answers: share of answering engines that named you x 20 (2 of 4 = 10, 1 of 3 = 7); none answered = not measured", () => {
    expect(aiPointsFromCounts(2, 4)).toBe(10);
    expect(aiPointsFromCounts(1, 3)).toBe(7);
    expect(aiPointsFromCounts(0, 0)).toBeNull();
  });
  it("SEO: 4 / 4 / 3 / 3 / 3 / 3, broken links over up to 6 pages", () => {
    const b = seoBreakdown({ title: "A good title here", meta_description: "x".repeat(80), h1_count: 1, schema_types: ["Organization"], robots_allows_root: true, sitemap_found: true, broken_links: [] });
    expect(b).toEqual({ title: 4, meta: 4, h1: 3, schema: 3, crawl: 3, links: 3 });
    expect(CARD_SEO_PAGES).toBe(6);
  });
  it("Design: PageSpeed bands 6/3 and 4/2; phone checks 4/2/2/2; a missing half doubles the other", () => {
    expect(pagespeedPart({ performance: 90, accessibility: 90 })).toBe(10);
    expect(pagespeedPart({ performance: 50, accessibility: 70 })).toBe(5);
    expect(renderPart(render())).toBe(10);
    expect(renderPart(render({ cta_above_fold: false }))).toBe(6);
    expect(designPoints({ pagespeed: null, render: render() } as Parameters<typeof designPoints>[0])).toBe(20);
  });
  it("Competitors: first = 20, last = 0", () => {
    expect(comparePoints(1, 4)).toBe(20);
    expect(comparePoints(4, 4)).toBe(0);
  });
  it("SEO boundaries: title 10-65 and meta 50-160 characters", () => {
    const at = (title: string, meta: string) => seoBreakdown({ title, meta_description: meta, h1_count: 1, schema_types: [], robots_allows_root: true, sitemap_found: true, broken_links: [] });
    const ok = "m".repeat(80);
    expect([9, 10, 65, 66].map((n) => at("x".repeat(n), ok).title)).toEqual([0, 4, 4, 0]);
    expect([49, 50, 160, 161].map((n) => at("A good title here", "m".repeat(n)).meta)).toEqual([0, 4, 4, 0]);
  });
  it("Phone text: 14px counts, 13px does not; a low PageSpeed score is not doubled away", () => {
    expect(renderPart(render({ body_text_px: 14 })) - renderPart(render({ body_text_px: 13 }))).toBe(2);
    expect(designPoints({ pagespeed: { performance: 10, accessibility: 10 }, render: render() } as Parameters<typeof designPoints>[0])).toBe(10);
  });
  it("Competitors: ties share the better rank; a rival's design is its phone half x 2", () => {
    expect(rankOf(50, [60, 50, 50, 40])).toBe(2);
    expect(rivalDesignPoints(render({ cta_above_fold: false }))).toBe(12);
  });
  it("Clear-action words: the post's examples count, 'Learn more' does not", () => {
    const src = MEASURE_SCRIPT.match(/const CTA = \/(.+)\/i;/)?.[1];
    expect(src).toBeTruthy();
    const cta = new RegExp(src!, "i");
    for (const w of ["Buy now", "Book a car", "Sign up", "Start free trial", "Get a demo", "Get a quote", "Contact us"]) expect(cta.test(w), w).toBe(true);
    expect(cta.test("Learn more")).toBe(false);
  });
});
