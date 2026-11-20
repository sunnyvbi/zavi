
import { describe, expect, it } from "vitest";
import { seoHealth, seoKpis, seoPagesReadWords, seoSpeedBandWord, seoTables, severityOf } from "./extraTables";
import type { SeoChannelPayload } from "./types";

function payload(over: Partial<SeoChannelPayload> = {}): SeoChannelPayload {
  return {
    generic: false,
    connected: false,
    site_health: {
      status: "ok",
      site: "https://www.example.com",
      error_code: null,
      fetched_at: "2026-09-20T19:03:41.069+00:00",
      stale: false,
      notes: [],
      pages_analyzed: 16,
      findings: [
        {
          code: "title_duplicate",
          severity: "high",
          summary: "Different pages share the same title, so search engines cannot tell which one answers which query.",
          urls: ["https://www.example.com/", "https://www.example.com/terms/conditions"],
        },
        {
          code: "h1_missing",
          severity: "medium",
          summary: "5 pages have no H1 heading.",
          urls: [
            "https://www.example.com/",
            "https://www.example.com/privacy-policy",
            "https://www.example.com/terms/conditions",
            "https://www.example.com/help-center",
            "https://www.example.com/buy/10001",
          ],
        },
        {
          code: "thin_server_html",
          severity: "high",
          summary: "1 page returned almost no readable text in the HTML itself.",
          urls: ["https://www.example.com/search"],
        },
      ],
      pages: Array.from({ length: 16 }, (_, i) => ({
        url: i === 0 ? "https://www.example.com/" : `https://www.example.com/page-${i}`,
        status: 200,
        title: i === 0 ? "Home" : `Page ${i}`,
        title_length: 50,
        meta_description: null,
        canonical: "https://www.example.com",
        h1_count: i === 0 ? 0 : 1,
        schema_types: ["Organization"],
        noindex: false,
        visible_words: 300 + i,
      })),
    },
    performance: {
      lab: {
        state: "ok",
        truncated: false,
        pages: [
          {
            strategy: "mobile",
            final_url: "https://www.example.com/",
            requested_url: "https://www.example.com/",
            fetch_time: "2026-09-18T02:26:09.263Z",
            lighthouse_version: "13.4.1",
            categories: [
              { id: "performance", title: "Performance", score: 0.35 },
              { id: "accessibility", title: "Accessibility", score: 0.85 },
              { id: "best-practices", title: "Best Practices", score: 1 },
              { id: "seo", title: "SEO", score: 1 },
            ],
            opportunities: Array.from({ length: 7 }, (_, i) => ({
              id: i === 0 ? "bootup-time" : `audit-${i}`,
              title: i === 0 ? "Reduce JavaScript execution time" : `Fix number ${i}`,
              score: 0,
              metricSavings: [{ metric: "TBT", value: 1450, unit: "ms" }],
              savingsMs: null,
              savingsBytes: null,
              culprits: [
                {
                  kind: "script",
                  label: "main.js",
                  owner: i === 0 ? "developer" : "founder",
                  detail: "819 ms of main-thread time.",
                  bytes: null,
                  wastedBytes: null,
                },
              ],
            })),
          },
        ],
      },
      field: {
        state: "ok",
        scope: "url",
        key: "https://www.example.com/",
        collection_period: { firstDate: { year: 2026, month: 8, day: 19 }, lastDate: { year: 2026, month: 9, day: 15 } },
        metrics: {
          largest_contentful_paint: { p75: 3214 },
          interaction_to_next_paint: { p75: 325 },
          cumulative_layout_shift: { p75: 0.33 },
          first_contentful_paint: { p75: 2482 },
          experimental_time_to_first_byte: { p75: 1660 },
        },
      },
      agent_readiness: {
        passed: 3,
        applicable: 4,
        disclosure: "Computed from the pages we fetched and your robots.txt.",
        checks: [
          { id: "llms_txt", label: "Has an /llms.txt", state: "pass", detail: "/llms.txt exists at the root." },
          { id: "server_html", label: "Content in the HTML", state: "pass", detail: "Readable without JavaScript." },
          { id: "crawlers", label: "AI crawlers admitted", state: "pass", detail: "robots.txt admits the major ones." },
          { id: "answer_block", label: "A self-contained answer", state: "fail", detail: "No answer block near the top." },
        ],
      },
      warming: false,
      fetched_at: "2026-09-18T02:26:09.263Z",
    },
    geo: {
      status: "ok",
      score: {
        total: 58,
        bands: [
          { key: "citability", label: "Passage citability", note: "A self-contained answer near the top.", score: 37, weight: 25 },
          { key: "authority", label: "Authority signals", note: "Named author, dates, sources.", score: 20, weight: 20 },
          { key: "technical", label: "Technical accessibility", note: "Survives a JS-free fetch.", score: 96, weight: 20 },
        ],
      },
      disclosure: "Our own heuristic, computed only from the pages we fetched.",
    },
    ...over,
  } as SeoChannelPayload;
}

