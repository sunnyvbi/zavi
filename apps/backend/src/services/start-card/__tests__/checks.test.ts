
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StartCardParts, StartCardProfileEvidence } from "@zavi/shared";
import { parseOrganicItems, type SerpAnswer } from "@/services/channels/reddit/google-rank";
import type { EngineAnswer } from "@/services/tools/growth/geo/visibility/dataforseo";
import type { SeoFetchResult } from "@/services/tools/growth/seo/fetch";
import type { PagespeedResult } from "@/services/tools/growth/seo/pagespeed";
import type { RunEnrichmentResult } from "@/services/onboarding/enrichment/run";
import { StageUnavailableError, type StageContext } from "../checks/contract";
import { runProfile, cleanSearchTerm } from "../checks/profile";
import { runGoogle, positionOf } from "../checks/google";
import { runAi, aiPromptFor, mentions } from "../checks/ai";
import { runSeo } from "../checks/seo";
import { runDesign } from "../checks/design";
import { runCompare } from "../checks/compare";
import { detectCountry } from "../checks/country";
import { toRenderResult } from "../checks/render";

const profile: StartCardProfileEvidence = {
  company_name: "Acme Plumbing",
  category: "plumber",
  search_term: "emergency plumber austin",
  country: "US",
  country_from: "address",
  country_label: "United States",
  city: "Austin",
  rivals: [
    { name: "Pipe Pros", domain: "pipepros.com", no_site: false, source_url: "https://news.example/best" },
    { name: "Drain Kings", domain: "drainkings.com", no_site: false, source_url: "https://news.example/best" },
    { name: "Old Joe", domain: null, no_site: true, source_url: "https://blog.example/austin" },
  ],
};

const ctx = (over: Partial<StageContext> = {}): StageContext => ({
  card_id: "c1",
  domain: "acmeplumbing.com",
  url: "https://acmeplumbing.com/",
  profile,
  parts: {},
  ...over,
});

const expectUnavailable = async (p: Promise<unknown>, reason: string) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(StageUnavailableError);
  expect((err as StageUnavailableError).reason).toBe(reason);
  return err as StageUnavailableError;
};

const enrichOk: RunEnrichmentResult = {
  status: "ok",
  org_name: "Acme Plumbing",
  company_name: "Acme Plumbing",
  payload: {
    domain_pages: [
      { url: "https://acmeplumbing.com/", title: "Acme Plumbing | Austin", text_excerpt: "24/7 plumbers. 100 Main St, Austin, TX 78701. Call now." },
    ],
    app_listings: [],
    research_pages: [],
  },
  competitors: [
    { name: "Pipe Pros", url: "https://pipepros.com", source_title: "Best", source_url: "https://news.example/best", snippet: "" },
    { name: "Old Joe", url: "", source_title: "Guide", source_url: "https://blog.example/austin", snippet: "" },
    { name: "Self", url: "https://acmeplumbing.com", source_title: "x", source_url: "https://x.example", snippet: "" },
    { name: "Drain Kings", url: "https://drainkings.com", source_title: "Best", source_url: "https://news.example/best", snippet: "" },
    { name: "Fourth", url: "https://fourth.com", source_title: "Best", source_url: "https://news.example/best", snippet: "" },
  ],
  estimated_cost_usd: 0.5,
  spend_inputs: { enrichmentTokens: 0, domain_pages: 1, research_pages: 0, app_listings: 0, tavilyCalls: 3, fetchCalls: 1, apifyCalls: 0 },
};

