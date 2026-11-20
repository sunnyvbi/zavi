import { describe, it, expect } from "vitest";
import {
  AI_CRAWLERS,
  READINESS_COMPLETENESS_FLOOR,
  analyzeGeo,
  completenessOf,
  analyzePage,
  headingSkips,
  headingsOf,
  isQuestionHeading,
  parseRobotsGroups,
  resolveCrawlerAccess,
  textBlocksOf,
  LEAD_MIN_WORDS,
  STALE_DAYS,
} from "../analyze";
import type { FetchedPage } from "../../seo/analyze";

const NOW = Date.parse("2026-09-04T00:00:00Z");

const page = (html: string, url = "https://example.com/"): FetchedPage => ({
  url,
  status: 200,
  headers: {},
  html,
});

const words = (n: number, w = "growth"): string => Array(n).fill(w).join(" ");

describe("parseRobotsGroups", () => {
  it("groups consecutive user-agent lines together", () => {
    const groups = parseRobotsGroups(
      ["User-agent: GPTBot", "User-agent: ClaudeBot", "Disallow: /", "", "User-agent: *", "Disallow:"].join("\n"),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].agents).toEqual(["gptbot", "claudebot"]);
    expect(groups[0].disallow).toEqual(["/"]);
    expect(groups[1].agents).toEqual(["*"]);
  });

  it("starts a NEW group when a user-agent line follows a rule", () => {
    const groups = parseRobotsGroups(
      ["User-agent: *", "Disallow: /admin", "User-agent: GPTBot", "Disallow: /"].join("\n"),
    );
    expect(groups).toHaveLength(2);
    expect(groups[1].agents).toEqual(["gptbot"]);
  });

  it("ignores comments and rules that precede any user-agent", () => {
    const groups = parseRobotsGroups(
      ["# hello", "Disallow: /orphan", "User-agent: *  # trailing", "Disallow: /x"].join("\n"),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].disallow).toEqual(["/x"]);
  });

  it("returns nothing for a robots.txt that was never read", () => {
    expect(parseRobotsGroups(null)).toEqual([]);
  });
});

describe("resolveCrawlerAccess", () => {
  it("reads a named block as blocked and quotes the directive", () => {
    const access = resolveCrawlerAccess("User-agent: GPTBot\nDisallow: /", true);
    const gpt = access.find((c) => c.name === "GPTBot")!;
    expect(gpt.state).toBe("blocked");
    expect(gpt.directive).toBe("Disallow: /");
    expect(gpt.from_wildcard).toBe(false);
  });

  it("falls back to the wildcard group and SAYS it did", () => {
    const access = resolveCrawlerAccess("User-agent: *\nDisallow: /", true);
    const claude = access.find((c) => c.name === "ClaudeBot")!;
    expect(claude.state).toBe("blocked");
    expect(claude.from_wildcard).toBe(true);
  });

  it("prefers a named group over the wildcard", () => {
    const access = resolveCrawlerAccess(
      ["User-agent: *", "Disallow: /", "", "User-agent: PerplexityBot", "Disallow:"].join("\n"),
      true,
    );
    expect(access.find((c) => c.name === "PerplexityBot")!.state).toBe("allowed");
    expect(access.find((c) => c.name === "CCBot")!.state).toBe("blocked");
  });

  it("treats a path-scoped disallow as partial, not blocked", () => {
    const access = resolveCrawlerAccess("User-agent: *\nDisallow: /admin", true);
    expect(access.find((c) => c.name === "GPTBot")!.state).toBe("partial");
  });

  it("carries every non-empty Disallow path of the wildcard group on partial", () => {
    const access = resolveCrawlerAccess("User-agent: *\nDisallow: /admin\nDisallow: /blog", true);
    const gpt = access.find((c) => c.name === "GPTBot")!;
    expect(gpt.disallowed_paths).toEqual(["/blog", "/admin"]);
    expect(gpt.directive).toBe("Disallow: /blog");
  });

  it("lets an explicit Allow: / override a Disallow: /", () => {
    const access = resolveCrawlerAccess("User-agent: *\nDisallow: /\nAllow: /", true);
    expect(access.find((c) => c.name === "GPTBot")!.state).toBe("allowed");
  });

  it("reports allowed-by-default when robots.txt names nothing relevant", () => {
    const access = resolveCrawlerAccess("User-agent: SomeOtherBot\nDisallow: /", true);
    const gpt = access.find((c) => c.name === "GPTBot")!;
    expect(gpt.state).toBe("allowed");
    expect(gpt.directive).toBeNull();
  });

  it("NEVER reads an unreadable robots.txt as permission", () => {
    const access = resolveCrawlerAccess(null, false);
    expect(access.every((c) => c.state === "unknown")).toBe(true);
  });

  it("carries the caveats operators reliably misread", () => {
    const access = resolveCrawlerAccess("User-agent: *\nDisallow:", true);
    expect(access.find((c) => c.name === "Google-Extended")!.caveat).toMatch(/AI Overviews/);
    expect(access.find((c) => c.name === "ChatGPT-User")!.caveat).toMatch(/may not apply/);
    expect(access.find((c) => c.name === "ChatGPT-User")!.obeys_robots).toBe(false);
  });
});

