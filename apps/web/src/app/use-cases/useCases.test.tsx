
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/marketing/growth-home/fonts", () => ({
  jakartaHeavy: { className: "font-jakarta-heavy" },
  caveat: { className: "font-caveat" },
}));
vi.mock("next/headers", () => ({
  headers: () => new Headers({ host: "www.zaviagent.com" }),
}));

import { USE_CASES, findUseCase, pathForUseCase } from "@/lib/marketing/useCases";
import { UseCaseIndexBody, UseCasePageBody } from "@/components/marketing/growth-home/useCases/UseCasePageBody";
import { NAV_MENUS } from "@/components/marketing/growth-home/growthNavData";
import { readChannelLine } from "@/components/marketing/pricingChannels";
import { generateMetadata, generateStaticParams } from "./[slug]/page";
import sitemap from "../sitemap";

vi.mock("@/lib/marketing/liveUpcar", () => ({ getLivePillSlug: async () => null, getLiveUpcar: async () => null }));

const SLUGS = [
  "saas",
  "startups",
  "ecommerce",
  "marketplaces",
  "agencies",
  "professional-services",
  "small-business",
  "local-services",
  "restaurants",
  "real-estate",
  "healthcare",
  "financial-advisors",
  "law-firms",
];

const render = (slug: string) => renderToStaticMarkup(<UseCasePageBody u={findUseCase(slug)!} startHref="/start" />);
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

describe("use-case data", () => {
  it("has exactly the 13 agreed slugs, in order", () => {
    expect(USE_CASES.map((u) => u.slug)).toEqual(SLUGS);
  });

  it("generates a static param per slug", () => {
    expect(generateStaticParams()).toEqual(SLUGS.map((slug) => ({ slug })));
  });

  it("every page has a unique title, description, headline and canonical", async () => {
    const metas = await Promise.all(SLUGS.map((slug) => generateMetadata({ params: Promise.resolve({ slug }) })));
    for (const key of ["title", "description"] as const) {
      const values = metas.map((m) => m[key]);
      expect(values.every(Boolean)).toBe(true);
      expect(new Set(values).size).toBe(SLUGS.length);
    }
    const canonicals = metas.map((m) => m.alternates?.canonical);
    expect(canonicals).toEqual(SLUGS.map((s) => `https://www.zaviagent.com/use-cases/${s}`));
    expect(new Set(USE_CASES.map((u) => u.headline)).size).toBe(SLUGS.length);
    expect(new Set(USE_CASES.map((u) => u.subline)).size).toBe(SLUGS.length);
    expect(new Set(USE_CASES.map((u) => u.findYou)).size).toBe(SLUGS.length);
    expect(new Set(USE_CASES.map((u) => u.outcome)).size).toBe(SLUGS.length);
  });

  it("no two pages share a play, a prompt, or a first-week step (not a noun swap)", () => {
    const plays = USE_CASES.flatMap((u) => u.plays.map((p) => p.title));
    expect(new Set(plays).size).toBe(plays.length);
    const bodies = USE_CASES.flatMap((u) => u.plays.map((p) => p.body));
    expect(new Set(bodies).size).toBe(bodies.length);
    const asks = USE_CASES.flatMap((u) => u.asks);
    expect(new Set(asks).size).toBe(asks.length);
    const steps = USE_CASES.flatMap((u) => u.firstWeek);
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("every page has the required shape", () => {
    for (const u of USE_CASES) {
      expect(u.plays.length, u.slug).toBeGreaterThanOrEqual(4);
      expect(u.plays.length, u.slug).toBeLessThanOrEqual(5);
      expect(u.metrics.length, u.slug).toBeGreaterThanOrEqual(2);
      expect(u.metrics.length, u.slug).toBeLessThanOrEqual(3);
      expect(u.asks.length, u.slug).toBe(3);
      expect(u.channels.length, u.slug).toBeGreaterThan(0);
    }
  });

  it("every channel chip is a channel the brand-mark table knows", () => {
    for (const u of USE_CASES) {
      for (const c of u.channels) expect(readChannelLine(c.name).mark, `${u.slug}: ${c.name}`).not.toBeNull();
    }
  });

  it("the regulated types carry a review note and no other type does", () => {
    const withNote = USE_CASES.filter((u) => u.reviewNote).map((u) => u.slug);
    expect(withNote.sort()).toEqual(["financial-advisors", "healthcare", "law-firms"]);
  });
});

describe("use-case pages render", () => {
  it.each(SLUGS)("%s renders its own headline, plays and CTAs", (slug) => {
    const u = findUseCase(slug)!;
    const html = decode(render(slug));
    expect(html).toContain(u.headline);
    expect(html).toContain(u.findYou);
    for (const p of u.plays) expect(html).toContain(p.title);
    for (const m of u.metrics) expect(html).toContain(m.label);
    for (const a of u.asks) expect(html).toContain(a);
    expect(html).toContain('href="/start"');
    expect(html).toContain("Start free");
    expect(html).toContain('href="/pricing"');
    expect((html.match(/data-testid="use-case-play"/g) ?? []).length).toBe(u.plays.length);
  });

  it("only the marketplaces page carries the Upcar proof block", () => {
    for (const slug of SLUGS) {
      const html = render(slug);
      const hasProof = html.includes('data-testid="upcar-proof"');
      expect(hasProof, slug).toBe(slug === "marketplaces");
      if (slug !== "marketplaces") expect(html, slug).not.toContain("Upcar");
    }
    expect(decode(render("marketplaces"))).toContain('href="/live/upcar"');
  });

  it("the index lists all 13 pages", () => {
    const html = renderToStaticMarkup(<UseCaseIndexBody startHref="/start" />);
    for (const slug of SLUGS) expect(html).toContain(`href="${pathForUseCase(slug)}"`);
  });

  it("an unknown slug has no metadata (the page 404s)", async () => {
    expect(findUseCase("not-a-type")).toBeUndefined();
    expect(await generateMetadata({ params: Promise.resolve({ slug: "not-a-type" }) })).toEqual({});
  });
});

describe("use cases in the sitemap and the header menu", () => {
  it("the sitemap lists the index and every page", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain("https://www.zaviagent.com/use-cases");
    for (const slug of SLUGS) expect(urls).toContain(`https://www.zaviagent.com/use-cases/${slug}`);
  });

  it("the Use cases menu lists all 13, links to the index, and its panel starts the plan", () => {
    const menu = NAV_MENUS.useCases;
    expect(menu.label).toBe("Use case");
    expect(menu.items.map((i) => i.href)).toEqual(SLUGS.map((s) => `/use-cases/${s}`));
    expect(menu.more).toEqual({ label: "See all use cases", href: "/use-cases" });
    expect(menu.panel).toBe("useCases");
    expect("aside" in menu).toBe(false);
  });

  it("every type carries a four-day week, with no em dashes", () => {
    for (const u of USE_CASES) {
      expect(u.week.owner, u.slug).toMatch(/^Your /);
      expect(u.week.days, u.slug).toHaveLength(4);
      for (const t of [u.week.owner, ...u.week.days]) expect(t, u.slug).not.toMatch(/[\u2014\u2013]/);
    }
  });

  it("the marketplaces proof names Upcar without the old host and state counts", () => {
    const body = findUseCase("marketplaces")!.proof!.body;
    expect(body).toContain("Zavi runs on Upcar, a live P2P car rental company.");
    expect(body).not.toMatch(/600|5 states/);
  });
});
