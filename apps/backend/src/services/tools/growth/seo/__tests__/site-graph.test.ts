
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/onboarding/enrichment/url-guard", () => ({
  assertSafeUrl: vi.fn(async () => undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { fetchForSeoAudit, extractSameSiteLinks, parseLlmsTxtPaths, MAX_PAGES, SITEMAP_RESERVE_PAGES } from "../fetch";
import { analyzeSiteGraph, faqQuestionsOf, SiteGraphLabel, type SiteGraphFinding } from "../site-graph";
import type { FetchedPage } from "../analyze";

const ORIGIN = "https://acme.com";

function page(body: string, opts: { canonical?: string | null; head?: string } = {}): string {
  const canonical =
    opts.canonical === null ? "" : `<link rel="canonical" href="${opts.canonical ?? ORIGIN + "/"}">`;
  return `<html><head><title>Acme</title>${canonical}${opts.head ?? ""}</head><body>${body}</body></html>`;
}

function faqLd(...questions: string[]): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map((q) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: "Yes." } })),
  })}</script>`;
}

const SITEMAP = `<?xml version="1.0"?><urlset>${[
  "https://acme.com/",
  "https://acme.com/pricing",
  "https://acme.com/faq",
  "https://acme.com/members",
  "https://acme.com/gone",
]
  .map((l) => `<url><loc>${l}</loc></url>`)
  .join("")}</urlset>`;

const LLMS = [
  "# Acme",
  "> Acme does things.",
  "- [Pricing](https://acme.com/pricing)",
  "- [FAQ](/faq)",
  "- [SEO channel](https://acme.com/channels/seo)",
].join("\n");

const HOME = page(`
  <nav>
    <a href="/pricing?ref=nav">Pricing</a>
    <a href="/faq#top">FAQ</a>
    <a href='/login'>Log in</a>
  </nav>
  <main>
    <a href="/channels/seo">SEO</a>
    <a href=/channels/geo>GEO</a>
    <a href="/private">Private</a>
    <a href="#pricing">Jump</a>
  </main>
  <footer>
    <a href="https://other.example.net/partner">Partner</a>
    <a href="mailto:hi@acme.com">Email</a>
    <a href="tel:+15550100">Call</a>
    <a href="javascript:void(0)">Nothing</a>
    <a href="/brochure.pdf">Brochure</a>
  </footer>`);

const PAGES: Record<string, { status: number; body?: string; location?: string }> = {
  "/": { status: 200, body: HOME },
  "/pricing": { status: 200, body: page("<h1>Pricing</h1>", { canonical: `${ORIGIN}/pricing` }) },
  "/faq": {
    status: 200,
    body: page(
      `<h1>FAQ</h1><h3>What is Acme&rsquo;s refund policy?</h3><p>Yes.</p><h3>Do you ship to Canada?</h3>`,
      { canonical: `${ORIGIN}/faq`, head: faqLd("What is Acme’s refund policy?", "Do you ship to Canada?") },
    ),
  },
  "/channels/seo": {
    status: 200,
    body: page("<h1>SEO</h1><p>Search.</p>", { canonical: null, head: faqLd("Is SEO dead?", "How long does SEO take?") }),
  },
  "/channels/geo": { status: 200, body: page("<h1>GEO</h1>", { canonical: `${ORIGIN}/channels/geo` }) },
  "/private": {
    status: 200,
    body: page("<h1>Private</h1>", { canonical: `${ORIGIN}/private`, head: '<meta name="robots" content="noindex">' }),
  },
  "/members": { status: 307, location: "/login?next=%2Fmembers" },
  "/login": { status: 200, body: page("<form>Log in</form>", { canonical: null }) },
  "/gone": { status: 404, body: "not found" },
};

let requested: string[] = [];

function stubSite(overrides: { llms?: { status: number; body: string }; sitemap?: string } = {}): void {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/robots.txt") return new Response(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`, { status: 200 });
      if (u.pathname === "/sitemap.xml") return new Response(overrides.sitemap ?? SITEMAP, { status: 200 });
      if (u.pathname === "/llms.txt") {
        const l = overrides.llms ?? { status: 200, body: LLMS };
        return new Response(l.body, { status: l.status });
      }
      requested.push(u.pathname + u.search);
      const p = PAGES[u.pathname];
      if (!p) return new Response("nope", { status: 404 });
      if (p.location) return new Response(null, { status: p.status, headers: { location: p.location } });
      return new Response(p.body ?? "", { status: p.status });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function crawl(overrides?: Parameters<typeof stubSite>[0]): Promise<SiteGraphFinding[]> {
  stubSite(overrides);
  const r = await fetchForSeoAudit(ORIGIN);
  return analyzeSiteGraph({ pages: r.pages, ...r.graph }).findings;
}