describe("profile", () => {
  it("names the business, keeps 3 rivals with their own domain (no_site kept), picks country and term", async () => {
    const out = await runProfile(ctx({ profile: null }), {
      enrich: async () => enrichOk,
      complete: async () => '{"search_term":"Emergency Plumber Austin","category":"plumber","city":"Austin"}',
    });
    expect(out.evidence.company_name).toBe("Acme Plumbing");
    expect(out.evidence.search_term).toBe("emergency plumber austin");
    expect(out.evidence.country).toBe("US");
    expect(out.evidence.country_from).toBe("address");
    expect(out.evidence.rivals).toEqual([
      { name: "Pipe Pros", domain: "pipepros.com", no_site: false, source_url: "https://news.example/best" },
      { name: "Old Joe", domain: null, no_site: true, source_url: "https://blog.example/austin" },
      { name: "Drain Kings", domain: "drainkings.com", no_site: false, source_url: "https://news.example/best" },
    ]);
    expect(out.cost_usd).toBeGreaterThan(0);
  });

  it("saves the enrichment's company type only when it was confident", async () => {
    const complete = async () => '{"search_term":"emergency plumber austin","category":"plumber","city":"Austin"}';
    const high = await runProfile(ctx({ profile: null }), {
      enrich: async () => ({ ...enrichOk, shape_stage: { shape: "services", stage: 3, confidence: "high" } }),
      complete,
    });
    expect(high.evidence.company_type).toBe("services");
    const low = await runProfile(ctx({ profile: null }), {
      enrich: async () => ({ ...enrichOk, shape_stage: { shape: "saas", stage: 0, confidence: "low" } }),
      complete,
    });
    expect("company_type" in low.evidence).toBe(false);
  });

  it("a failed model call keeps the profile with an empty term (Google/AI then say no_search_term)", async () => {
    const out = await runProfile(ctx({ profile: null }), {
      enrich: async () => enrichOk,
      complete: async () => {
        throw new Error("auth");
      },
    });
    expect(out.evidence.search_term).toBe("");
    expect(out.evidence.rivals).toHaveLength(3);
    await expectUnavailable(runGoogle(ctx({ profile: out.evidence })), "no_search_term");
  });

  it("an unreadable site is unavailable, not a profile of nothing", async () => {
    await expectUnavailable(
      runProfile(ctx({ profile: null }), { enrich: async () => ({ status: "all_fetches_failed", org_name: "x" }) }),
      "site_unreadable",
    );
  });

  it("refuses a branded search term", () => {
    expect(cleanSearchTerm("acme plumbing reviews", ["Acme Plumbing", "acmeplumbing"])).toBe("");
    expect(cleanSearchTerm("plumber near me", ["Acme Plumbing", "acmeplumbing"])).toBe("plumber near me");
  });
});

describe("country (T5)", () => {
  it(".co.uk → GB from the ccTLD", () => {
    expect(detectCountry("acme.co.uk", [])).toMatchObject({ country: "GB", country_from: "cctld" });
  });
  it("a .com with a Mumbai address → IN", () => {
    expect(detectCountry("acme.com", ["Visit us: 12 MG Road, Mumbai 400001. Call +91 98200 00000"])).toMatchObject({
      country: "IN",
      country_from: "address",
    });
  });
  it(".jp → US, labelled as the default", () => {
    expect(detectCountry("acme.jp", ["東京"])).toMatchObject({ country: "US", country_from: "default_us", country_label: "United States" });
  });
  it("the model's country corroborates a weak page mention, but never decides alone", () => {
    expect(detectCountry("dishoom.com", ["Our restaurant in London"], "GB")).toMatchObject({ country: "GB", country_from: "address" });
    expect(detectCountry("acme.com", ["Nothing about places"], "GB")).toMatchObject({ country: "US", country_from: "default_us" });
  });
  it("one weak hint is not an address", () => {
    expect(detectCountry("acme.io", ["We love London in spring"])).toMatchObject({ country: "US", country_from: "default_us" });
  });
  it("a site with no country signal is checked from the visitor's country", () => {
    expect(detectCountry("acme.com", ["Nothing about places"], null, "IN")).toMatchObject({
      country: "IN",
      country_from: "visitor",
      country_label: "India",
    });
  });
  it("the site's own ccTLD or address beats the visitor's country", () => {
    expect(detectCountry("acme.co.uk", [], null, "IN")).toMatchObject({ country: "GB", country_from: "cctld" });
    expect(detectCountry("acme.com", ["Call +91 98200 00000, Mumbai"], null, "GB")).toMatchObject({ country: "IN", country_from: "address" });
    expect(detectCountry("acme.jp", [], null, "IN")).toMatchObject({ country: "US", country_from: "default_us" });
  });
  it("a US, unsupported or junk visitor country keeps the labelled US default", () => {
    for (const v of ["US", "JP", "xx", "", null, undefined]) {
      expect(detectCountry("acme.com", [], null, v)).toMatchObject({ country: "US", country_from: "default_us" });
    }
  });
  it("the profile stage checks from the visitor's country when the pages say nothing", async () => {
    const noPlace = {
      ...enrichOk,
      payload: { ...enrichOk.payload, domain_pages: [{ url: "https://acmeplumbing.com/", title: "Acme Plumbing", text_excerpt: "24/7 plumbers." }] },
    };
    const complete = async () => '{"search_term":"emergency plumber","category":"plumber","city":null,"country":null}';
    const fromVisitor = await runProfile(ctx({ profile: null, visitor_country: "AU" }), { enrich: async () => noPlace, complete });
    expect(fromVisitor.evidence).toMatchObject({ country: "AU", country_from: "visitor", country_label: "Australia" });
    const fromSite = await runProfile(ctx({ profile: null, visitor_country: "AU" }), { enrich: async () => enrichOk, complete });
    expect(fromSite.evidence).toMatchObject({ country: "US", country_from: "address" });
  });
});

