import { describe, it, expect } from "vitest";
import { BLOG_POSTS, findPost, pathForPost } from ".";

const text = (p: (typeof BLOG_POSTS)[number]) => [p.title, p.description, p.h1, p.answer, p.body, ...p.faq.flatMap((f) => [f.q, f.a]), p.cta.text].join("\n");

const SITE_LINK = /^\/(start|pricing|about|blog(\/[a-z0-9-]+)?|channels\/[a-z-]+|live\/upcar(\/day\/[1-9]\d?)?)$/;

describe("blog posts", () => {
  it("slugs, titles and target searches are unique (no two pages chase one query)", () => {
    for (const key of ["slug", "title", "h1", "query"] as const) {
      const vals = BLOG_POSTS.map((p) => p[key].toLowerCase());
      expect(new Set(vals).size, key).toBe(vals.length);
    }
  });

  it.each(BLOG_POSTS.map((p) => [p.slug, p] as const))("%s: answer first, a real FAQ, a CTA to a real page, valid dates", (_s, p) => {
    expect(p.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(p.answer.length).toBeGreaterThan(80);
    expect(p.faq.length).toBeGreaterThanOrEqual(3);
    expect(p.cta.href).toMatch(SITE_LINK);
    for (const d of [p.datePublished, p.dateModified, p.reviewedAt]) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.dateModified >= p.datePublished).toBe(true);
    expect(p.description.length).toBeLessThanOrEqual(220);
  });

  it.each(BLOG_POSTS.map((p) => [p.slug, p] as const))("%s: no Zavi price or plan placement (they change by config)", (_s, p) => {
    const t = text(p);
    expect(t).not.toMatch(/\/mo\b|per month|a month\b|\bStarter\b|\bPro plan\b|\bGrowth plan\b|\bFree plan\b|free tier|credits a day/i);
    if (p.slug !== "can-ai-run-my-facebook-ads") expect(t).not.toMatch(/\$\d/);
  });

  it.each(BLOG_POSTS.map((p) => [p.slug, p] as const))("%s: no em dashes, no claim about the model Zavi runs on", (_s, p) => {
    const t = text(p);
    expect(t).not.toContain("—");
    expect(t).not.toMatch(/(built|runs|running) on (claude|gpt|openai|anthropic)|powered by/i);
  });

  it.each(BLOG_POSTS.map((p) => [p.slug, p] as const))("%s: every site link in the body points at a page that exists", (_s, p) => {
    const links = [...p.body.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]);
    for (const href of links) expect(href, href).toMatch(SITE_LINK);
    for (const s of p.sources) expect(s.url.startsWith("https://") || SITE_LINK.test(s.url), s.url).toBe(true);
  });

  it("the list is newest first", () => {
    const dates = BLOG_POSTS.map((p) => p.datePublished);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("findPost / pathForPost", () => {
    expect(findPost("nope")).toBeUndefined();
    expect(pathForPost(BLOG_POSTS[0].slug)).toBe(`/blog/${BLOG_POSTS[0].slug}`);
  });
});
