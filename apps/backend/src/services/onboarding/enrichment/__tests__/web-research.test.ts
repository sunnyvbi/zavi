
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { researchCompany, researchQueries, RESEARCH_QUERY_COUNT } from "../web-research";

const originalFetch = globalThis.fetch;

function apifyResponse(items: unknown[]): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("researchCompany", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.APIFY_TOKEN;
  });

  it("returns [] and makes no call when APIFY_TOKEN is missing", async () => {
    delete process.env.APIFY_TOKEN;
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;
    expect(await researchCompany("Turo", "turo.com")).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("anchors a shared host on the FULL hostname, not the hosting provider", async () => {
    globalThis.fetch = vi.fn(async () =>
      apifyResponse([
        {
          metadata: { url: "https://render.com/pricing", title: "Render pricing" },
          markdown: "Deploy anything on onrender.com with our hosting plans. ".repeat(8),
        },
        {
          metadata: { url: "https://acme-shop-a613c47c.onrender.com/about", title: "Acme Shop" },
          markdown:
            "Acme Shop at acme-shop-a613c47c.onrender.com sells handmade ceramics. ".repeat(8),
        },
      ]),
    ) as unknown as typeof globalThis.fetch;
    const pages = await researchCompany("Acme Shop", "acme-shop-a613c47c.onrender.com");
    expect(pages.map((p) => p.url)).toEqual(["https://acme-shop-a613c47c.onrender.com/about"]);
  });

  it("keeps only results that mention the operator domain (anti-poison)", async () => {
    globalThis.fetch = vi.fn(async () =>
      apifyResponse([
        {
          metadata: { url: "https://trustpilot.com/review/turo.com", title: "Turo Reviews" },
          markdown: "Genuine customer reviews of turo.com and the rental experience. ".repeat(8),
        },
        {
          metadata: { url: "https://praxis-ai.com/", title: "Wrong Praxis" },
          markdown: "Totally unrelated same-named company content here. ".repeat(8),
        },
      ]),
    ) as unknown as typeof globalThis.fetch;
    const r = await researchCompany("Turo", "turo.com");
    expect(r.length).toBe(1);
    expect(r[0].url).toContain("turo.com");
    expect(r.every((p) => !p.url.includes("praxis-ai"))).toBe(true);
  });

  it("returns [] (no poison) when nothing mentions the domain — generic-name case", async () => {
    globalThis.fetch = vi.fn(async () =>
      apifyResponse([
        { metadata: { url: "https://praxis-ai.com/", title: "Praxis AI" }, markdown: "manufacturing agents ".repeat(20) },
        { metadata: { url: "https://praxislabs.com/", title: "Praxis Labs" }, markdown: "learning company acquired ".repeat(20) },
      ]),
    ) as unknown as typeof globalThis.fetch;
    expect(await researchCompany("Praxis", "zaviagent.com")).toEqual([]);
  });

  it("escapes the excerpt (same trust boundary as fetched pages)", async () => {
    globalThis.fetch = vi.fn(async () =>
      apifyResponse([
        {
          metadata: { url: "https://reviews.io/turo.com", title: "t" },
          markdown: "Rates & fees on turo.com are fair and clear. ".repeat(8),
        },
      ]),
    ) as unknown as typeof globalThis.fetch;
    const r = await researchCompany("Turo", "turo.com");
    expect(r.length).toBe(1);
    expect(r[0].text_excerpt).toContain("&amp;");
    expect(r[0].text_excerpt).not.toMatch(/[^&]& /);
  });

  it("dedupes identical URLs across the queries", async () => {
    globalThis.fetch = vi.fn(async () =>
      apifyResponse([
        { metadata: { url: "https://trustpilot.com/review/turo.com", title: "Turo" }, markdown: "reviews of turo.com here ".repeat(8) },
      ]),
    ) as unknown as typeof globalThis.fetch;
    const r = await researchCompany("Turo", "turo.com");
    expect(r.length).toBe(1);
  });

  it("never throws on an Apify error/non-200", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch;
    expect(await researchCompany("Turo", "turo.com")).toEqual([]);
  });

  it("RESEARCH_QUERY_COUNT matches the query list AND the calls actually made", async () => {
    expect(researchQueries("Turo", "turo.com")).toHaveLength(RESEARCH_QUERY_COUNT);
    const fetchMock = vi.fn(async () => apifyResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await researchCompany("Turo", "turo.com");
    expect(fetchMock).toHaveBeenCalledTimes(RESEARCH_QUERY_COUNT);
  });

  it("every query is domain-anchored (the anti-poison guard starts here)", () => {
    for (const q of researchQueries("Turo", "turo.com")) {
      expect(q).toContain("turo.com");
      expect(q).toContain("Turo");
    }
    expect(new Set(researchQueries("Turo", "turo.com")).size).toBe(RESEARCH_QUERY_COUNT);
  });

  it("keeps up to 10 pages (widened from 4)", async () => {
    const items = Array.from({ length: 14 }, (_, i) => ({
      metadata: { url: `https://reviews.io/turo.com/page-${i}`, title: `Turo ${i}` },
      markdown: `Review number ${i} of turo.com and the rental experience. `.repeat(8),
    }));
    globalThis.fetch = vi.fn(async () => apifyResponse(items)) as unknown as typeof globalThis.fetch;
    const r = await researchCompany("Turo", "turo.com");
    expect(r).toHaveLength(10);
    expect(new Set(r.map((p) => p.url)).size).toBe(10);
  });

  it("excerpts are capped at 8KB (widened from 4KB)", async () => {
    globalThis.fetch = vi.fn(async () =>
      apifyResponse([
        {
          metadata: { url: "https://reviews.io/turo.com", title: "t" },
          markdown: "turo com review text here. ".repeat(2_000),
        },
      ]),
    ) as unknown as typeof globalThis.fetch;
    const r = await researchCompany("Turo", "turo.com");
    expect(r).toHaveLength(1);
    expect(r[0].text_excerpt.length).toBe(8 * 1024);
  });
});