describe("page shape", () => {
  it("splits visible text into document-order blocks", () => {
    expect(textBlocksOf("<p>One</p><p>Two</p><script>ignore()</script>")).toEqual(["One", "Two"]);
  });

  it("reads headings and detects skipped levels", () => {
    const hs = headingsOf("<h1>A</h1><h2>B</h2><h4>C</h4>");
    expect(hs.map((h) => h.level)).toEqual([1, 2, 4]);
    expect(headingSkips(hs)).toBe(1);
    expect(headingSkips(headingsOf("<h1>A</h1><h2>B</h2><h3>C</h3>"))).toBe(0);
  });

  it("recognises question-form headings", () => {
    expect(isQuestionHeading("How does pricing work")).toBe(true);
    expect(isQuestionHeading("Pricing that scales?")).toBe(true);
    expect(isQuestionHeading("Our pricing")).toBe(false);
  });

  it("finds a self-contained lead passage inside the opening third", () => {
    const html = `<p>${words(120)}</p><p>${words(400)}</p>`;
    const f = analyzePage(page(html), NOW);
    expect(f.lead_passage_words).toBe(120);
    expect(f.lead_in_band).toBe(true);
  });

  it("reports no lead passage when the real prose starts below the opening third", () => {
    const html = `${"<p>five short words here</p>".repeat(60)}<p>${words(100)}</p>`;
    const f = analyzePage(page(html), NOW);
    expect(f.lead_passage_words).toBeNull();
  });

  it("still finds an over-long opening block, and marks it out of band", () => {
    const f = analyzePage(page(`<p>Short.</p><p>${words(500)}</p>`), NOW);
    expect(f.lead_passage_words).toBe(500);
    expect(f.lead_in_band).toBe(false);
  });

  it("counts only checkable figures, not every stray digit", () => {
    const f = analyzePage(
      page(`<p>${words(50)}. Revenue grew 42% last year. We have 3 people. Costs fell $1200.</p>`),
      NOW,
    );
    expect(f.figure_sentences).toBe(2);
  });

  it("reads dates out of JSON-LD and ages them against the injected clock", () => {
    const html = `<script type="application/ld+json">{"@type":"Article","datePublished":"2026-01-01","dateModified":"2026-08-05"}</script><p>${words(80)}</p>`;
    const f = analyzePage(page(html), NOW);
    expect(f.published_at).toBe("2026-01-01");
    expect(f.updated_at).toBe("2026-08-05");
    expect(f.age_days).toBe(30);
  });

  it("counts outbound citations by distinct external host, not by link", () => {
    const html = `<a href="https://example.com/x">self</a><a href="https://nytimes.com/a">a</a><a href="https://nytimes.com/b">b</a><a href="https://gov.uk/c">c</a><p>${words(80)}</p>`;
    expect(analyzePage(page(html), NOW).outbound_citations).toBe(2);
  });

  it("calls a JS shell what it is", () => {
    const f = analyzePage(page('<div id="root"></div>'), NOW);
    expect(f.server_rendered).toBe(false);
    expect(f.visible_words).toBeLessThan(LEAD_MIN_WORDS);
  });
});

