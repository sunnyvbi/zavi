import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/marketing/growth-home/GrowthHeader", () => ({ GrowthHeader: () => null }));
vi.mock("@/components/marketing/growth-home/GrowthFooter", () => ({ GrowthFooter: () => null }));
vi.mock("@/fonts", () => ({ jakarta: { variable: "" } }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/resolveCta", () => ({ resolveMarketingSession: async () => ({ cta: { href: "/start", label: "Start" }, email: null }) }));

import BlogPostPage, { generateMetadata, generateStaticParams } from "./page";
import BlogIndexPage from "../page";
import { BLOG_POSTS } from "@/lib/marketing/blog";

const ld = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("/blog/<slug>", () => {
  it("prerenders every post", () => {
    expect(generateStaticParams().map((p) => p.slug).sort()).toEqual(BLOG_POSTS.map((p) => p.slug).sort());
  });

  it.each(BLOG_POSTS.map((p) => [p.slug, p] as const))("%s renders answer, byline, FAQ and Article/FAQ/Breadcrumb JSON-LD", async (slug, p) => {
    const html = renderToStaticMarkup(await BlogPostPage({ params: Promise.resolve({ slug }) }));
    const t = visible(html);
    expect(t).toContain(p.answer);
    expect(t).toContain("By Ravi Ramadasu, Founder, Zavi");
    for (const f of p.faq) expect(t).toContain(f.q);
    const types = ld(html).map((j) => j["@type"]);
    expect(types).toEqual(expect.arrayContaining(["Article", "FAQPage", "BreadcrumbList"]));
    const article = ld(html).find((j) => j["@type"] === "Article");
    expect(article.author).toMatchObject({ "@type": "Person", name: "Ravi Ramadasu" });
    expect(article.mainEntityOfPage).toBe(`https://www.zaviagent.com/blog/${slug}`);
    expect(html).not.toMatch(/<img\b/);
  });

  it("metadata: article type, canonical, dates; an unknown slug 404s instead of inheriting the home title", async () => {
    const p = BLOG_POSTS[0];
    const m = await generateMetadata({ params: Promise.resolve({ slug: p.slug }) });
    expect(m.alternates?.canonical).toBe(`https://www.zaviagent.com/blog/${p.slug}`);
    expect(m.openGraph).toMatchObject({ type: "article", publishedTime: `${p.datePublished}T12:00:00.000Z` });
    await expect(generateMetadata({ params: Promise.resolve({ slug: "not-a-post" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("an unknown slug 404s", async () => {
    await expect(BlogPostPage({ params: Promise.resolve({ slug: "not-a-post" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the index lists every post, newest first", async () => {
    const html = renderToStaticMarkup(await BlogIndexPage());
    for (const p of BLOG_POSTS) expect(html).toContain(`href="/blog/${p.slug}"`);
    expect(ld(html).find((j) => j["@type"] === "ItemList").numberOfItems).toBe(BLOG_POSTS.length);
  });
});
