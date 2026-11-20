import { describe, it, expect } from "vitest";
import { buildHypothesis, type HypothesisInput } from "../hypothesis";
import { analyzeSeo, type FetchedPage } from "@/services/tools/growth/seo/analyze";

const BASE: HypothesisInput = {
  oneLiner: "Acme is a peer-to-peer car-rental marketplace",
  stage: 3,
  gtmMotion: null,
  hasSite: true,
  seo: { status: "ok", error_code: null, pages_analyzed: 5, findings: [] },
};

describe("buildHypothesis — silence when there is nothing honest to say", () => {
  it("says nothing when there is no site to read", () => {
    expect(buildHypothesis({ ...BASE, hasSite: false })).toBeNull();
    expect(buildHypothesis({ ...BASE, seo: null })).toBeNull();
    expect(
      buildHypothesis({ ...BASE, seo: { ...BASE.seo!, error_code: "seo_site_unknown" } }),
    ).toBeNull();
  });

  it("says nothing when the crawl read no pages and found nothing", () => {
    expect(
      buildHypothesis({ ...BASE, stage: 3, seo: { ...BASE.seo!, pages_analyzed: 0 } }),
    ).toBeNull();
  });
});

describe("buildHypothesis — never bluffs", () => {
  const ALL: HypothesisInput[] = [
    BASE,
    { ...BASE, stage: 0 },
    { ...BASE, seo: { ...BASE.seo!, status: "error", error_code: "seo_site_unreachable" } },
    {
      ...BASE,
      seo: {
        ...BASE.seo!,
        findings: [
          {
            code: "noindex",
            severity: "blocker",
            scope: "site" as const,
            summary: "Every page checked asks search engines not to index it",
            urls: ["https://acme.com/", "https://acme.com/pricing"],
          },
        ],
      },
    },
    {
      ...BASE,
      seo: {
        ...BASE.seo!,
        findings: [
          {
            code: "noindex",
            severity: "high",
            scope: "partial" as const,
            summary: "1 of 5 pages checked ask search engines not to index them",
            urls: ["https://acme.com/blog"],
          },
        ],
      },
    },
    {
      ...BASE,
      seo: {
        ...BASE.seo!,
        findings: Array.from({ length: 3 }, (_, i) => ({
          code: `h${i}`,
          severity: "high",
          summary: `high issue ${i}`,
          urls: [`https://acme.com/${i}`],
        })),
      },
    },
  ];

  it("never claims a number or a metric it cannot observe", () => {
    for (const input of ALL) {
      const h = buildHypothesis(input);
      if (!h) continue;
      const text = `${h.statement} ${h.evidence.join(" ")}`.toLowerCase();
      for (const forbidden of [
        "traffic",
        "ranks",
        "ranking",
        "impressions",
        "click-through",
        "ctr",
        "conversion rate",
        "churn",
        "revenue",
        "% ",
      ]) {
        expect(text, `"${forbidden}" leaked into: ${h.statement}`).not.toContain(forbidden);
      }
      expect(/\d+%/.test(text)).toBe(false);
    }
  });

  it("always states what it cannot see, and never claims high confidence", () => {
    for (const input of ALL) {
      const h = buildHypothesis(input);
      if (!h) continue;
      expect(h.cannot_see.length).toBeGreaterThan(0);
      expect(["low", "medium"]).toContain(h.confidence);
      expect(h.evidence.length).toBeGreaterThan(0);
      expect(h.question.trim().endsWith("?")).toBe(true);
    }
  });
});