describe("analyzeGeo — findings", () => {
  const good = `
    <h1>Zavi</h1>
    <script type="application/ld+json">{"@type":"Organization","datePublished":"2026-08-01","dateModified":"2026-08-20"}</script>
    <p>Generative engine optimization is the practice of making a page quotable by an AI answer engine. ${words(130)}. It lifted citations 42% in our own tests. Median time to first citation fell 1200 minutes.</p>
    <h2>How does it work?</h2>
    <p>${words(30)}</p>
    <table><tr><td>x</td></tr></table>
    <img src="a.png" alt="chart" />
    <a href="https://developers.google.com/search">Google</a>
    <a href="https://ahrefs.com/blog">Ahrefs</a>
    <span class="author">By Ravi Kumar</span>`;

  it("leads with blocked AI search crawlers — nothing else matters if they cannot read it", () => {
    const r = analyzeGeo({
      pages: [page(good)],
      robotsBody: "User-agent: OAI-SearchBot\nDisallow: /\nUser-agent: Claude-SearchBot\nDisallow: /",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    const blocked = r.findings.find((f) => f.code === "ai_crawler_blocked")!;
    expect(blocked.severity).toBe("blocker");
    expect(blocked.summary).toContain("OAI-SearchBot");
    expect(blocked.summary).toContain("Claude-SearchBot");
  });

  it("does NOT flag a training-only opt-out — a policy choice, not a fault (doc §5.3)", () => {
    const trainingOnly = analyzeGeo({
      pages: [page(good)],
      robotsBody: "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    const open = analyzeGeo({
      pages: [page(good)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    expect(trainingOnly.findings.find((f) => f.code === "ai_crawler_blocked")).toBeUndefined();
    expect(trainingOnly.score.total).toBe(open.score.total);
  });

  const partial = (robotsBody: string) =>
    analyzeGeo({ pages: [page(good)], robotsBody, robotsFetched: true, llmsTxt: false, now: NOW })
      .findings.filter((f) => f.code === "ai_crawler_partly_blocked");

  it("names the public paths a wildcard rule keeps AI search crawlers out of", () => {
    const found = partial("User-agent: *\nDisallow: /blog\nDisallow: /guides");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("medium");
    expect(found[0].urls).toEqual(["/robots.txt"]);
    expect(found[0].summary).toContain("/blog, /guides");
    expect(found[0].summary).toContain("(a rule for every bot)");
    expect(found[0].summary).toContain("OAI-SearchBot");
  });

  it("says when the rule was written for that bot", () => {
    const found = partial("User-agent: OAI-SearchBot\nDisallow: /blog");
    expect(found).toHaveLength(1);
    expect(found[0].summary).toContain("robots.txt keeps OAI-SearchBot out of /blog");
    expect(found[0].summary).toContain("(a rule written for that bot)");
  });

  it("does not flag private areas like /admin or /cart", () => {
    expect(partial("User-agent: *\nDisallow: /admin\nDisallow: /cart")).toHaveLength(0);
  });

  it("reports one medium finding when a public path sits beside a private one", () => {
    const found = partial("User-agent: *\nDisallow: /admin\nDisallow: /blog");
    expect(found).toHaveLength(1);
    expect(found[0].summary).toContain("out of /blog (");
    expect(found[0].summary).not.toContain("/admin,");
  });

  it("still names a public path listed after five private ones", () => {
    const found = partial(
      "User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /login\nDisallow: /api\nDisallow: /search\nDisallow: /blog",
    );
    expect(found).toHaveLength(1);
    expect(found[0].summary).toContain("out of /blog (");
  });

  it("does not flag a path an equal-length Allow re-opens (longest match, Allow wins ties)", () => {
    expect(partial("User-agent: *\nDisallow: /blog\nAllow: /blog")).toHaveLength(0);
    expect(partial("User-agent: *\nDisallow: /blog\nAllow: /blog/public")).toHaveLength(1);
  });

  it("combines repeated groups for the same user-agent", () => {
    const found = partial("User-agent: *\nDisallow: /admin\n\nUser-agent: *\nDisallow: /blog");
    expect(found).toHaveLength(1);
    expect(found[0].summary).toContain("out of /blog (");
    const named = partial(
      "User-agent: OAI-SearchBot\nDisallow: /admin\n\nUser-agent: OAI-SearchBot\nDisallow: /docs",
    );
    expect(named).toHaveLength(1);
    expect(named[0].summary).toContain("OAI-SearchBot out of /docs");
  });

  it("keeps each bot paired with its own paths when named rules differ", () => {
    const found = partial(
      "User-agent: OAI-SearchBot\nDisallow: /blog\n\nUser-agent: Claude-SearchBot\nDisallow: /docs",
    );
    expect(found).toHaveLength(1);
    expect(found[0].summary).toContain("OAI-SearchBot out of /blog");
    expect(found[0].summary).toContain("Claude-SearchBot out of /docs");
    expect(found[0].summary).not.toContain("/blog, /docs");
  });

  it("does not flag a path a wildcard Allow fully re-opens", () => {
    expect(
      partial(
        "User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /login\nDisallow: /api\nDisallow: /search\nDisallow: /blog\nAllow: /blog*",
      ),
    ).toHaveLength(0);
  });

  it("reads merged groups with Disallow: / and a longer Allow as partial, not whole-site blocked", () => {
    const body = "User-agent: *\nAllow: /blog\n\nUser-agent: *\nDisallow: /";
    const bot = resolveCrawlerAccess(body, true).find((c) => c.name === "OAI-SearchBot")!;
    expect(bot.state).toBe("partial");
    expect(bot.directive).toBe("Disallow: /");
    const r = analyzeGeo({ pages: [page(good)], robotsBody: body, robotsFetched: true, llmsTxt: false, now: NOW });
    expect(r.findings.find((f) => f.code === "ai_crawler_blocked")).toBeUndefined();
    expect(r.findings.find((f) => f.code === "ai_crawler_partly_blocked")).toBeDefined();
  });

  it("never shows a directive that is not in robots.txt when an Allow ties a Disallow", () => {
    const gpt = resolveCrawlerAccess("User-agent: *\nDisallow: /blog\nAllow: /blog", true).find(
      (c) => c.name === "GPTBot",
    )!;
    expect(gpt.state).toBe("allowed");
    expect(gpt.directive).toBeNull();
  });

  it("is only whole-site blocked when the pages the audit read are closed too", () => {
    const gpt = (body: string) =>
      resolveCrawlerAccess(body, true, ["/pricing"]).find((c) => c.name === "GPTBot")!;
    expect(gpt("User-agent: *\nDisallow: /$").state).toBe("partial");
    expect(gpt("User-agent: *\nDisallow: /").state).toBe("blocked");
  });

  describe("judged against the sitemap: a public page is one the site publishes", () => {
    const withSitemap = (robotsBody: string, sitemapPaths: string[], sitemapComplete = true) =>
      analyzeGeo({ pages: [page(good)], robotsBody, robotsFetched: true, llmsTxt: false, now: NOW, sitemapPaths, sitemapComplete });
    const partlyOf = (r: ReturnType<typeof analyzeGeo>) => r.findings.filter((f) => f.code === "ai_crawler_partly_blocked");
    const appAreas =
      "User-agent: *\nAllow: /\nDisallow: /account-page/\nDisallow: /additional_driver/\nDisallow: /booking/\nDisallow: /bookings/\nDisallow: /calendar/\nDisallow: /change-password/";

    it("does not flag rules over app areas the sitemap never lists", () => {
      const r = withSitemap(appAreas, ["/", "/turo-alternative", "/cars/tesla-model-3", "/help-center/how-pricing-works"]);
      expect(partlyOf(r)).toHaveLength(0);
      const bot = r.crawlers.find((c) => c.name === "OAI-SearchBot")!;
      expect(bot.state).toBe("partial");
      expect(bot.public_blocked).toEqual([]);
    });

    it("flags a rule that closes a page the sitemap lists, naming the page", () => {
      const r = withSitemap("User-agent: *\nDisallow: /blog", ["/", "/pricing", "/blog/launch-notes"]);
      const found = partlyOf(r);
      expect(found).toHaveLength(1);
      expect(found[0].summary).toContain("out of /blog/launch-notes (");
      expect(r.crawlers.find((c) => c.name === "OAI-SearchBot")!.public_blocked).toEqual(["/blog/launch-notes"]);
    });

    it("never counts a private-looking page as public even when the sitemap lists it", () => {
      expect(partlyOf(withSitemap("User-agent: *\nDisallow: /account", ["/", "/account/settings"]))).toHaveLength(0);
    });

    it("falls back to the path names when the sitemap read was cut short and found nothing", () => {
      const found = partlyOf(withSitemap("User-agent: *\nDisallow: /blog", ["/", "/pricing"], false));
      expect(found).toHaveLength(1);
      expect(found[0].summary).toContain("out of /blog (");
    });

    it("trusts a large cut-short read: a big sitemap with every listed page open marks app areas private", () => {
      const listed = ["/", ...Array.from({ length: 999 }, (_, i) => `/cars/car-${i}`)];
      const r = withSitemap(appAreas, listed, false);
      expect(partlyOf(r)).toHaveLength(0);
      expect(r.crawlers.find((c) => c.name === "OAI-SearchBot")!.public_blocked).toEqual([]);
    });

    it("falls back to the path names with no sitemap at all", () => {
      expect(partlyOf(withSitemap("User-agent: *\nDisallow: /blog", []))).toHaveLength(1);
    });

    it("counts a fetched page the sitemap left out as public", () => {
      const r = analyzeGeo({
        pages: [page(good, "https://example.com/"), page(good, "https://example.com/blog/post")],
        robotsBody: "User-agent: *\nDisallow: /blog",
        robotsFetched: true,
        llmsTxt: false,
        now: NOW,
        sitemapPaths: ["/", "/pricing"],
        sitemapComplete: true,
      });
      expect(partlyOf(r)).toHaveLength(1);
      expect(r.crawlers.find((c) => c.name === "OAI-SearchBot")!.public_blocked).toEqual(["/blog/post"]);
    });

    it("matches the sitemap entry as written, trailing slash included", () => {
      expect(partlyOf(withSitemap("User-agent: *\nDisallow: /blog/", ["/", "/blog/"]))).toHaveLength(1);
    });

    it("quotes the rule that closes the public page, not the first rule in the file", () => {
      const r = withSitemap("User-agent: *\nDisallow: /booking/\nDisallow: /blog/", ["/", "/blog/post"]);
      expect(r.crawlers.find((c) => c.name === "OAI-SearchBot")!.directive).toBe("Disallow: /blog/");
    });
  });

  it("leaves a whole-site Disallow: / to the blocker finding alone", () => {
    const r = analyzeGeo({
      pages: [page(good)],
      robotsBody: "User-agent: *\nDisallow: /",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    expect(r.findings.find((f) => f.code === "ai_crawler_blocked")!.severity).toBe("blocker");
    expect(r.findings.find((f) => f.code === "ai_crawler_partly_blocked")).toBeUndefined();
  });

  it("treats a JS-only page as a blocker, because AI crawlers do not run JS", () => {
    const r = analyzeGeo({
      pages: [page('<div id="root"></div>')],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    const f = r.findings.find((c) => c.code === "geo_not_server_rendered")!;
    expect(f.severity).toBe("blocker");
    expect(f.summary).toMatch(/do not execute JavaScript/);
  });

  it("flags a stale page against the injected clock", () => {
    const old = `<p>${words(120)}</p><script type="application/ld+json">{"@type":"Article","dateModified":"2025-01-01"}</script>`;
    const r = analyzeGeo({
      pages: [page(old)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    const f = r.findings.find((c) => c.code === "content_stale")!;
    expect(f.summary).toContain(String(STALE_DAYS));
  });

  it("NEVER claims 'no structured data' from a JS-free fetch alone", () => {
    const r = analyzeGeo({
      pages: [page(`<p>${words(120)}</p>`)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    const f = r.findings.find((c) => c.code === "no_schema_server_rendered")!;
    expect(f.summary).toContain("server-rendered HTML");
    expect(f.summary).toMatch(/Rich Results Test/);
    expect(r.findings.some((c) => /^No structured data was found/.test(c.summary))).toBe(false);
  });

  it("finds nothing to fix on a page that does the work", () => {
    const r = analyzeGeo({
      pages: [page(good)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: true,
      now: NOW,
    });
    expect(r.findings.map((f) => f.code)).toEqual([]);
    expect(r.score.total).toBeGreaterThan(70);
  });
});

describe("analyzeGeo — the score and its disclaimers", () => {
  it("weights the five criteria to 100 and scores only what was fetched", () => {
    const r = analyzeGeo({
      pages: [page(`<h1>A</h1><p>${words(120)}</p>`)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    expect(r.score.bands.reduce((n, b) => n + b.weight, 0)).toBe(100);
    expect(r.score.total).toBeGreaterThan(0);
    expect(r.score.total).toBeLessThanOrEqual(100);
    expect(r.pages_analyzed).toBe(1);
  });

  it("scores zero rather than guessing when no page could be read", () => {
    const r = analyzeGeo({
      pages: [{ url: "https://example.com/", status: 500, headers: {}, html: "" }],
      robotsBody: null,
      robotsFetched: false,
      llmsTxt: null,
      now: NOW,
    });
    expect(r.pages_analyzed).toBe(0);
    expect(r.score.total).toBe(0);
  });

  it("says out loud that AI visibility itself was not measured", () => {
    const r = analyzeGeo({
      pages: [page(`<p>${words(120)}</p>`)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    expect(r.not_checked.join(" ")).toMatch(/No API from anyone returns that/);
    expect(r.not_checked.join(" ")).toMatch(/JavaScript/);
  });

  it("adds an unreadable robots.txt to what it could not check", () => {
    const r = analyzeGeo({
      pages: [page(`<p>${words(120)}</p>`)],
      robotsBody: null,
      robotsFetched: false,
      llmsTxt: null,
      now: NOW,
    });
    expect(r.not_checked.join(" ")).toMatch(/robots\.txt could not be read/);
  });

  it("reports llms.txt presence and gives it NO weight", () => {
    const html = `<h1>A</h1><p>${words(120)}</p>`;
    const withIt = analyzeGeo({
      pages: [page(html)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: true,
      now: NOW,
    });
    const without = analyzeGeo({
      pages: [page(html)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    expect(withIt.llms_txt).toBe(true);
    expect(without.llms_txt).toBe(false);
    expect(withIt.score.total).toBe(without.score.total);
    expect(withIt.findings).toEqual(without.findings);
  });
});

describe("analyzeGeo — provenance", () => {
  it("carries no AI-visibility, citation-count or traffic field anywhere", () => {
    const r = analyzeGeo({
      pages: [page(`<h1>A</h1><p>${words(150)}</p>`)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    for (const banned of [
      "citation_count",
      "citations",
      "share_of_voice",
      "ai_traffic",
      "ai_referrals",
      "visibility",
      "impressions",
      "clicks",
      "ctr",
      "position",
      "sessions",
    ]) {
      expect(r).not.toHaveProperty(banned);
      expect(Object.keys(r.pages[0] ?? {})).not.toContain(banned);
    }
  });

  it("covers every crawler in the published table", () => {
    const r = analyzeGeo({
      pages: [page(`<p>${words(120)}</p>`)],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    expect(r.crawlers).toHaveLength(AI_CRAWLERS.length);
    expect(r.crawlers.map((c) => c.name)).toContain("PerplexityBot");
  });
});

describe("readiness check completeness (doc §5.2)", () => {
  it("is checks returned ÷ checks planned, counting the two site files", () => {
    const c = completenessOf({ pagesPlanned: 6, pagesReturned: 6, robotsFetched: true, llmsTxt: false });
    expect(c).toMatchObject({ planned: 8, returned: 8, ratio: 1, below_floor: false, warning: null });
  });

  it("warns below 80% instead of presenting a clean number", () => {
    const c = completenessOf({ pagesPlanned: 24, pagesReturned: 10, robotsFetched: false, llmsTxt: null });
    expect(c.returned).toBe(10);
    expect(c.planned).toBe(26);
    expect(c.ratio).toBeLessThan(READINESS_COMPLETENESS_FLOOR);
    expect(c.below_floor).toBe(true);
    expect(c.warning).toMatch(/10 of 26/);
  });

  it("an llms.txt that answered 404 is a check that RETURNED — false is an answer, null is not", () => {
    const answered = completenessOf({ pagesPlanned: 1, pagesReturned: 1, robotsFetched: true, llmsTxt: false });
    const never = completenessOf({ pagesPlanned: 1, pagesReturned: 1, robotsFetched: true, llmsTxt: null });
    expect(answered.returned).toBe(3);
    expect(never.returned).toBe(2);
  });

  it("counts a non-2xx page as planned and not returned", () => {
    const r = analyzeGeo({
      pages: [page(`<p>${words(120)}</p>`), { ...page("", "https://example.com/gone"), status: 404 }],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: true,
      pagesPlanned: 3,
      now: NOW,
    });
    expect(r.completeness).toMatchObject({ planned: 5, returned: 3 });
    expect(r.completeness.below_floor).toBe(true);
  });

  it("carries its own disclosure, so no surface can show the score without it", () => {
    const r = analyzeGeo({ pages: [], robotsBody: null, robotsFetched: false, llmsTxt: null, now: NOW });
    expect(r.disclosure).toMatch(/not comparable across companies/i);
    expect(r.disclosure).toMatch(/not a measure of how often AI answers cite you/i);
  });
});

describe("pages cut off at the read cap — never a claim that they LACK something", () => {
  const body = `<h1>What is Acme?</h1><p>${words(150)}</p>`;

  it("does not report missing schema, dates or author for a page read only in part", () => {
    const r = analyzeGeo({
      pages: [{ ...page(body), truncated: true }],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).not.toContain("no_schema_server_rendered");
    expect(codes).not.toContain("no_visible_dates");
    expect(codes).not.toContain("no_author_signal");
    expect(r.pages[0].truncated).toBe(true);
    expect(r.not_checked.join(" ")).toMatch(/1 very large page/);
  });

  it("scopes the claim to the pages read in full when both kinds are present", () => {
    const r = analyzeGeo({
      pages: [{ ...page(body, "https://example.com/big"), truncated: true }, page(body, "https://example.com/small")],
      robotsBody: "User-agent: *\nDisallow:",
      robotsFetched: true,
      llmsTxt: false,
      now: NOW,
    });
    const schema = r.findings.find((f) => f.code === "no_schema_server_rendered")!;
    expect(schema.urls).toEqual(["https://example.com/small"]);
    expect(schema.summary).toMatch(/any page we read in full/);
    expect(r.findings.find((f) => f.code === "no_visible_dates")!.urls).toEqual(["https://example.com/small"]);
  });
});

describe("analyzeGeo — Markdown and text files, and pages that land on one URL", () => {
  const md = (url: string, type = "text/markdown; charset=utf-8"): FetchedPage => ({
    url,
    status: 200,
    headers: { "content-type": type },
    html: "# Auth\n\nSign in with a token.\n",
  });
  const html = `<html><body><h1>Home</h1><p>${words(200)}</p></body></html>`;
  const run = (pages: FetchedPage[]) =>
    analyzeGeo({ pages, robotsBody: "User-agent: *\nDisallow:", robotsFetched: true, llmsTxt: true, now: NOW });

  it("never calls a short Markdown or text file 'not server rendered'", () => {
    const r = run([page(html), md("https://example.com/auth.md"), md("https://example.com/notes.txt", "text/plain")]);
    expect(r.findings.map((f) => f.code)).not.toContain("geo_not_server_rendered");
    expect(r.pages.map((p) => p.url)).toEqual(["https://example.com/"]);
    expect(r.pages_analyzed).toBe(3);
  });

  it("does not grade a site reached only through Markdown as unreachable", () => {
    const r = run([md("https://example.com/index.md")]);
    expect(r.pages_analyzed).toBe(1);
    expect(r.findings.map((f) => f.code)).not.toContain("geo_not_server_rendered");
  });

  it("counts two URLs that redirect to one page once", () => {
    const shell = "<html><body><div id=root></div></body></html>";
    const r = run([
      page(html),
      { ...page(shell, "https://example.com/a"), final_url: "https://example.com/login" },
      { ...page(shell, "https://example.com/b"), final_url: "https://example.com/login" },
    ]);
    expect(r.pages_analyzed).toBe(2);
    expect(r.findings.find((f) => f.code === "geo_not_server_rendered")?.urls).toEqual(["https://example.com/a"]);
    expect(r.completeness.below_floor).toBe(false);
  });
});