import { dedupKey, isOwnDomainUrl } from "../web-research";

describe("dedupKey", () => {
  it("collapses urls that differ only by tracking params", () => {
    expect(dedupKey("https://sightglasscoffee.com/pages/reviews?srsltid=AU7gw4Wq4b0O")).toBe(
      dedupKey("https://sightglasscoffee.com/pages/reviews?srsltid=AU7gw4XRr-IOrBe"),
    );
  });

  it("keeps genuinely different paths apart", () => {
    expect(dedupKey("https://a.example/one")).not.toBe(dedupKey("https://a.example/two"));
  });

  it("ignores www and a trailing slash", () => {
    expect(dedupKey("https://www.a.example/x/")).toBe(dedupKey("https://a.example/x"));
  });

  it("does not throw on a malformed url", () => {
    expect(dedupKey("not a url")).toBe("not a url");
  });
});

describe("isOwnDomainUrl", () => {
  it("recognises the operator's own site and its subdomains", () => {
    expect(isOwnDomainUrl("https://sightglasscoffee.com/pages/faq", "sightglasscoffee.com")).toBe(true);
    expect(isOwnDomainUrl("https://shop.sightglasscoffee.com/", "sightglasscoffee.com")).toBe(true);
  });

  it("does not claim a third-party page", () => {
    expect(isOwnDomainUrl("https://www.linkedin.com/company/sightglass", "sightglasscoffee.com")).toBe(false);
    expect(isOwnDomainUrl("https://notsightglasscoffee.com/x", "sightglasscoffee.com")).toBe(false);
  });
});

describe("research ordering", () => {
  type Cand = { url: string; own: boolean };
  const order = (cands: Cand[], ownFirst: boolean) =>
    [...cands]
      .sort((a, b) => (ownFirst ? Number(b.own) - Number(a.own) : Number(a.own) - Number(b.own)))
      .map((c) => c.url);

  const candidates: Cand[] = [
    { url: "own-1", own: true },
    { url: "third-1", own: false },
    { url: "own-2", own: true },
    { url: "third-2", own: false },
  ];

  it("defaults to third-party first, for callers that already crawled the site", () => {
    expect(order(candidates, false)).toEqual(["third-1", "third-2", "own-1", "own-2"]);
  });

  it("puts the operator's own pages first when the caller has no crawl", () => {
    expect(order(candidates, true)).toEqual(["own-1", "own-2", "third-1", "third-2"]);
  });

  it("is stable within each group, so query order still breaks ties", () => {
    expect(order(candidates, true).slice(0, 2)).toEqual(["own-1", "own-2"]);
    expect(order(candidates, false).slice(0, 2)).toEqual(["third-1", "third-2"]);
  });
});