describe("buildHypothesis — the rules", () => {
  it("leads with an observed SITE-WIDE indexing blocker, at medium confidence", () => {
    const h = buildHypothesis({
      ...BASE,
      stage: 0,
      seo: {
        ...BASE.seo!,
        findings: [
          {
            code: "noindex",
            severity: "blocker",
            scope: "site",
            summary: "Every page checked asks search engines not to index it",
            urls: ["https://acme.com/", "https://acme.com/pricing"],
          },
        ],
      },
    })!;
    expect(h.confidence).toBe("medium");
    expect(h.statement).toMatch(/your site is currently telling search engines not to list it/i);
    expect(h.evidence).toContain("Every page checked asks search engines not to index it");
  });

  it("never widens a partial noindex into a site-wide claim", () => {
    const h = buildHypothesis({
      ...BASE,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: 2,
        findings: [
          {
            code: "noindex",
            severity: "high",
            scope: "partial",
            summary: "1 of 2 pages checked ask search engines not to index them",
            urls: ["https://upcar.ai/blog"],
          },
        ],
      },
    })!;
    expect(h.statement).not.toMatch(/your site is currently telling search engines/i);
    expect(h.statement).toContain("https://upcar.ai/blog");
    expect(h.statement).toMatch(/one of the 2 page\(s\)/i);
    expect(h.evidence).toContain("1 of 2 pages checked ask search engines not to index them");
    expect(h.confidence).toBe("medium");
  });

  it("names the count, not just one page, when several pages are noindexed", () => {
    const h = buildHypothesis({
      ...BASE,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: 6,
        findings: [
          {
            code: "noindex",
            severity: "high",
            scope: "partial",
            summary: "2 of 6 pages checked ask search engines not to index them",
            urls: ["https://upcar.ai/blog", "https://upcar.ai/press"],
          },
        ],
      },
    })!;
    expect(h.statement).toMatch(/^2 of the 6 page\(s\)/);
    expect(h.statement).toContain("https://upcar.ai/blog");
    expect(h.statement).not.toMatch(/your site is currently telling search engines/i);
  });

  it("keeps a homepage-only noindex on the narrow sentence", () => {
    const h = buildHypothesis({
      ...BASE,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: 4,
        findings: [
          {
            code: "noindex",
            severity: "blocker",
            scope: "partial",
            summary: "1 of 4 pages checked ask search engines not to index them",
            urls: ["https://acme.com/"],
          },
        ],
      },
    })!;
    expect(h.statement).not.toMatch(/your site is currently telling search engines/i);
    expect(h.statement).toContain("https://acme.com/");
  });

  it("uses the site-wide sentence for a blanket robots.txt disallow", () => {
    const noScope = buildHypothesis({
      ...BASE,
      seo: {
        ...BASE.seo!,
        findings: [
          {
            code: "robots_disallow_all",
            severity: "blocker",
            summary: "robots.txt tells every search engine not to crawl any page on the site",
            urls: ["/robots.txt"],
          },
        ],
      },
    })!;
    expect(noScope.statement).toMatch(/your site is currently telling search engines not to list it/i);

    const h = buildHypothesis({
      ...BASE,
      seo: {
        ...BASE.seo!,
        findings: [
          {
            code: "robots_disallow_all",
            severity: "blocker",
            scope: "site",
            summary: "robots.txt tells every search engine not to crawl any page on the site",
            urls: ["/robots.txt"],
          },
        ],
      },
    })!;
    expect(h.statement).toMatch(/your site is currently telling search engines not to list it/i);
  });

  it("treats a scope-less cached finding as narrow, not site-wide", () => {
    const h = buildHypothesis({
      ...BASE,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: 3,
        findings: [
          {
            code: "noindex",
            severity: "blocker",
            summary: "1 of 3 pages checked ask search engines not to index them",
            urls: ["https://acme.com/blog"],
          },
        ],
      },
    })!;
    expect(h.statement).not.toMatch(/your site is currently telling search engines/i);
    expect(h.statement).toContain("https://acme.com/blog");
  });

  it("does not call a site clean while a page it read asks not to be listed", () => {
    const h = buildHypothesis({
      ...BASE,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: 5,
        findings: [
          {
            code: "noindex",
            severity: "high",
            scope: "partial",
            summary: "1 of 5 pages checked ask search engines not to index them",
            urls: ["https://acme.com/blog"],
          },
        ],
      },
    })!;
    expect(h.statement).not.toMatch(/reads clean/i);
    expect(h.evidence.join(" ")).not.toMatch(/nothing blocking discovery/i);
  });

  it("calls a pre-launch company early rather than inventing a subtler read", () => {
    const h = buildHypothesis({ ...BASE, stage: 0 })!;
    expect(h.statement).toMatch(/nobody knows you exist/i);
    expect(h.confidence).toBe("low");
  });

  it("uses a clean site to point at what it cannot see", () => {
    const h = buildHypothesis(BASE)!;
    expect(h.statement).toMatch(/after people land/i);
    expect(h.question).toMatch(/lose people/i);
  });

  it("prefers the specific claim over the generic one", () => {
    const withBlocker = buildHypothesis({
      ...BASE,
      stage: 0,
      seo: {
        ...BASE.seo!,
        findings: [
          {
            code: "noindex",
            severity: "blocker",
            scope: "site",
            summary: "noindex",
            urls: ["https://acme.com/"],
          },
        ],
      },
    })!;
    expect(withBlocker.statement).not.toMatch(/nobody knows you exist/i);
  });
});