const urlsFor = (f: SiteGraphFinding[], label: SiteGraphFinding["label"]): string[] =>
  f.filter((x) => x.label === label).map((x) => x.url).sort();

describe("site graph over a fixture site", () => {
  it("fetches linked pages the sitemap leaves out", async () => {
    await crawl();
    expect(requested).toContain("/channels/seo");
    expect(requested).toContain("/channels/geo");
  });

  it("flags a linked, indexable page missing from the sitemap as an orphan", async () => {
    const f = await crawl();
    expect(urlsFor(f, "orphan")).toEqual([`${ORIGIN}/channels/geo`, `${ORIGIN}/channels/seo`]);
  });

  it("flags FAQPage JSON-LD whose questions are not visible", async () => {
    const f = await crawl();
    expect(urlsFor(f, "schema_without_visible_content")).toEqual([`${ORIGIN}/channels/seo`]);
  });

  it("gives every actionable finding the exact fix, and none to could_not_read", async () => {
    const f = await crawl();
    const fixOf = (label: string, url: string) => f.find((x) => x.label === label && x.url === url)?.fix;
    expect(fixOf("orphan", `${ORIGIN}/channels/geo`)).toBe(`Add ${ORIGIN}/channels/geo to sitemap.xml.`);
    expect(fixOf("sitemap_unreachable", `${ORIGIN}/gone`)).toBe(
      `Remove ${ORIGIN}/gone from sitemap.xml or point it at the live page.`,
    );
    expect(fixOf("schema_without_visible_content", `${ORIGIN}/channels/seo`)).toBe(
      `Show these questions and answers as visible text on ${ORIGIN}/channels/seo, or delete them from its FAQPage JSON-LD.`,
    );
    for (const x of f) {
      if (x.label === "could_not_read") expect(x.fix).toBeUndefined();
      else expect(x.fix).toEqual(expect.any(String));
    }
  });

  it("flags a sitemap URL that 307s to /login", async () => {
    const f = await crawl();
    const hit = f.filter((x) => x.label === "redirects_to_login");
    expect(hit.map((x) => x.url)).toEqual([`${ORIGIN}/members`]);
    expect(hit[0].detail).toBe("redirects to /login");
    expect(urlsFor(f, "sitemap_unreachable")).not.toContain(`${ORIGIN}/members`);
  });

  it("flags a sitemap URL that 404s as unreachable", async () => {
    const f = await crawl();
    expect(urlsFor(f, "sitemap_unreachable")).toEqual([`${ORIGIN}/gone`]);
  });

  it("flags a linked page that an existing llms.txt does not list", async () => {
    const f = await crawl();
    expect(urlsFor(f, "llms_txt_missing_page")).toEqual([`${ORIGIN}/channels/geo`]);
  });

  it("flags an indexable page with no canonical", async () => {
    const f = await crawl();
    expect(urlsFor(f, "missing_canonical")).toEqual([`${ORIGIN}/channels/seo`]);
  });

  it("every label is one the zod enum accepts", async () => {
    const f = await crawl();
    for (const x of f) expect(SiteGraphLabel.safeParse(x.label).success).toBe(true);
  });

  it("does not call a page that IS in the sitemap an orphan, even linked with a query string", async () => {
    const f = await crawl();
    const orphans = urlsFor(f, "orphan");
    expect(orphans).not.toContain(`${ORIGIN}/pricing`);
    expect(orphans).not.toContain(`${ORIGIN}/faq`);
    expect(orphans).not.toContain(`${ORIGIN}/`);
    expect(requested.filter((r) => r.startsWith("/pricing"))).toEqual(["/pricing"]);
  });

  it("does not flag FAQPage whose questions are visible", async () => {
    const f = await crawl();
    expect(urlsFor(f, "schema_without_visible_content")).not.toContain(`${ORIGIN}/faq`);
  });

  it("does not flag a noindex page as an orphan or as missing from llms.txt", async () => {
    const f = await crawl();
    expect(f.filter((x) => x.url === `${ORIGIN}/private`)).toEqual([]);
  });

  it("never follows off-site, mailto, tel, javascript, #anchor, file or login links", async () => {
    await crawl();
    for (const r of requested) {
      expect(r).not.toMatch(/partner|mailto|tel:|javascript|brochure|^#/);
    }
    expect(requested.filter((r) => r.startsWith("/login"))).toHaveLength(1);
  });

  it("never treats a query-identified sitemap entry as its bare path", async () => {
    const sitemap = `<?xml version="1.0"?><urlset>${["https://acme.com/", "https://acme.com/gone?id=7", "https://acme.com/pricing", "https://acme.com/faq"]
      .map((l) => `<url><loc>${l.replace("&", "&amp;")}</loc></url>`)
      .join("")}</urlset>`;
    const f = await crawl({ sitemap });
    expect(urlsFor(f, "sitemap_unreachable")).toEqual([]);
    expect(requested).not.toContain("/gone");
  });

  it("does not call a page an orphan when the sitemap lists it only with a query", () => {
    const r = analyzeSiteGraph({
      pages: [{ url: `${ORIGIN}/product`, status: 200, headers: {}, html: page("<h1>P</h1>", { canonical: `${ORIGIN}/product` }) }],
      sitemap_paths: ["/", "/product"],
      sitemap_query_only_paths: ["/product"],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: ["/product"],
    });
    expect(r.findings).toEqual([]);
  });

  it("skips the llms.txt check when there is no llms.txt", async () => {
    const f = await crawl({ llms: { status: 404, body: "" } });
    expect(urlsFor(f, "llms_txt_missing_page")).toEqual([]);
  });

  it("skips the llms.txt check when /llms.txt is an HTML app shell", async () => {
    const f = await crawl({ llms: { status: 200, body: "<!doctype html><html><body>app</body></html>" } });
    expect(urlsFor(f, "llms_txt_missing_page")).toEqual([]);
  });

  it("skips the orphan check when the sitemap was not read to the end", async () => {
    stubSite({ sitemap: SITEMAP.replace("</urlset>", "") });
    const r = await fetchForSeoAudit(ORIGIN);
    expect(r.graph.sitemap_complete).toBe(false);
    const report = analyzeSiteGraph({ pages: r.pages, ...r.graph });
    expect(report.findings.filter((x) => x.label === "orphan")).toEqual([]);
    expect(report.skipped.join(" ")).toMatch(/only partly read/);
  });
});

describe("page selection under the budget", () => {
  function stubBig(linkedCount: number): void {
    requested = [];
    const links = Array.from({ length: linkedCount }, (_, i) => `<a href="/unlisted/${i}">u</a>`).join("");
    const sitemap = `<?xml version="1.0"?><urlset>${Array.from({ length: 50 }, (_, i) => `<loc>${ORIGIN}/s${i}/page</loc>`).join("")}</urlset>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/robots.txt") return new Response(`Sitemap: ${ORIGIN}/sitemap.xml\n`, { status: 200 });
        if (u.pathname === "/sitemap.xml") return new Response(sitemap, { status: 200 });
        if (u.pathname === "/llms.txt") return new Response("", { status: 404 });
        requested.push(u.pathname);
        return new Response(page(u.pathname === "/" ? links : "<h1>x</h1>"), { status: 200 });
      }),
    );
  }

  it("fetches every orphan candidate when they fit, and still stays within MAX_PAGES", async () => {
    stubBig(5);
    const r = await fetchForSeoAudit(ORIGIN);
    for (let i = 0; i < 5; i++) expect(requested).toContain(`/unlisted/${i}`);
    expect(r.pages).toHaveLength(MAX_PAGES);
  });

  it("keeps sitemap slots when the nav links far more unlisted pages than the budget", async () => {
    stubBig(60);
    const r = await fetchForSeoAudit(ORIGIN);
    expect(r.pages).toHaveLength(MAX_PAGES);
    expect(requested.filter((p) => p.startsWith("/s")).length).toBe(SITEMAP_RESERVE_PAGES);
  });
});

describe("site graph pure rules", () => {
  const ok = (path: string, html: string, extra: Partial<FetchedPage> = {}): FetchedPage => ({
    url: `${ORIGIN}${path}`,
    status: 200,
    headers: {},
    html,
    ...extra,
  });

  it("reports a refusal or no response as could_not_read, never as a broken sitemap entry", () => {
    const r = analyzeSiteGraph({
      pages: [
        { url: `${ORIGIN}/a`, status: 403, headers: {}, html: "" },
        { url: `${ORIGIN}/b`, status: 0, headers: {}, html: "" },
      ],
      sitemap_paths: ["/a", "/b"],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: [],
    });
    expect(r.findings).toEqual([
      { label: "could_not_read", url: `${ORIGIN}/a`, detail: "HTTP 403" },
      { label: "could_not_read", url: `${ORIGIN}/b`, detail: "no response" },
    ]);
  });

  it("does not call a page whose canonical names another path an orphan", () => {
    const r = analyzeSiteGraph({
      pages: [ok("/pricing-v2", page("x", { canonical: `${ORIGIN}/pricing` }))],
      sitemap_paths: ["/pricing"],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: ["/pricing-v2"],
    });
    expect(r.findings).toEqual([]);
  });

  it("reads a canonical whatever the attribute order, and never asks a Markdown file for one", () => {
    const r = analyzeSiteGraph({
      pages: [
        ok("/", `<html><head><link href="${ORIGIN}/" rel="canonical"></head><body>hi</body></html>`),
        ok("/pricing.md", "# Pricing", { headers: { "content-type": "text/markdown; charset=utf-8" } }),
      ],
      sitemap_paths: ["/", "/pricing.md"],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: [],
    });
    expect(r.findings).toEqual([]);
  });

  it("never asks for a Markdown or text file in the sitemap or llms.txt", () => {
    const r = analyzeSiteGraph({
      pages: [
        ok("/", `<html><head><link rel="canonical" href="${ORIGIN}/"></head><body>hi</body></html>`),
        ok("/auth.md", "# Auth\n\nSign in with a token.", { headers: { "content-type": "text/markdown" } }),
        ok("/notes.txt", "plain notes", { headers: { "content-type": "text/plain" } }),
        ok("/docs.md", "# Docs", { headers: { "content-type": "text/markdown" } }),
      ],
      sitemap_paths: ["/", "/docs.md"],
      sitemap_complete: true,
      llms_txt_paths: ["/", "/auth.md", "/notes.txt"],
      linked_paths: ["/auth.md", "/docs.md"],
    });
    expect(r.findings).toEqual([]);
  });

  const graph = (pages: FetchedPage[], extra: Partial<Parameters<typeof analyzeSiteGraph>[0]> = {}) =>
    analyzeSiteGraph({ pages, sitemap_paths: ["/", "/out"], sitemap_complete: true, llms_txt_paths: null, linked_paths: [], ...extra });

  it("fixes a missing canonical and a missing llms.txt line with the exact line", () => {
    const canon = analyzeSiteGraph({
      pages: [ok("/a", "<html><head></head><body>hi</body></html>")],
      sitemap_paths: ["/a"],
      sitemap_complete: true,
      llms_txt_paths: ["/b"],
      linked_paths: [],
    }).findings;
    expect(canon.find((x) => x.label === "missing_canonical")?.fix).toBe(
      `Add <link rel="canonical" href="${ORIGIN}/a"> to the page head.`,
    );
    expect(canon.find((x) => x.label === "llms_txt_missing_page")?.fix).toBe(`Add a line for ${ORIGIN}/a to /llms.txt.`);
  });

  it("names up to three hidden FAQ questions in the detail", () => {
    const r = analyzeSiteGraph({
      pages: [ok("/", page("<p>nothing</p>", { head: faqLd("One?", "Two?", "Three?", "Four?") }))],
      sitemap_paths: ["/"],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: [],
    });
    const faq = r.findings.find((x) => x.label === "schema_without_visible_content")!;
    expect(faq.detail).toBe(
      `FAQPage JSON-LD: 4 of 4 questions are not in the page's HTML text: "One?"; "Two?"; "Three?"; and 1 more`,
    );
  });

  it("never judges another host's page as ours when a redirect leaves the site", () => {
    const r = graph([ok("/out", page("vendor", { canonical: null, head: faqLd("Vendor question?") }), { final_url: "https://vendor.example/out" })], {
      sitemap_paths: ["/"],
      linked_paths: ["/out"],
    });
    expect(r.findings.map((f) => f.label)).not.toContain("orphan");
    expect(r.findings.map((f) => f.label)).not.toContain("missing_canonical");
    expect(r.findings.map((f) => f.label)).not.toContain("schema_without_visible_content");
  });

  it("matches a FAQ question written with named or numeric entities in the visible HTML", () => {
    const html = page("<h3>What is Caf&eacute; pricing?</h3><p>It&#8217;s &quot;free&quot;</p>", { head: faqLd("What is Café pricing?", "It’s \"free\"") });
    expect(graph([ok("/", html)]).findings).toEqual([]);
  });

  it("survives an out-of-range numeric entity instead of aborting the audit", () => {
    const html = page("<p>&#999999999; &#x110000;</p>", { head: faqLd("Hidden?") });
    expect(graph([ok("/", html)]).findings).toEqual([
      { label: "schema_without_visible_content", url: `${ORIGIN}/`, detail: expect.any(String), fix: expect.any(String) },
    ]);
  });

  it("still calls an off-site login redirect a login wall, and never repeats the target's query", () => {
    const r = graph([ok("/docs", "", { status: 200, final_url: "https://auth.vendor.com/login?sig=SECRET" })], {
      sitemap_paths: ["/"],
      llms_txt_paths: ["/docs"],
    });
    expect(r.findings).toEqual([
      {
        label: "redirects_to_login",
        url: `${ORIGIN}/docs`,
        detail: "redirects to auth.vendor.com/login",
        fix: `Take ${ORIGIN}/docs out of the sitemap and llms.txt, or make it public.`,
      },
    ]);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("matches a caron entity", () => {
    const html = page("<h3>Who is Ale&scaron;?</h3>", { head: faqLd("Who is Aleš?") });
    expect(graph([ok("/", html)]).findings).toEqual([]);
  });

  it("reads an unquoted canonical", () => {
    const html = `<html><head><link rel=canonical href=${ORIGIN}/></head><body>hi</body></html>`;
    expect(graph([ok("/", html)]).findings).toEqual([]);
  });

  it("does not assert an absence on a truncated page", () => {
    const r = analyzeSiteGraph({
      pages: [ok("/big", page("x", { canonical: null, head: faqLd("Hidden?") }), { truncated: true })],
      sitemap_paths: ["/big"],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: [],
    });
    expect(r.findings).toEqual([]);
  });

  it("reads FAQ questions from an @graph and ignores broken JSON-LD", () => {
    const html =
      '<script type="application/ld+json">{broken</script>' +
      `<script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "FAQPage", mainEntity: { "@type": "Question", name: "One?" } }] })}</script>`;
    expect(faqQuestionsOf(html)).toEqual(["One?"]);
  });
});

describe("link and llms.txt extraction", () => {
  it("keeps same-site paths only, without query or fragment", () => {
    const html = `
      <a href="/a?x=1#y">a</a><a href="https://www.acme.com/b/">b</a><a href="http://acme.com/insecure">c</a>
      <a href="https://evil.example.net/x">d</a><a href="mailto:x@acme.com">e</a><a href="tel:1">f</a>
      <a href="#top">g</a><a href="">h</a><a href="relative">i</a>`;
    expect(extractSameSiteLinks(html, `${ORIGIN}/dir/`, "acme.com").sort()).toEqual(["/a", "/b", "/dir/relative"]);
  });

  it("reads markdown links and bare URLs from llms.txt", () => {
    const body = "- [A](/a)\n- [B](https://acme.com/b)\nSee https://acme.com/c and https://other.net/d";
    expect(parseLlmsTxtPaths(body, ORIGIN, "acme.com")?.sort()).toEqual(["/a", "/b", "/c"]);
  });
});
