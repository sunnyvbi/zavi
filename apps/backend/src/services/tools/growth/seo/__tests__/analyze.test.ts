
import { describe, it, expect } from "vitest";
import {
  analyzeSeo,
  isPrivatePath,
  parseRobots,
  titleOf,
  metaDescriptionOf,
  canonicalOf,
  h1CountOf,
  schemaTypesOf,
  isNoindex,
  isHtmlPage,
  visibleWordCount,
  type FetchedPage,
} from "../analyze";

const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({
  url: "https://example.com/",
  status: 200,
  headers: {},
  html: "<html><head><title>Home</title></head><body><h1>Hi</h1>" +
    "<p>" + "word ".repeat(100) + "</p></body></html>",
  ...over,
});

describe("extractors", () => {
  it("reads a title and strips nested markup", () => {
    expect(titleOf("<title>A <b>B</b> C</title>")).toBe("A B C");
    expect(titleOf("<html></html>")).toBeNull();
  });

  it("reads a meta description regardless of attribute order", () => {
    expect(
      metaDescriptionOf('<meta name="description" content="Hello there">'),
    ).toBe("Hello there");
    expect(metaDescriptionOf("<meta name=\"keywords\" content=\"x\">")).toBeNull();
  });

  it("reads a canonical href", () => {
    expect(canonicalOf('<link rel="canonical" href="https://a.com/x">')).toBe(
      "https://a.com/x",
    );
  });

  it("counts H1s", () => {
    expect(h1CountOf("<h1>a</h1><h1>b</h1>")).toBe(2);
    expect(h1CountOf("<h2>a</h2>")).toBe(0);
  });

  it("does not count script or style text as visible words", () => {
    const html = "<style>a{color:red}</style><script>var x=1;</script><p>one two</p>";
    expect(visibleWordCount(html)).toBe(2);
  });
});