describe("analyzeSeo → buildHypothesis, on the site that got the false claim", () => {
  const page = (url: string, extraHead = ""): FetchedPage => ({
    url,
    status: 200,
    headers: {},
    html:
      `<html><head><title>${url}</title>${extraHead}` +
      '<meta name="description" content="d"></head>' +
      `<body><h1>h</h1><p>${"word ".repeat(100)}</p></body></html>`,
  });

  it("does not tell a site with one noindexed page that its site is unlisted", () => {
    const report = analyzeSeo({
      pages: [
        page("https://upcar.ai/"),
        page("https://upcar.ai/blog", '<meta name="robots" content="noindex">'),
        page("https://upcar.ai/cars/tesla-model-3"),
      ],
      robots: { fetched: true, disallowsAll: false, sitemaps: ["https://upcar.ai/sitemap.xml"] },
      sitemapReachable: true,
    });

    const h = buildHypothesis({
      oneLiner: "Upcar is a peer-to-peer car-rental marketplace",
      stage: 3,
      gtmMotion: null,
      hasSite: true,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: report.pages_analyzed,
        findings: report.findings,
      },
    })!;

    expect(h.statement).not.toMatch(/your site is currently telling search engines/i);
    expect(h.statement).toContain("https://upcar.ai/blog");
    expect(h.statement).toMatch(/of the 3 page\(s\)/);
    expect(h.evidence[0]).toMatch(/1 of 3/);
  });
});

describe("R0 — the opening opens on research, and only on research that landed", () => {
  const READY = {
    status: "ready" as const,
    source_count: 4,
    source_hosts: ["trustpilot.com", "reddit.com"],
    competitors: [
      { name: "Turo", url: "https://turo.com" },
      { name: "Getaround", url: "https://getaround.com" },
    ],
  };

  it("fires on ready with two or more domain-matched sources, and names the competitors", () => {
    const h = buildHypothesis({ ...BASE, research: READY })!;
    expect(h.statement).toContain("Turo");
    expect(h.statement).toContain("Getaround");
    expect(h.confidence).toBe("medium");
    expect(h.evidence.join(" ")).toMatch(/Read 4 page\(s\)/);
  });

  it.each(["pending", "thin", "failed"] as const)(
    "does not fire on status %s — R1-R6 answer instead",
    (status) => {
      const h = buildHypothesis({ ...BASE, research: { ...READY, status } })!;
      expect(h.statement).not.toContain("Turo");
      expect(h.statement).toMatch(/reads clean to me technically/);
    },
  );

  it("does not fire on a single source, however good it looks", () => {
    const h = buildHypothesis({ ...BASE, research: { ...READY, source_count: 1 } })!;
    expect(h.statement).not.toContain("Turo");
  });

  it("opens on the sources it can NAME when no competitor set was corroborated", () => {
    const h = buildHypothesis({ ...BASE, research: { ...READY, competitors: [] } })!;
    expect(h.statement).toContain("trustpilot.com");
    expect(h.confidence).toBe("medium");
  });

  it("needs TWO named competitors before it claims a comparison", () => {
    const h = buildHypothesis({
      ...BASE,
      research: { ...READY, competitors: [{ name: "Turo", url: "https://turo.com" }] },
    })!;
    expect(h.statement).not.toContain("Turo");
    expect(h.statement).toContain("trustpilot.com");
  });

  it("speaks for a tenant with NO site on file — which R1 never could", () => {
    const h = buildHypothesis({ ...BASE, hasSite: false, seo: null, research: READY });
    expect(h).not.toBeNull();
    expect(h!.statement).toContain("Turo");
  });

  it("is absent by default — every pre-research caller still gets R1-R6", () => {
    expect(buildHypothesis(BASE)!.statement).toMatch(/reads clean to me technically/);
    expect(buildHypothesis({ ...BASE, research: null })!.statement).toMatch(
      /reads clean to me technically/,
    );
  });

  it("never asserts a number it cannot see", () => {
    const h = buildHypothesis({ ...BASE, research: READY })!;
    expect(h.cannot_see.length).toBeGreaterThan(0);
    expect(h.statement).not.toMatch(/\d+%/);
    expect(h.statement).not.toMatch(/visitors|traffic|conversion rate/i);
  });
});

describe("buildHypothesis — the blocking flag", () => {
  type Finding = {
    code: string;
    severity: string;
    summary: string;
    urls: string[];
    scope?: "site" | "partial";
  };
  const seoWith = (findings: Finding[]) => ({
    status: "ok" as const,
    error_code: null,
    pages_analyzed: 4,
    findings,
  });
  const base = { oneLiner: null, stage: null, gtmMotion: null, hasSite: true };

  it("marks a site-wide robots block as blocking", () => {
    const h = buildHypothesis({
      ...base,
      seo: seoWith([
        { code: "robots_disallow_all", severity: "blocker", summary: "s", urls: ["/robots.txt"], scope: "site" },
      ]),
    });
    expect(h?.blocking).toBe(true);
  });

  it("marks every-page-noindex as blocking", () => {
    const h = buildHypothesis({
      ...base,
      seo: seoWith([
        { code: "noindex", severity: "blocker", summary: "s", urls: ["https://x.com/", "https://x.com/a"], scope: "site" },
      ]),
    });
    expect(h?.blocking).toBe(true);
  });

  it("does NOT mark a partial noindex as blocking — the Upcar case", () => {
    const h = buildHypothesis({
      ...base,
      seo: seoWith([
        { code: "noindex", severity: "high", summary: "1 of 4 pages checked", urls: ["https://x.com/blog"], scope: "partial" },
      ]),
    });
    expect(h).not.toBeNull();
    expect(h?.blocking).not.toBe(true);
  });

  it("marks an unreachable site as blocking", () => {
    const h = buildHypothesis({
      ...base,
      seo: { status: "error", error_code: "seo_site_unreachable", pages_analyzed: 0, findings: [] },
    });
    expect(h?.blocking).toBe(true);
  });

  it("leaves an ordinary clean-site opinion unblocking", () => {
    const h = buildHypothesis({ ...base, stage: 4, seo: seoWith([]) });
    expect(h?.blocking).not.toBe(true);
  });
});