const byId = (p: SeoChannelPayload) => new Map(seoTables(p).map((t) => [t.id, t]));
const kpi = (p: SeoChannelPayload, key: string) => seoKpis(p).find((m) => m.key === key);

describe("the six topic numbers carry their own scale and verdict", () => {
  it("counts issues that cost rank, scores speed and Google's check 0-100, and vitals out of 3", () => {
    const p = payload();
    expect(kpi(p, "seo_issues")).toMatchObject({ value: 3, tone: "bad" });
    expect(kpi(p, "seo_speed")).toMatchObject({ value: 35, outOf: { max: 100 }, tone: "bad" });
    expect(seoSpeedBandWord(p)).toBe("poor");
    expect(kpi(p, "seo_vitals_passing")).toMatchObject({ value: 0, outOf: { max: 3, of: true }, tone: "bad" });
    expect(kpi(p, "seo_vitals_passing")?.note).toBe("Worst: CLS 0.33");
    expect(kpi(p, "seo_google")).toMatchObject({ value: 100, tone: "good" });
    expect(kpi(p, "seo_ai")).toMatchObject({ value: 58, tone: "warn", note: "Weakest: Authority signals 20" });
    expect(kpi(p, "seo_schema")).toMatchObject({ value: 16, outOf: { max: 16, of: true }, tone: "good" });
  });

  it("always answers the same six numbers and five tables, in the same order", () => {
    expect(seoKpis(payload()).map((m) => m.key)).toEqual([
      "seo_issues",
      "seo_speed",
      "seo_vitals_passing",
      "seo_google",
      "seo_ai",
      "seo_schema",
    ]);
    expect(seoTables(payload()).map((t) => t.id)).toEqual([
      "seo_opportunities",
      "seo_vitals",
      "seo_google",
      "seo_ai",
      "seo_pages",
    ]);
  });

  it("keeps the tile and the table for a lane that did not report, with the reason", () => {
    const p = payload({ site_health: null, geo: null });
    const issues = kpi(p, "seo_issues")!;
    expect(issues.unmeasured).toMatch(/Not read yet/);
    expect(kpi(p, "seo_schema")?.unmeasured).toMatch(/Not read yet/);
    expect(kpi(p, "seo_ai")?.unmeasured).toMatch(/Not read yet/);
    expect(kpi(p, "seo_speed")?.value).toBe(35);
    expect(kpi(p, "seo_vitals_passing")?.value).toBe(0);
  });

  it("says the crawl failed, rather than that it found nothing", () => {
    const p = payload();
    p.site_health = { ...p.site_health!, status: "error", error_code: "fetch_timeout" };
    expect(kpi(p, "seo_issues")?.unmeasured).toMatch(/Couldn't read your site \(fetch timeout\)/);
    expect(seoHealth(p)).toMatchObject({ score: null, headline: "Couldn't read your site" });
  });

  it("says Google is measuring while a read is warming, not that it has no data", () => {
    const p = payload();
    p.performance = { ...p.performance!, lab: { state: "unavailable" }, warming: true };
    expect(kpi(p, "seo_speed")?.unmeasured).toMatch(/Measuring now/);
    expect(kpi(p, "seo_google")?.unmeasured).toMatch(/Measuring now/);
  });

  it("does not call a site with no Chrome visitors 0 of 3", () => {
    const p = payload();
    (p.performance as { field?: unknown }).field = { state: "no_data" };
    expect(kpi(p, "seo_vitals_passing")?.unmeasured).toMatch(/Too few Chrome visitors/);
  });

  it("opens, for each number, the table that measures that number, one number per table", async () => {
    const { PLATFORMS } = await import("../actions/platforms");
    const sel = (k: string) => PLATFORMS.seo.metricDisplay?.[k]?.selects;
    expect(sel("seo_speed")).toBe("seo_opportunities");
    expect(sel("seo_vitals_passing")).toBe("seo_vitals");
    expect(sel("seo_schema")).toBe("seo_pages");
    expect(sel("seo_issues")).toBeUndefined();
    const heads = Object.values(PLATFORMS.seo.metricDisplay ?? {}).flatMap((m) => (m.selects ? [m.selects] : [])).sort();
    expect(heads).toEqual([...new Set(heads)].sort());
    expect(heads).toEqual([...seoTables(payload()).map((t) => t.id)].sort());
  }, 20_000);

  it("answers nothing at all for a payload of the wrong shape", () => {
    expect(seoKpis({ generic: true })).toEqual([]);
    expect(seoTables({ generic: true })).toEqual([]);
    expect(seoHealth({ generic: true })).toBeNull();
    expect(seoKpis(null)).toEqual([]);
    expect(seoTables("not a payload")).toEqual([]);
  });
});

describe("site health is the share of pages with no error or warning", () => {
  it("counts each page once, errors first, and leaves notices out of the score", () => {
    const p = payload();
    p.site_health!.findings.push({
      code: "title_too_long",
      severity: "low",
      summary: "1 page has a long title.",
      urls: ["https://www.example.com/page-9"],
    });
    const h = seoHealth(p)!;
    expect(h.score).toBe(94);
    expect(h.tone).toBe("good");
    expect(h.headline).toBe("1 of 16 pages need fixes");
    expect(h.note).toMatch(
      /^15 are healthy\. Errors and warnings count; notices don't\. 1 site-wide issue is counted below, not in this share\. Last read .+\.$/,
    );
    expect(h.counts.map((c) => [c.kind, c.value])).toEqual([
      ["error", 2],
      ["warning", 1],
      ["notice", 1],
    ]);
    expect(h.segments?.map((s) => s.value)).toEqual([15, 0, 1]);
  });

  it("counts a site-scoped finding against every page read", () => {
    const p = payload();
    p.site_health!.findings = [
      { code: "robots_disallow_all", severity: "blocker", scope: "site", summary: "Blocked.", urls: ["/robots.txt"] },
    ];
    expect(seoHealth(p)).toMatchObject({ score: 0, tone: "bad", headline: "16 of 16 pages need fixes" });
  });

  it("counts a page-less issue as site-wide everywhere, and says it is outside the share", () => {
    const p = payload();
    p.site_health!.findings = [
      { code: "sitemap_missing", severity: "medium", summary: "No sitemap.", urls: ["/robots.txt"] },
    ];
    p.performance = {
      ...p.performance!,
      delivery_gap: { state: "diverged", lab_ms: 20, field_ms: 1600, note: "In front of the app." },
    };
    const h = seoHealth(p)!;
    expect(h.score).toBe(100);
    expect(h.counts.find((c) => c.kind === "warning")).toMatchObject({ value: 2, sub: "site-wide" });
    expect(h.headline).toBe("All 16 pages are healthy");
    expect(h.note).toMatch(/^Errors and warnings count; notices don't\. 2 site-wide issues are counted below, not in this share\. Last read /);
    expect(kpi(p, "seo_issues")?.note).toBe("site-wide");
  });

  it("says when the live site was last read", () => {
    const p = payload();
    p.site_health!.fetched_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(seoHealth(p)!.note).toMatch(/Last read 2h ago\.$/);
  });

  it("counts only pages in the list read, so the parts always add up", () => {
    const p = payload();
    p.site_health!.findings = [
      {
        code: "h1_missing",
        severity: "medium",
        summary: "x",
        urls: ["https://www.example.com/", "https://www.example.com/not-in-the-list"],
      },
    ];
    const h = seoHealth(p)!;
    expect(h.counts.find((c) => c.kind === "warning")?.sub).toBe("on 1 page");
    expect(kpi(p, "seo_issues")?.note).toBe("on 1 page");
    expect(h.segments?.map((s) => s.value)).toEqual([15, 1, 0]);
  });

  it("maps the analyzer's tags: blocker and high are errors, medium a warning, low a notice", () => {
    expect(severityOf({ severity: "blocker" })).toBe("error");
    expect(severityOf({ severity: "high" })).toBe("error");
    expect(severityOf({ severity: "medium" })).toBe("warning");
    expect(severityOf({ severity: "low" })).toBe("notice");
    expect(severityOf({})).toBe("warning");
  });
});

describe("a page read only in part is unknown, not schema-free", () => {
  it("leaves it out of the structured-data count and says so in the page list", () => {
    const p = payload();
    p.site_health!.pages[3] = { ...p.site_health!.pages[3], schema_types: [], truncated: true };
    expect(kpi(p, "seo_schema")).toMatchObject({ value: 15, outOf: { max: 15, of: true } });
    const row = byId(p).get("seo_pages")!.rows[3];
    expect(row.cells[2].text).toBe("Not read to the end");
  });

  it("says unknown, not 'not read yet', when every page was cut off", () => {
    const p = payload();
    p.site_health!.pages = p.site_health!.pages.map((pg) => ({ ...pg, schema_types: [], truncated: true }));
    expect(kpi(p, "seo_schema")?.unmeasured).toBe("No page was read to the end, so this is unknown.");
  });
});

describe("the tables print what Google measured, in the units it measured them in", () => {
  it("formats a vital as a duration with its band, not as a compacted count", () => {
    const vitals = byId(payload()).get("seo_vitals")!;
    const lcp = vitals.rows.find((r) => r.id === "largest_contentful_paint")!;
    expect(lcp.cells[1].text).toBe("3.2 s");
    expect(lcp.cells[2].text).toBe("needs work");
    expect(lcp.cells[2].tone).toBeUndefined();

    const cls = vitals.rows.find((r) => r.id === "cumulative_layout_shift")!;
    expect(cls.cells[1].text).toBe("0.33");
    expect(cls.cells[2].text).toBe("poor");
    expect(cls.cells[2].tone).toBe("bad");
  });

  it("states no verdict for a vital Google does not band", () => {
    const vitals = byId(payload()).get("seo_vitals")!;
    const fcp = vitals.rows.find((r) => r.id === "first_contentful_paint")!;
    expect(fcp.cells[2].text).toBe("-");
    expect(fcp.cells[3].text).toBe("not banded by Google");
  });

  it("ranks an opportunity by metricSavings, and says who can do it", () => {
    const opps = byId(payload()).get("seo_opportunities")!;
    expect(opps.rows).toHaveLength(7);
    expect(opps.rows[0].cells[0].text).toBe("Reduce JavaScript execution time");
    expect(opps.rows[0].cells[1].text).toBe("Needs a developer");
    expect(opps.rows[0].cells[2].text).toBe("1.4 s");
    expect(opps.rows[1].cells[1].text).toBe("You can do this");
  });

  it("says a mixed row needs both you and a developer, and names a score saving's metric", () => {
    const p = payload();
    const opp = (p as unknown as { performance: { lab: { pages: { opportunities: Record<string, unknown>[] }[] } } })
      .performance.lab.pages[0].opportunities[0];
    opp.culprits = [
      { kind: "script", label: "main.js", owner: "developer", detail: "x", bytes: null, wastedBytes: null },
      { kind: "script", label: "GA4", owner: "founder", detail: "y", bytes: null, wastedBytes: null },
    ];
    opp.metricSavings = [{ metric: "CLS", value: 0.332, unit: "score" }];
    const row = byId(p).get("seo_opportunities")!.rows[0];
    expect(row.cells[1].text).toBe("You and a developer");
    expect(row.cells[2].text).toBe("0.33 CLS");
  });

  it("offers no 7/14/30 window: the builder reads one crawl, so the picker names that one read", async () => {
    const { channelChrome } = await import("../agent/legacyChannelActions");
    expect(channelChrome("seo", payload())?.ranges).toEqual([{ id: "now", label: "Latest read", days: 30 }]);
  });

  it("dates the speed numbers, and says when a fresh test is running", () => {
    const p = payload();
    const day = new Date(p.performance!.fetched_at!).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    expect(byId(p).get("seo_opportunities")!.caption).toContain(`Measured ${day}.`);
    p.performance = { ...p.performance!, warming: true };
    expect(byId(p).get("seo_google")!.caption).toContain(`Measured ${day}. A fresh test is running now.`);
    expect(byId(p).get("seo_vitals")!.caption).toContain(`Measured ${day}.`);
  });

  it("marks a page with no H1 rather than printing a bare zero", () => {
    const pages = byId(payload()).get("seo_pages")!;
    expect(pages.rows).toHaveLength(16);
    expect(pages.rows[0].cells[3].tone).toBe("bad");
    expect(pages.rows[1].cells[3].tone).toBe("dim");
  });
});

describe("Markdown and text files the crawl read are not web pages", () => {
  it("places a noindex on a Markdown file on that file, not site-wide", () => {
    const p = payload();
    p.site_health!.pages_analyzed = 17;
    p.site_health!.non_html_urls = ["https://www.example.com/auth.md"];
    p.site_health!.findings = [
      {
        code: "noindex",
        severity: "high",
        scope: "partial",
        summary: "1 of 17 pages checked ask search engines not to index them.",
        urls: ["https://www.example.com/auth.md"],
      },
    ];
    const h = seoHealth(p)!;
    expect(h.counts.find((c) => c.kind === "error")).toMatchObject({ value: 1, sub: "on 1 other file" });
    expect(h.headline).toBe("All 16 pages are healthy");
    expect(h.note).toBe(
      "Errors and warnings count; notices don't. 1 file that is not a web page has issues counted below, not in this share.",
    );
    expect(h.note).not.toContain("site-wide");
    expect(kpi(p, "seo_issues")?.note).toBe("on 1 other file");
  });

  it("counts a site-scoped finding's Markdown files as files too", () => {
    const p = payload();
    p.site_health!.non_html_urls = ["https://www.example.com/auth.md"];
    p.site_health!.findings = [
      {
        code: "noindex",
        severity: "blocker",
        scope: "site",
        summary: "Every page checked asks search engines not to index it.",
        urls: ["https://www.example.com/", "https://www.example.com/auth.md"],
      },
    ];
    const h = seoHealth(p)!;
    expect(h.counts.find((c) => c.kind === "error")?.sub).toBe("on 16 pages + 1 other file");
  });

  it("uses the web page count for every pages-read number, not every file read", () => {
    const p = payload();
    p.site_health!.pages_analyzed = 20;
    p.site_health!.non_html_urls = ["a", "b", "c", "d"].map((x) => `https://www.example.com/${x}.md`);
    expect(seoPagesReadWords(p.site_health!)).toBe("16 pages read");
    expect(seoHealth(p)!.segmentsLabel).toBe("16 pages read");
    expect(byId(p).get("seo_pages")!.rows).toHaveLength(16);
  });

  it("says a Markdown-only crawl read files, none of them web pages, instead of reading nothing", () => {
    const p = payload();
    p.site_health!.pages_analyzed = 2;
    p.site_health!.non_html_urls = ["https://www.example.com/llms.txt", "https://www.example.com/docs.md"];
    p.site_health!.pages = [];
    p.site_health!.findings = [];
    const h = seoHealth(p)!;
    expect(h.headline).toBe("The crawl read 2 files, but none of them is a web page");
    expect(kpi(p, "seo_schema")?.unmeasured).toBe("The crawl read 2 files, but none of them is a web page.");
    expect(byId(p).get("seo_pages")!.empty).toBe("The crawl read 2 files, but none of them is a web page.");
    expect(seoPagesReadWords(p.site_health!)).toBe("2 files read, no web pages");
    expect(h.segmentsLabel).toBe("2 files read, no web pages");
  });
});