describe("schemaTypesOf", () => {
  it("collects @type from nested JSON-LD", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Organization",
       "makesOffer":{"@type":"Offer","price":"1"}}
    </script>`;
    expect(schemaTypesOf(html).sort()).toEqual(["Offer", "Organization"]);
  });

  it("ignores a malformed block instead of throwing", () => {
    const html = `<script type="application/ld+json">{ not json </script>`;
    expect(schemaTypesOf(html)).toEqual([]);
  });

  it("handles an array @type and de-duplicates", () => {
    const html = `<script type="application/ld+json">
      [{"@type":["Product","Thing"]},{"@type":"Product"}]</script>`;
    expect(schemaTypesOf(html).sort()).toEqual(["Product", "Thing"]);
  });
});

describe("isNoindex", () => {
  it("detects a meta robots noindex", () => {
    expect(isNoindex(page({ html: '<meta name="robots" content="noindex, follow">' }))).toBe(true);
  });
  it("detects an X-Robots-Tag header", () => {
    expect(isNoindex(page({ headers: { "x-robots-tag": "noindex" } }))).toBe(true);
  });
  it("is false when only 'index' is present", () => {
    expect(isNoindex(page({ html: '<meta name="robots" content="index, follow">' }))).toBe(false);
  });
});

describe("parseRobots", () => {
  it("reports fetched:false for an unreachable file rather than assuming allow", () => {
    const r = parseRobots(null);
    expect(r).toEqual({ fetched: false, disallowsAll: false, sitemaps: [] });
  });

  it("detects a global disallow only under User-agent: *", () => {
    expect(parseRobots("User-agent: *\nDisallow: /").disallowsAll).toBe(true);
    expect(parseRobots("User-agent: BadBot\nDisallow: /").disallowsAll).toBe(false);
  });

  it("collects sitemap declarations and ignores comments", () => {
    const r = parseRobots("# hi\nSitemap: https://a.com/sitemap.xml\nUser-agent: *\nAllow: /");
    expect(r.sitemaps).toEqual(["https://a.com/sitemap.xml"]);
    expect(r.disallowsAll).toBe(false);
  });
});

describe("analyzeSeo", () => {
  const robotsOk = { fetched: true, disallowsAll: false, sitemaps: ["https://example.com/sitemap.xml"] };
  const codes = (r: ReturnType<typeof analyzeSeo>) => r.findings.map((f) => f.code);

  it("returns no findings for a healthy page", () => {
    const html =
      "<html><head><title>Acme CRM for dentists</title>" +
      '<meta name="description" content="Scheduling for dental practices.">' +
      '<script type="application/ld+json">{"@type":"Organization"}</script>' +
      "</head><body><h1>Acme</h1><p>" + "word ".repeat(100) + "</p></body></html>";
    const r = analyzeSeo({ pages: [page({ html })], robots: robotsOk, sitemapReachable: true });
    expect(r.findings).toEqual([]);
    expect(r.pages_analyzed).toBe(1);
  });

  it("flags a site-wide robots disallow as a blocker", () => {
    const r = analyzeSeo({
      pages: [page()],
      robots: { fetched: true, disallowsAll: true, sitemaps: [] },
      sitemapReachable: null,
    });
    const f = r.findings.find((x) => x.code === "robots_disallow_all");
    expect(f?.severity).toBe("blocker");
    expect(f?.scope).toBe("site");
  });

  it("flags noindex as a blocker and says so differently when it is every page", () => {
    const noidx = '<meta name="robots" content="noindex">';
    const all = analyzeSeo({
      pages: [page({ html: noidx }), page({ url: "https://example.com/a", html: noidx })],
      robots: robotsOk,
      sitemapReachable: true,
    });
    const allF = all.findings.find((f) => f.code === "noindex");
    expect(allF?.summary).toMatch(/Every page/);
    expect(allF?.severity).toBe("blocker");
    expect(allF?.scope).toBe("site");

    const some = analyzeSeo({
      pages: [page({ html: noidx }), page({ url: "https://example.com/a" })],
      robots: robotsOk,
      sitemapReachable: true,
    });
    const someF = some.findings.find((f) => f.code === "noindex");
    expect(someF?.summary).toMatch(/1 of 2/);
    expect(someF?.severity).toBe("blocker");
    expect(someF?.scope).toBe("partial");
  });

  it("does NOT call a noindex on one non-homepage page a blocker", () => {
    const noidx = '<meta name="robots" content="noindex">';
    const r = analyzeSeo({
      pages: [
        page(),
        page({ url: "https://example.com/blog", html: noidx }),
        page({ url: "https://example.com/pricing" }),
      ],
      robots: robotsOk,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "noindex");
    expect(f?.severity).toBe("high");
    expect(f?.scope).toBe("partial");
    expect(f?.urls).toEqual(["https://example.com/blog"]);
    expect(f?.summary).toMatch(/1 of 3/);
  });

  it("keeps a homepage noindex at blocker severity, scoped partial", () => {
    const noidx = '<meta name="robots" content="noindex">';
    const r = analyzeSeo({
      pages: [
        page({ url: "https://example.com", html: noidx }),
        page({ url: "https://example.com/pricing" }),
      ],
      robots: robotsOk,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "noindex");
    expect(f?.severity).toBe("blocker");
    expect(f?.scope).toBe("partial");
  });

  it("flags duplicate titles across pages, case-insensitively", () => {
    const mk = (u: string, t: string) =>
      page({ url: u, html: `<title>${t}</title><h1>x</h1><p>${"w ".repeat(100)}</p>` });
    const r = analyzeSeo({
      pages: [mk("https://e.com/a", "Home"), mk("https://e.com/b", "home")],
      robots: robotsOk,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "title_duplicate");
    expect(f).toBeDefined();
    expect(f?.urls.sort()).toEqual(["https://e.com/a", "https://e.com/b"]);
  });

  it("flags a JS-only shell as worth checking, NOT as broken", () => {
    const r = analyzeSeo({
      pages: [page({ html: "<html><head><title>App</title></head><body><div id=root></div></body></html>" })],
      robots: robotsOk,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "thin_server_html");
    expect(f).toBeDefined();
    expect(f?.summary).toMatch(/cannot tell/i);
    expect(f?.summary).toMatch(/worth checking/i);
    expect(f?.summary).not.toMatch(/search engines (cannot|can't) see/i);
    expect(f?.summary).not.toMatch(/your site is broken/i);
  });

  it("skips non-2xx and empty pages entirely", () => {
    const r = analyzeSeo({
      pages: [page({ status: 404, html: "" }), page({ status: 500, html: "" })],
      robots: robotsOk,
      sitemapReachable: true,
    });
    expect(r.pages_analyzed).toBe(0);
    expect(r.pages).toEqual([]);
  });

  it("does not claim a missing sitemap when robots declares one", () => {
    const r = analyzeSeo({ pages: [page()], robots: robotsOk, sitemapReachable: null });
    expect(codes(r)).not.toContain("sitemap_missing");
  });

  it("never emits a traffic, ranking or impression number", () => {
    const r = analyzeSeo({
      pages: [page({ html: "<html><body></body></html>" })],
      robots: { fetched: true, disallowsAll: true, sitemaps: [] },
      sitemapReachable: false,
    });
    const prose = r.findings.map((f) => f.summary).join(" ");
    expect(prose).not.toMatch(/\b(impressions?|sessions?|clicks?|CTR|ranks? #|position \d)\b/i);
  });
});

describe("schema_absent on pages cut off at the read cap", () => {
  const robots = { fetched: true, disallowsAll: false, sitemaps: [] };

  it("is not claimed for a page read only in part", () => {
    const r = analyzeSeo({ pages: [page({ truncated: true })], robots, sitemapReachable: true });
    expect(r.findings.map((f) => f.code)).not.toContain("schema_absent");
  });

  it("names only the pages read in full when both kinds are present", () => {
    const r = analyzeSeo({
      pages: [page({ url: "https://example.com/big", truncated: true }), page({ url: "https://example.com/small" })],
      robots,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "schema_absent")!;
    expect(f.urls).toEqual(["https://example.com/small"]);
    expect(f.summary).toMatch(/any page we read in full/);
  });
});

describe("the per-page checks the channel's site-health block counts", () => {
  const robots = { fetched: true, disallowsAll: false, sitemaps: [] };
  const LD = '<script type="application/ld+json">{"@type":"Organization"}</script>';
  const body = "<p>" + "word ".repeat(100) + "</p>";
  const html = (title: string, h1s: number, schema = false) =>
    `<html><head><title>${title}</title>${schema ? LD : ""}</head><body>${"<h1>x</h1>".repeat(h1s)}${body}</body></html>`;

  it("flags more than one H1 as a medium finding naming only those pages", () => {
    const r = analyzeSeo({
      pages: [
        page({ url: "https://example.com/a", html: html("A", 3) }),
        page({ url: "https://example.com/b", html: html("B", 1) }),
      ],
      robots,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "h1_multiple")!;
    expect(f.severity).toBe("medium");
    expect(f.urls).toEqual(["https://example.com/a"]);
  });

  it("flags a title over 60 characters as a low notice, and not one of exactly 60", () => {
    const r = analyzeSeo({
      pages: [
        page({ url: "https://example.com/long", html: html("x".repeat(61), 1) }),
        page({ url: "https://example.com/edge", html: html("y".repeat(60), 1) }),
      ],
      robots,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "title_too_long")!;
    expect(f.severity).toBe("low");
    expect(f.urls).toEqual(["https://example.com/long"]);
  });

  it("names pages without structured data only when some other page has it", () => {
    const mixed = analyzeSeo({
      pages: [
        page({ url: "https://example.com/with", html: html("W", 1, true) }),
        page({ url: "https://example.com/without", html: html("O", 1) }),
      ],
      robots,
      sitemapReachable: true,
    });
    const f = mixed.findings.find((x) => x.code === "schema_missing_page")!;
    expect(f.severity).toBe("low");
    expect(f.urls).toEqual(["https://example.com/without"]);
    expect(mixed.findings.map((x) => x.code)).not.toContain("schema_absent");

    const none = analyzeSeo({
      pages: [page({ url: "https://example.com/x", html: html("X", 1) })],
      robots,
      sitemapReachable: true,
    });
    const codes = none.findings.map((x) => x.code);
    expect(codes).toContain("schema_absent");
    expect(codes).not.toContain("schema_missing_page");
  });

  it("does not name a page read only in part as missing structured data", () => {
    const r = analyzeSeo({
      pages: [
        page({ url: "https://example.com/with", html: html("W", 1, true) }),
        page({ url: "https://example.com/big", html: html("B", 1), truncated: true }),
      ],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.map((x) => x.code)).not.toContain("schema_missing_page");
  });
});

describe("titles are measured as a searcher reads them", () => {
  const robots = { fetched: true, disallowsAll: false, sitemaps: [] };
  it("counts an encoded ampersand as one character", () => {
    const title = "Rent &amp; ride: cars &amp; vans &amp; trucks near you today ok";
    const html = `<html><head><title>${title}</title></head><body><h1>x</h1><p>${"word ".repeat(100)}</p></body></html>`;
    const r = analyzeSeo({ pages: [page({ html })], robots, sitemapReachable: true });
    expect(r.findings.map((f) => f.code)).not.toContain("title_too_long");
  });

  it("reports the same visible length it measured, and survives a malformed entity", () => {
    const title = "Rent &amp; ride &ndash; cars";
    const html = `<html><head><title>${title}</title></head><body><h1>x</h1><p>${"word ".repeat(100)}</p></body></html>`;
    const r = analyzeSeo({ pages: [page({ html })], robots, sitemapReachable: true });
    expect(r.pages[0].title_length).toBe("Rent & ride \u2013 cars".length);
    expect(r.pages[0].title).toBe("Rent & ride \u2013 cars");
    const bad = `<html><head><title>Sale &#x110000; &#1114112;</title></head><body><h1>x</h1><p>${"word ".repeat(100)}</p></body></html>`;
    expect(() => analyzeSeo({ pages: [page({ html: bad })], robots, sitemapReachable: true })).not.toThrow();
  });

  it("marks a page read only in part, so its absences read as unknown", () => {
    const r = analyzeSeo({ pages: [page({ truncated: true })], robots, sitemapReachable: true });
    expect(r.pages[0].truncated).toBe(true);
    const whole = analyzeSeo({ pages: [page()], robots, sitemapReachable: true });
    expect(whole.pages[0]).not.toHaveProperty("truncated");
  });
});