describe("a blocker outranks research", () => {
  const READY_RESEARCH = {
    status: "ready" as const,
    source_count: 4,
    source_hosts: ["trustpilot.com", "reddit.com"],
    competitors: [
      { name: "Turo", url: "https://turo.com" },
      { name: "Getaround", url: "https://getaround.com" },
    ],
  };
  const base = { oneLiner: null, stage: null, gtmMotion: null, hasSite: true };

  it("prefers a site-wide noindex over a successful research pass", () => {
    const h = buildHypothesis({
      ...base,
      research: READY_RESEARCH,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: 4,
        findings: [
          { code: "noindex", severity: "blocker", summary: "Every page checked", urls: ["https://x.com/"], scope: "site" },
        ],
      },
    });
    expect(h?.blocking).toBe(true);
    expect(h?.statement).toMatch(/not to list it/i);
    expect(h?.statement).not.toContain("Turo");
  });

  it("prefers an unreachable site over a successful research pass", () => {
    const h = buildHypothesis({
      ...base,
      research: READY_RESEARCH,
      seo: { status: "error", error_code: "seo_site_unreachable", pages_analyzed: 0, findings: [] },
    });
    expect(h?.blocking).toBe(true);
    expect(h?.statement).toMatch(/couldn't load your site/i);
    expect(h?.statement).not.toContain("Turo");
  });

  it("still prefers research over a partial (page-level) noindex", () => {
    const h = buildHypothesis({
      ...base,
      research: READY_RESEARCH,
      seo: {
        status: "ok",
        error_code: null,
        pages_analyzed: 4,
        findings: [
          { code: "noindex", severity: "high", summary: "1 of 4 pages checked", urls: ["https://x.com/blog"], scope: "partial" },
        ],
      },
    });
    expect(h?.statement).toContain("Turo");
    expect(h?.blocking).not.toBe(true);
  });

  it("still opens on research when there is no site on file", () => {
    const h = buildHypothesis({ ...base, hasSite: false, research: READY_RESEARCH, seo: null });
    expect(h?.statement).toContain("Turo");
  });
});

describe("pages means web pages once Markdown files were read too", () => {
  it("does not call a Markdown-only crawl a technically clean site", () => {
    const h = buildHypothesis({ ...BASE, stage: 3, seo: { ...BASE.seo!, pages_analyzed: 3, web_pages: 0, findings: [] } });
    expect(h?.statement ?? "").not.toMatch(/reads clean/);
  });

  it("does not tell a founder their site is unlisted when only Markdown files were read", () => {
    const h = buildHypothesis({
      ...BASE,
      stage: 3,
      seo: {
        ...BASE.seo!,
        pages_analyzed: 2,
        web_pages: 0,
        findings: [
          { code: "noindex", severity: "blocker", scope: "site", summary: "x", urls: ["https://example.com/a.md", "https://example.com/b.md"] },
        ],
      },
    });
    expect(h?.statement).not.toMatch(/Your site is currently telling/);
    expect(h?.statement).toContain("2 of the 2 file(s) I read");
    expect(h?.statement).not.toMatch(/page-level|rest of what I read/);
    expect(h?.question).toContain("those files");
  });

  it("counts files and web pages apart in a page-level noindex", () => {
    const h = buildHypothesis({
      ...BASE,
      stage: 3,
      seo: {
        ...BASE.seo!,
        pages_analyzed: 5,
        web_pages: 1,
        non_html_urls: ["https://example.com/auth.md", "https://example.com/b.md", "https://example.com/c.md", "https://example.com/d.md"],
        findings: [
          { code: "noindex", severity: "high", scope: "partial", summary: "x", urls: ["https://example.com/auth.md"] },
        ],
      },
    });
    expect(h?.statement).toContain("One of the 5 file(s) (1 web page(s)) I read");
    expect(h?.statement).not.toContain("5 page(s)");
    expect(h?.statement).toContain("file-level rather than your whole site");
    expect(h?.question).toContain("that file");
  });
});