const serpOk: SerpAnswer = {
  ok: true,
  hits: [],
  organic: [
    { rank: 1, url: "https://www.yelp.com/search?x", domain: "yelp.com" },
    { rank: 2, url: "https://pipepros.com/", domain: "pipepros.com" },
    { rank: 7, url: "https://www.acmeplumbing.com/emergency", domain: "acmeplumbing.com" },
    { rank: 9, url: "https://blog.acmeplumbing.com/x", domain: "blog.acmeplumbing.com" },
    { rank: 60, url: "https://other.com/", domain: "other.com" },
  ],
  cost_usd: 0.002,
};

describe("google", () => {
  beforeEach(() => {
    vi.stubEnv("DATAFORSEO_LOGIN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds the business by registrable domain and scores the band", async () => {
    const serp = vi.fn(async () => serpOk);
    const out = await runGoogle(ctx(), { serp });
    expect(serp).toHaveBeenCalledWith("emergency plumber austin", "US");
    expect(out.evidence.position).toBe(7);
    expect(out.points).toBe(15);
    expect(out.evidence.results_checked).toBe(60);
    expect(out.evidence.rivals).toEqual([
      { domain: "pipepros.com", position: 2 },
      { domain: "drainkings.com", position: null },
    ]);
    expect(out.evidence.top_domains).toEqual(["pipepros.com", "other.com"]);
    expect(out.evidence.note).toBe("#7 on Google for “emergency plumber austin”.");
    expect(out.cost_usd).toBe(0.002);
  });

  it("a business holding the featured snippet on a subdomain ranks first", async () => {
    const organic = parseOrganicItems({
      items: [
        { type: "featured_snippet", rank_group: 1, url: "https://workspace.google.com/" },
        { type: "organic", rank_group: 1, url: "https://www.iotecdigital.com/suite" },
        { type: "organic", rank_group: 2, url: "https://www.zoho.com/workplace/" },
      ],
    });
    const out = await runGoogle(ctx({ domain: "google.com" }), { serp: async () => ({ ok: true, hits: [], organic, cost_usd: 0.002 }) });
    expect(out.evidence.position).toBe(1);
    expect(out.points).toBe(20);
    expect(out.evidence.note).toBe("#1 on Google for “emergency plumber austin”.");
  });

  it("not in the results is 0 points, with the depth we actually checked", async () => {
    const out = await runGoogle(ctx({ domain: "nothere.com" }), { serp: async () => serpOk });
    expect(out.points).toBe(0);
    expect(out.evidence.note).toContain("Not in the top 60");
  });

  it("no DataForSEO keys → unavailable, $0", async () => {
    const e = await expectUnavailable(
      runGoogle(ctx(), { serp: async () => ({ ok: false, error_code: "dataforseo_not_configured", cost_usd: null }) }),
      "vendor_not_configured",
    );
    expect(e.cost_usd).toBe(0);
  });

  it("DataForSEO out of credit (402) → vendor_out_of_credit, $0 (the call never ran)", async () => {
    const e = await expectUnavailable(
      runGoogle(ctx(), { serp: async () => ({ ok: false, error_code: "dataforseo_http_402", cost_usd: null }) }),
      "vendor_out_of_credit",
    );
    expect(e.cost_usd).toBe(0);
  });

  it("a vendor error → unavailable, charged the estimate", async () => {
    const e = await expectUnavailable(
      runGoogle(ctx(), { serp: async () => ({ ok: false, error_code: "dataforseo_timeout", cost_usd: null }) }),
      "dataforseo_timeout",
    );
    expect(e.cost_usd).toBeGreaterThan(0);
  });

  it("positionOf ignores a directory page about the business", () => {
    expect(positionOf([{ rank: 1, url: "https://yelp.com/biz/acmeplumbing-com", domain: "yelp.com" }], "acmeplumbing.com")).toBeNull();
  });
});

const answer = (text: string, cost = 0.004): EngineAnswer => ({
  ok: true,
  text,
  citations: [],
  fan_out_queries: [],
  model: null,
  cost_usd: cost,
  data_source: "dataforseo.llm_scraper",
});
const models = async () => ({ claude: "c", perplexity: "sonar" });

describe("ai", () => {
  it("one prompt × 4 engines; 5 points per engine that names the business; rivals read from the same answers", async () => {
    const texts: Record<string, EngineAnswer> = {
      chatgpt: answer("Top picks: **Acme Plumbing** and Pipe Pros (https://acmeplumbing.com)."),
      gemini: answer("Pipe Pros is well reviewed."),
      perplexity: answer("Try acmeplumbing.com or Drain Kings."),
      claude: { ok: false, error_code: "dataforseo_timeout", cost_usd: null, data_source: "dataforseo.llm_responses" },
    };
    const ask = vi.fn(async (engine: { id: string }, _prompt: string) => texts[engine.id]);
    const out = await runAi(ctx(), { ask, models });
    expect(ask).toHaveBeenCalledTimes(4);
    expect(new Set(ask.mock.calls.map((c) => c[1]))).toEqual(
      new Set(["What are the best plumber options in Austin? Name the specific businesses you would recommend."]),
    );
    const byEngine = Object.fromEntries(out.evidence.engines.map((e) => [e.engine, e]));
    expect(byEngine.chatgpt).toMatchObject({ answered: true, mentioned: true, rivals_mentioned: ["pipepros.com"] });
    expect(byEngine.gemini).toMatchObject({ answered: true, mentioned: false, rivals_mentioned: ["pipepros.com"] });
    expect(byEngine.perplexity).toMatchObject({ answered: true, mentioned: true, rivals_mentioned: ["drainkings.com"] });
    expect(byEngine.claude).toMatchObject({ answered: false, mentioned: null });
    expect(out.points).toBe(13);
    expect(out.evidence.note).toBe("Named by 2 of 3 AI assistants (ChatGPT and Perplexity); 1 did not answer.");
  });

  it("no DataForSEO keys → unavailable, $0", async () => {
    const e = await expectUnavailable(
      runAi(ctx(), {
        models,
        ask: async () => ({ ok: false, error_code: "dataforseo_not_configured", cost_usd: null, data_source: "x" }),
      }),
      "vendor_not_configured",
    );
    expect(e.cost_usd).toBe(0);
  });

  it("every engine out of credit → vendor_out_of_credit, $0", async () => {
    const e = await expectUnavailable(
      runAi(ctx(), {
        models,
        ask: async (engine) => ({
          ok: false,
          error_code: engine.id === "chatgpt" ? "dataforseo_40200" : "dataforseo_http_402",
          cost_usd: null,
          data_source: "x",
        }),
      }),
      "vendor_out_of_credit",
    );
    expect(e.cost_usd).toBe(0);
  });

  it("every engine erroring → unavailable (never 0/20)", async () => {
    await expectUnavailable(
      runAi(ctx(), { models, ask: async () => ({ ok: false, error_code: "dataforseo_timeout", cost_usd: 0.01, data_source: "x" }) }),
      "no_engine_answered",
    );
  });

  it("the prompt uses the city, else a non-US country, else nothing", () => {
    expect(aiPromptFor({ ...profile, city: null, country: "GB", country_from: "cctld", country_label: "United Kingdom" })).toContain(
      "plumber options in United Kingdom?",
    );
    expect(aiPromptFor({ ...profile, city: null, country: "US", country_from: "default_us" })).toContain("plumber options?");
  });

  it("the name's leading word counts when it is the domain's label", () => {
    expect(mentions("Brightloaf is great", "Brightloaf Bakery", "brightloaf.com")).toBe(true);
    expect(mentions("A bright loaf", "Brightloaf Bakery", "brightloaf.com")).toBe(false);
  });
});

const HOME_HTML =
  '<html><head><title>Acme Plumbing | 24/7 plumbers in Austin</title><meta name="description" content="Emergency and routine plumbing across Austin. Licensed, insured, and on the way in under an hour."><script type="application/ld+json">{"@type":"Plumber"}</script></head><body><h1>Plumbers</h1></body></html>';

function site(over: Partial<SeoFetchResult> = {}, homeStatus = 200, html = HOME_HTML): SeoFetchResult {
  return {
    pages: [
      { url: "https://acmeplumbing.com/", status: homeStatus, headers: {}, html },
      { url: "https://acmeplumbing.com/pricing", status: 404, headers: {}, html: "" },
      { url: "https://acmeplumbing.com/services", status: 404, headers: {}, html: "" },
      { url: "https://acmeplumbing.com/team", status: 403, headers: {}, html: "" },
    ],
    robots: { fetched: true, disallowsAll: false, sitemaps: [] },
    robotsBody: "",
    sitemapReachable: true,
    llmsTxt: null,
    ssrf_blocked: 0,
    truncated: false,
    pages_planned: 4,
    graph: {
      sitemap_paths: ["/services", "/team"],
      sitemap_query_only_paths: [],
      sitemap_as_written: ["/services", "/team"],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: [],
    },
    ...over,
  };
}

describe("seo", () => {
  it("scores the rubric; only pages the site points at count as broken, and only 404/410/5xx", async () => {
    const fetchSite = vi.fn(async (origin: string) =>
      origin.includes("pipepros") ? site({}, 200, "<title>Pipe Pros</title><h1>a</h1><h1>b</h1>") : origin.includes("drainkings") ? site({}, 403) : site(),
    );
    const out = await runSeo(ctx(), { fetchSite });
    expect(fetchSite).toHaveBeenCalledWith("https://acmeplumbing.com", expect.any(Array), { maxPages: 6 });
    expect(fetchSite).toHaveBeenCalledWith("https://pipepros.com", ["/"], { maxPages: 1 });
    expect(out.evidence.broken_links).toEqual([{ url: "https://acmeplumbing.com/services", status: 404 }]);
    expect(out.points).toBe(17);
    expect(out.evidence.note).toBe("1 broken link (homepage read, 4 pages checked for broken links).");
    expect(out.evidence.rivals).toEqual([
      { domain: "pipepros.com", points: 3 },
      { domain: "drainkings.com", points: null },
    ]);
  });

  it("keeps the pages the site lists for the advice: no repeats, no oversized path, at most 200", async () => {
    const graph = {
      sitemap_paths: ["/a", `/${"x".repeat(200)}`, ...Array.from({ length: 300 }, (_, i) => `/p${i}`)],
      sitemap_query_only_paths: [],
      sitemap_as_written: [],
      sitemap_complete: true,
      llms_txt_paths: null,
      linked_paths: ["/a"],
    };
    const out = await runSeo(ctx(), { fetchSite: async () => site({ graph }) });
    const pages = out.evidence.site_pages!;
    expect(pages).toHaveLength(200);
    expect(pages[0]).toBe("/a");
    expect(new Set(pages).size).toBe(200);
    expect(pages.every((p) => p.length <= 100)).toBe(true);
  });

  it("a homepage behind a bot wall → unavailable, not 0", async () => {
    await expectUnavailable(runSeo(ctx(), { fetchSite: async () => site({}, 403) }), "site_unreachable");
  });

  it("a fetch that throws → unavailable", async () => {
    await expectUnavailable(
      runSeo(ctx(), {
        fetchSite: async () => {
          throw new Error("dns");
        },
      }),
      "site_unreachable",
    );
  });
});

const psiOk = (perf: number, a11y: number): PagespeedResult =>
  ({
    kind: "ok",
    requested_url: "https://acmeplumbing.com/",
    strategy: "mobile",
    final_url: null,
    fetch_time: null,
    lighthouse_version: null,
    categories: [
      { id: "performance", title: null, score: perf, scoreDisplayMode: null, audits: null },
      { id: "accessibility", title: null, score: a11y, scoreDisplayMode: null, audits: null },
    ],
    agentic_browsing: null,
    opportunities: [],
    server_response_ms: null,
  }) as PagespeedResult;

const good = { cta_above_fold: true, body_text_px: 16, overlapping_boxes: false, horizontal_scroll: false };
const bad = { cta_above_fold: false, body_text_px: 12, overlapping_boxes: true, horizontal_scroll: false };

describe("design", () => {
  it("PageSpeed + phone render for the visitor; rivals on render only, scaled to 20", async () => {
    const render = vi.fn(async (urls: string[]) => urls.map((u) => (u.includes("drainkings") ? null : u.includes("pipepros") ? bad : good)));
    const out = await runDesign(ctx(), { pagespeed: async () => psiOk(0.72, 0.88), render });
    expect(render).toHaveBeenCalledWith(["https://acmeplumbing.com/", "https://pipepros.com/", "https://drainkings.com/"]);
    expect(out.evidence.pagespeed).toEqual({ performance: 72, accessibility: 88 });
    expect(out.points).toBe(15);
    expect(out.evidence.rivals).toEqual([
      { domain: "pipepros.com", render: bad, points: 4 },
      { domain: "drainkings.com", render: null, points: null },
    ]);
    expect(out.evidence.note).toBe("Mobile speed 72/100, accessibility 88/100; phone screen passes all four checks.");
  });

  it("PageSpeed timed out → the render half is scaled to 20", async () => {
    const out = await runDesign(ctx(), {
      pagespeed: async () => ({ kind: "timeout", timeout_ms: 90_000 }),
      render: async (urls) => urls.map(() => bad),
    });
    expect(out.evidence.pagespeed).toBeNull();
    expect(out.points).toBe(4);
  });

  it("render failed → PageSpeed scaled to 20", async () => {
    const out = await runDesign(ctx(), { pagespeed: async () => psiOk(0.95, 0.95), render: async () => null });
    expect(out.points).toBe(20);
  });

  it("both missing → unavailable", async () => {
    await expectUnavailable(
      runDesign(ctx(), { pagespeed: async () => ({ kind: "not_configured", env_var: "X" }), render: async () => null }),
      "not_measured",
    );
  });

  it("the page's render answer is shaped defensively", () => {
    expect(toRenderResult({ cta_above_fold: true, body_text_px: 999, overlap_pairs: 3, horizontal_scroll: "yes" })).toEqual({
      cta_above_fold: true,
      cta_text: null,
      body_text_px: null,
      overlap_pairs: 3,
      overlapping_boxes: true,
      horizontal_scroll: false,
    });
    expect(toRenderResult(null)).toBeNull();
  });
});

describe("compare", () => {
  const parts: StartCardParts = {
    google: {
      state: "done",
      points: 15,
      evidence: { search_term: "t", locale: "US", results_checked: 100, position: 7, rivals: [{ domain: "pipepros.com", position: 2 }, { domain: "drainkings.com", position: null }] },
      fetched_at: null,
    },
    seo: {
      state: "done",
      points: 17,
      evidence: {
        pages_checked: [],
        title: null,
        meta_description: null,
        h1_count: 1,
        schema_types: [],
        robots_allows_root: true,
        sitemap_found: true,
        broken_links: [],
        rivals: [{ domain: "pipepros.com", points: 3 }, { domain: "drainkings.com", points: null }],
      },
      fetched_at: null,
    },
    ai: { state: "unavailable", evidence: null, unavailable_reason: "vendor_not_configured", fetched_at: null },
  };

  it("sums only checks every ranked site has (seo drops: one rival unreadable)", async () => {
    const out = await runCompare(ctx({ parts }));
    expect(out.evidence.checks_used).toEqual(["google"]);
    expect(out.evidence.ranking.map((r) => [r.domain, r.checks_total, r.rank])).toEqual([
      ["pipepros.com", 20, 1],
      ["acmeplumbing.com", 15, 2],
      ["drainkings.com", 0, 3],
    ]);
    expect(out.points).toBe(10);
    expect(out.evidence.note).toBe("#2 of 3 against your competitors on Google.");
  });

  it("no rival with a site → unavailable", async () => {
    await expectUnavailable(
      runCompare(ctx({ parts, profile: { ...profile, rivals: [profile.rivals[2]] } })),
      "no_rival_with_site",
    );
  });

  it("no check measured for everyone → unavailable", async () => {
    await expectUnavailable(runCompare(ctx({ parts: { ai: parts.ai } })), "no_shared_checks");
  });
});