describe("HTML-only rules skip Markdown and text files", () => {
  const robots = { fetched: true, disallowsAll: false, sitemaps: ["https://example.com/sitemap.xml"] };
  const md = (url: string, type = "text/markdown; charset=utf-8", extra: Record<string, string> = {}): FetchedPage =>
    page({ url, headers: { "content-type": type, ...extra }, html: "# Auth\n\nSign in with a token.\n" });
  const HTML_ONLY = [
    "title_missing",
    "title_duplicate",
    "meta_description_missing",
    "h1_missing",
    "h1_multiple",
    "thin_server_html",
    "schema_absent",
    "schema_missing_page",
  ];
  const codesNaming = (r: ReturnType<typeof analyzeSeo>, url: string) =>
    r.findings.filter((f) => f.urls.includes(url)).map((f) => f.code);

  it("does not judge a Markdown file by HTML tags", () => {
    const r = analyzeSeo({ pages: [page(), md("https://example.com/auth.md")], robots, sitemapReachable: true });
    expect(codesNaming(r, "https://example.com/auth.md").filter((c) => HTML_ONLY.includes(c))).toEqual([]);
    expect(r.pages_analyzed).toBe(2);
    expect(r.pages.map((p) => p.url)).toEqual(["https://example.com/"]);
  });

  it("does not judge a text/plain file by HTML tags", () => {
    const r = analyzeSeo({ pages: [page(), md("https://example.com/llms.txt", "text/plain")], robots, sitemapReachable: true });
    expect(codesNaming(r, "https://example.com/llms.txt").filter((c) => HTML_ONLY.includes(c))).toEqual([]);
  });

  it("still flags an HTML page with no title, naming only that page", () => {
    const bare = page({ url: "https://example.com/x", headers: { "content-type": "text/html" }, html: "<html><body><h1>X</h1></body></html>" });
    const r = analyzeSeo({ pages: [bare, md("https://example.com/auth.md")], robots, sitemapReachable: true });
    expect(r.findings.find((f) => f.code === "title_missing")?.urls).toEqual(["https://example.com/x"]);
  });

  it("treats a page with no content-type as HTML", () => {
    const r = analyzeSeo({ pages: [page({ html: "<p>no title here</p>" })], robots, sitemapReachable: true });
    expect(r.findings.map((f) => f.code)).toContain("title_missing");
  });

  it("checks an HTML body the server mislabels as text/plain", () => {
    const r = analyzeSeo({
      pages: [page({ headers: { "content-type": "text/plain" }, html: "<html><body><p>hi</p></body></html>" })],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.map((f) => f.code)).toContain("title_missing");
  });

  it("still reports noindex on a Markdown file from the header", () => {
    const r = analyzeSeo({
      pages: [page(), md("https://example.com/auth.md", "text/markdown", { "x-robots-tag": "noindex" })],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.find((f) => f.code === "noindex")?.urls).toEqual(["https://example.com/auth.md"]);
  });

  it("lists the Markdown and text files it read, and only those", () => {
    const r = analyzeSeo({
      pages: [page(), md("https://example.com/auth.md"), md("https://example.com/llms.txt", "text/plain")],
      robots,
      sitemapReachable: true,
    });
    expect(r.non_html_urls).toEqual(["https://example.com/auth.md", "https://example.com/llms.txt"]);
  });

  it("does not call two untitled Markdown files duplicates", () => {
    const r = analyzeSeo({
      pages: [page(), md("https://example.com/a.md"), md("https://example.com/b.md")],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.map((f) => f.code)).not.toContain("title_duplicate");
  });
});

describe("isHtmlPage", () => {
  const doc = (url: string, html: string, type?: string): FetchedPage =>
    page({ url, headers: type ? { "content-type": type } : {}, html });

  it("treats a .md path served as text/html with no document tags as a text file", () => {
    expect(isHtmlPage(doc("https://example.com/auth.md", "# Auth\n\nUse a token.\n", "text/html"))).toBe(false);
    expect(isHtmlPage(doc("https://example.com/notes.txt", "plain notes", "text/html; charset=utf-8"))).toBe(false);
    expect(isHtmlPage(doc("https://example.com/guide.markdown?v=2", "# Guide", "text/html"))).toBe(false);
  });

  it("judges the path the request landed on", () => {
    expect(isHtmlPage(page({ url: "https://example.com/docs", final_url: "https://example.com/docs.md", headers: { "content-type": "text/html" }, html: "# Docs" }))).toBe(false);
  });

  it("does not sniff an <html> tag quoted inside a Markdown code sample", () => {
    const body = "# Embed\n\nPaste this:\n\n```html\n<html>\n  <head><title>x</title></head>\n</html>\n```\n";
    expect(isHtmlPage(doc("https://example.com/embed", body, "text/markdown"))).toBe(false);
    expect(isHtmlPage(doc("https://example.com/embed.md", body, "text/html"))).toBe(false);
  });

  it("keeps real HTML as HTML, with or without a content-type", () => {
    expect(isHtmlPage(doc("https://example.com/", "<!DOCTYPE html><html><head></head></html>"))).toBe(true);
    expect(isHtmlPage(doc("https://example.com/", "<p>fragment</p>"))).toBe(true);
    expect(isHtmlPage(doc("https://example.com/a", "\uFEFF  <!-- built --> <html lang=en><body></body></html>", "text/plain"))).toBe(true);
    expect(isHtmlPage(doc("https://example.com/readme.md", "<!doctype html><html><body>x</body></html>", "text/html"))).toBe(true);
  });
});

describe("isHtmlPage on hostile bodies", () => {
  it("finishes fast on a huge unclosed comment and huge leading whitespace", () => {
    const t0 = Date.now();
    expect(isHtmlPage(page({ html: "<!--".repeat(100_000), headers: { "content-type": "text/markdown" } }))).toBe(false);
    expect(isHtmlPage(page({ html: " ".repeat(200_000) + "<html>", headers: { "content-type": "text/markdown" } }))).toBe(false);
    expect(isHtmlPage(page({ html: "<!-- a -->".repeat(50_000), headers: { "content-type": "text/markdown" } }))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("noindex counts web pages and other files apart", () => {
  const robots = { fetched: true, disallowsAll: false, sitemaps: [] };
  const md = (url: string, extra: Record<string, string> = {}): FetchedPage =>
    page({ url, headers: { "content-type": "text/markdown", ...extra }, html: "# Doc\n" });
  const noindexPage = (url: string) =>
    page({ url, html: '<html><head><meta name="robots" content="noindex"><title>x</title></head><body></body></html>' });

  it("is site-wide when every web page is noindexed, even if a Markdown copy is listable", () => {
    const r = analyzeSeo({
      pages: [noindexPage("https://example.com/"), noindexPage("https://example.com/a"), md("https://example.com/docs.md")],
      robots,
      sitemapReachable: true,
    });
    const f = r.findings.find((x) => x.code === "noindex")!;
    expect(f).toMatchObject({ scope: "site", severity: "blocker" });
    expect(f.summary).toMatch(/^Every page checked/);
  });

  it("never calls a crawl that read no web page site-wide, and says files", () => {
    const all = analyzeSeo({
      pages: [md("https://example.com/a.md", { "x-robots-tag": "noindex" }), md("https://example.com/b.md", { "x-robots-tag": "noindex" })],
      robots,
      sitemapReachable: true,
    }).findings.find((x) => x.code === "noindex");
    expect(all).toMatchObject({ scope: "partial", severity: "high" });
    expect(all!.summary).toMatch(/^Every file checked/);
    const one = analyzeSeo({
      pages: [md("https://example.com/a.md", { "x-robots-tag": "noindex" }), md("https://example.com/b.md")],
      robots,
      sitemapReachable: true,
    }).findings.find((x) => x.code === "noindex");
    expect(one!.summary).toBe("1 of 2 files checked ask search engines not to index them.");
  });

  it("names a noindexed Markdown file as a file, not a page", () => {
    const r = analyzeSeo({
      pages: [page(), md("https://example.com/auth.md", { "x-robots-tag": "noindex" })],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.find((x) => x.code === "noindex")).toMatchObject({
      scope: "partial",
      severity: "high",
      summary: "1 of 1 other file checked ask search engines not to index them.",
    });
  });
});

describe("private-by-design pages are not 'hidden from search'", () => {
  const robots = { fetched: true, disallowsAll: false, sitemaps: ["https://example.com/sitemap.xml"] };
  const noindexAt = (path: string, content = "noindex, follow"): FetchedPage =>
    page({
      url: `https://example.com${path}`,
      html: `<html><head><title>${path}</title><meta name="robots" content="${content}"></head><body><h1>x</h1></body></html>`,
    });

  it("does not flag a noindexed cart", () => {
    for (const path of ["/cart", "/cart/", "/shop/cart", "/my-account/orders", "/wp-admin", "/checkout"]) {
      const r = analyzeSeo({ pages: [page(), noindexAt(path)], robots, sitemapReachable: true });
      expect(r.findings.map((f) => f.code), path).not.toContain("noindex");
    }
  });

  it("still flags a noindexed blog post whose name merely contains 'checkout'", () => {
    const r = analyzeSeo({ pages: [page(), noindexAt("/blog/checkout-guide")], robots, sitemapReachable: true });
    expect(r.findings.find((f) => f.code === "noindex")?.urls).toEqual(["https://example.com/blog/checkout-guide"]);
  });

  it("is not a blocker when the only noindexed page is /admin", () => {
    const r = analyzeSeo({
      pages: [page({ url: "https://example.com/admin", html: noindexAt("/admin").html })],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.map((f) => f.code)).not.toContain("noindex");
  });

  it("judges a page by where it landed: a redirect onto /login is private", () => {
    const r = analyzeSeo({
      pages: [page(), { ...noindexAt("/members"), final_url: "https://example.com/login" }],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.map((f) => f.code)).not.toContain("noindex");
  });
});

describe("pages that land on the same URL count once", () => {
  const robots = { fetched: true, disallowsAll: false, sitemaps: ["https://example.com/sitemap.xml"] };

  it("does not call two URLs that redirect to one page duplicates", () => {
    const login = page({ html: "<html><head><title>Sign in</title></head><body><h1>Sign in</h1></body></html>" });
    const r = analyzeSeo({
      pages: [
        page(),
        { ...login, url: "https://example.com/dashboard", final_url: "https://example.com/login" },
        { ...login, url: "https://example.com/settings", final_url: "https://example.com/login/" },
      ],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.map((f) => f.code)).not.toContain("title_duplicate");
    expect(r.pages_analyzed).toBe(2);
  });

  it("collapses a redirect onto a page the crawl already read", () => {
    const r = analyzeSeo({
      pages: [page(), page({ url: "https://example.com/home", final_url: "https://example.com/" })],
      robots,
      sitemapReachable: true,
    });
    expect(r.findings.map((f) => f.code)).not.toContain("title_duplicate");
    expect(r.pages.map((p) => p.url)).toEqual(["https://example.com/"]);
  });
});

describe("isPrivatePath", () => {
  it("matches login and account words only as the first segment, carts under a store", () => {
    expect(isPrivatePath("/login")).toBe(true);
    expect(isPrivatePath("/en/account/orders")).toBe(true);
    expect(isPrivatePath("https://example.com/shop/cart/")).toBe(true);
    expect(isPrivatePath("/docs/auth")).toBe(false);
    expect(isPrivatePath("/help/account")).toBe(false);
    expect(isPrivatePath("/blog/checkout-guide")).toBe(false);
    expect(isPrivatePath("/docs/checkout")).toBe(false);
  });
});
