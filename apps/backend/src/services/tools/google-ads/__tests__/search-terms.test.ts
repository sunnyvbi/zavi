import { describe, it, expect, vi, beforeEach } from "vitest";

const gadsSearch = vi.fn();
vi.mock("../_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));

import { searchTermsTool } from "../search_terms";

const ctx = { tenant_id: "t-1" } as never;

const selectedFields = (query: string) =>
  query
    .slice(query.indexOf("SELECT") + 6, query.indexOf("FROM"))
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

const fromResource = (query: string) =>
  query.slice(query.indexOf("FROM") + 4).trim().split(/\s+/)[0];

function queryFor(resource: string): string | undefined {
  for (const call of gadsSearch.mock.calls) {
    const q = (call as [string, string])[1];
    if (fromResource(q) === resource) return q;
  }
  return undefined;
}

function spineRow(o: {
  term: string;
  campaign_id?: string;
  name?: string;
  type?: string;
  cost?: number;
  clicks?: number;
  conv?: number;
  allConv?: number;
  value?: number;
}) {
  return {
    campaignSearchTermView: { searchTerm: o.term },
    campaign: {
      id: o.campaign_id ?? "1",
      name: o.name ?? "Search - Brand",
      advertisingChannelType: o.type ?? "SEARCH",
    },
    metrics: {
      costMicros: String(Math.round((o.cost ?? 0) * 1_000_000)),
      clicks: String(o.clicks ?? 0),
      impressions: "0",
      conversions: String(o.conv ?? 0),
      allConversions: String(o.allConv ?? o.conv ?? 0),
      conversionsValue: String(o.value ?? 0),
    },
  };
}

function enrichRow(o: { term: string; campaign_id?: string; keyword: string; match?: string }) {
  return {
    searchTermView: { searchTerm: o.term, status: "ADDED" },
    campaign: { id: o.campaign_id ?? "1" },
    adGroup: { name: "AG 1" },
    segments: {
      keyword: { info: { text: o.keyword, matchType: o.match ?? "BROAD" } },
      searchTermMatchType: "NEAR_EXACT",
    },
  };
}

function mockByResource(map: {
  spine?: unknown[];
  enrich?: unknown[];
  currency?: string | null;
  enrichError?: Error;
}) {
  gadsSearch.mockImplementation(async (_tenant: string, query: string) => {
    const res = fromResource(query);
    if (res === "campaign_search_term_view") return map.spine ?? [];
    if (res === "search_term_view") {
      if (map.enrichError) throw map.enrichError;
      return map.enrich ?? [];
    }
    if (res === "customer") {
      return map.currency ? [{ customer: { currencyCode: map.currency } }] : [];
    }
    return [];
  });
}

beforeEach(() => {
  gadsSearch.mockReset().mockResolvedValue([]);
});

describe("google_ads_search_terms — query shape", () => {
  it("SPINE selects NO keyword segment, because that would silently drop every Performance Max row", async () => {
    await searchTermsTool.execute(ctx, {});
    const spine = queryFor("campaign_search_term_view");
    expect(spine).toBeDefined();

    const fields = selectedFields(spine!);
    expect(fields.some((f) => f.startsWith("segments.keyword"))).toBe(false);
    expect(fields).toContain("campaign_search_term_view.search_term");
    expect(fields).toContain("campaign.advertising_channel_type");
  });

  it("ENRICHMENT uses the ad-group-grain resource and IS where keyword segments belong", async () => {
    await searchTermsTool.execute(ctx, {});
    const enrich = queryFor("search_term_view");
    expect(enrich).toBeDefined();

    const fields = selectedFields(enrich!);
    expect(fields).toContain("segments.keyword.info.text");
    expect(fields).toContain("segments.keyword.info.match_type");
  });

  it("skip_keyword_enrichment issues no ad-group-grain query at all", async () => {
    await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true });
    expect(queryFor("campaign_search_term_view")).toBeDefined();
    expect(queryFor("search_term_view")).toBeUndefined();
  });

  it("never selects search_term_view.keyword — the matched keyword is a SEGMENT, not a resource field", async () => {
    await searchTermsTool.execute(ctx, {});
    for (const call of gadsSearch.mock.calls) {
      const query = (call as [string, string])[1];
      expect(selectedFields(query)).not.toContain("search_term_view.keyword");
    }
  });
});

describe("google_ads_search_terms — deterministic aggregates", () => {
  it("computes wasted spend as cost on zero-conversion terms", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "buy widgets", cost: 100, conv: 2 }),
        spineRow({ term: "widget jobs", cost: 40, conv: 0, clicks: 20 }),
        spineRow({ term: "free widgets", cost: 35, conv: 0, clicks: 15 }),
        spineRow({ term: "widget meaning", cost: 0, conv: 0 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      zero_conversion: { cost: number; term_count: number; clicks: number };
      totals: { cost: number; conversions: number };
    };

    expect(out.zero_conversion.cost).toBe(75);
    expect(out.zero_conversion.term_count).toBe(2);
    expect(out.zero_conversion.clicks).toBe(35);
    expect(out.totals.cost).toBe(175);
    expect(out.totals.conversions).toBe(2);
  });

  it("a term with 0 conversions but 3 all_conversions stays in zero-conversion and waste, flagged", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "signup term", cost: 60, conv: 0, allConv: 3 }),
        spineRow({ term: "dead term", cost: 25, conv: 0, allConv: 0 }),
        spineRow({ term: "buyer term", cost: 40, conv: 1, allConv: 1 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      zero_conversion: { cost: number; term_count: number };
      waste?: { lines: Array<{ label: string }>; spend_total: number; secondary_total?: number };
      totals: { conversions: number; all_conversions: number };
      conversion_columns: string;
    };
    expect(out.zero_conversion.term_count).toBe(2);
    expect(out.zero_conversion.cost).toBe(85);
    expect(out.waste?.lines.map((l) => l.label)).toEqual(["signup term", "dead term"]);
    expect(out.waste?.secondary_total).toBe(1);
    expect(out.totals.conversions).toBe(1);
    expect(out.totals.all_conversions).toBe(4);
    expect(out.conversion_columns).toContain("all_conversions");
  });

  it("SPINE selects all_conversions, verified selectable on campaign_search_term_view in v25", async () => {
    await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true });
    expect(selectedFields(queryFor("campaign_search_term_view")!)).toContain("metrics.all_conversions");
  });

  it("counts waste that falls BELOW the 120-row sample cutoff", async () => {
    const rows = [];
    for (let i = 0; i < 130; i++) {
      rows.push(spineRow({ term: `converting ${i}`, cost: 10, conv: 1 }));
    }
    rows.push(spineRow({ term: "expensive junk", cost: 500, conv: 0, clicks: 99 }));
    mockByResource({ spine: rows });

    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      zero_conversion: { cost: number; term_count: number };
      totals: { terms: number };
      terms_sample: unknown[];
    };

    expect(out.totals.terms).toBe(131);
    expect(out.terms_sample).toHaveLength(120);
    expect(out.zero_conversion.term_count).toBe(1);
    expect(out.zero_conversion.cost).toBe(500);
  });

  it("sums unrounded values and rounds once — round-then-sum would drift", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "a", cost: 0.005, conv: 0 }),
        spineRow({ term: "b", cost: 0.005, conv: 0 }),
        spineRow({ term: "c", cost: 0.005, conv: 0 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      totals: { cost: number };
    };
    expect(out.totals.cost).toBe(0.02);
    expect(out.totals.cost).not.toBe(0.03);
  });

  it("brand split matches whole words only — 'ace' must not classify 'space heater' as brand", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "ace rentals", cost: 50, conv: 5 }),
        spineRow({ term: "space heater", cost: 30, conv: 0 }),
        spineRow({ term: "replacement parts", cost: 20, conv: 1 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, {
      brand_terms: ["ace"],
      skip_keyword_enrichment: true,
    })) as {
      brand_split: {
        brand: { cost: number; terms: number };
        non_brand: { cost: number; terms: number };
      };
    };

    expect(out.brand_split.brand.terms).toBe(1);
    expect(out.brand_split.brand.cost).toBe(50);
    expect(out.brand_split.non_brand.terms).toBe(2);
    expect(out.brand_split.non_brand.cost).toBe(50);
  });

  it("brand split is null — never zero — when no brand tokens were supplied", async () => {
    mockByResource({ spine: [spineRow({ term: "widgets", cost: 10, conv: 1 })] });
    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      brand_split: unknown;
    };
    expect(out.brand_split).toBeNull();
  });

  it("a multi-word brand token matches as a phrase, not as loose words", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "acme rentals near me", cost: 10, conv: 1 }),
        spineRow({ term: "rentals acme city", cost: 10, conv: 1 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, {
      brand_terms: ["acme rentals"],
      skip_keyword_enrichment: true,
    })) as { brand_split: { brand: { terms: number } } };
    expect(out.brand_split.brand.terms).toBe(1);
  });

  it("counts an n-gram once per search term even when the word repeats in it", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "widget widget widget", cost: 30, conv: 0 }),
        spineRow({ term: "widget parts", cost: 10, conv: 0 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      ngrams: { one_gram: Array<{ gram: string; terms: number; cost: number }> };
    };
    const widget = out.ngrams.one_gram.find((g) => g.gram === "widget");
    expect(widget).toBeDefined();
    expect(widget?.terms).toBe(2);
    expect(widget?.cost).toBe(40);
  });

  it("splits spend by campaign type so a PMax-dominated account is visible as one", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "a", cost: 800, conv: 4, type: "PERFORMANCE_MAX", campaign_id: "9" }),
        spineRow({ term: "b", cost: 200, conv: 2, type: "SEARCH", campaign_id: "1" }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      by_campaign_type: Array<{ channel_type: string; cost: number }>;
    };
    expect(out.by_campaign_type[0]).toMatchObject({
      channel_type: "PERFORMANCE_MAX",
      cost: 800,
    });
  });
});

describe("google_ads_search_terms — currency is the account's, not USD", () => {
  it("reports the account currency code", async () => {
    mockByResource({ spine: [spineRow({ term: "a", cost: 10, conv: 1 })], currency: "EUR" });
    const out = (await searchTermsTool.execute(ctx, {})) as {
      currency_code: string | null;
      currency_note: string;
    };
    expect(out.currency_code).toBe("EUR");
    expect(out.currency_note).toContain("EUR");
  });

  it("warns explicitly rather than assuming USD when the currency cannot be read", async () => {
    mockByResource({ spine: [spineRow({ term: "a", cost: 10, conv: 1 })], currency: null });
    const out = (await searchTermsTool.execute(ctx, {})) as {
      currency_code: string | null;
      currency_note: string;
    };
    expect(out.currency_code).toBeNull();
    expect(out.currency_note).toContain("do NOT write a dollar sign");
  });
});

describe("google_ads_search_terms — enrichment join", () => {
  it("attaches the matched keyword to Search rows and leaves PMax rows null", async () => {
    mockByResource({
      spine: [
        spineRow({ term: "buy widgets", campaign_id: "1", type: "SEARCH" }),
        spineRow({ term: "widget deals", campaign_id: "9", type: "PERFORMANCE_MAX" }),
      ],
      enrich: [enrichRow({ term: "buy widgets", campaign_id: "1", keyword: "widgets" })],
      currency: "USD",
    });

    const out = (await searchTermsTool.execute(ctx, {})) as {
      terms_sample: Array<{ search_term: string; matched_keyword: string | null }>;
      enrichment: { status: string; enriched_rows: number };
    };

    const search = out.terms_sample.find((t) => t.search_term === "buy widgets");
    const pmax = out.terms_sample.find((t) => t.search_term === "widget deals");
    expect(search?.matched_keyword).toBe("widgets");
    expect(pmax?.matched_keyword).toBeNull();
    expect(out.enrichment.enriched_rows).toBe(1);
  });

  it("does not join a term across campaigns — same query, different campaign, stays unenriched", async () => {
    mockByResource({
      spine: [spineRow({ term: "buy widgets", campaign_id: "2" })],
      enrich: [enrichRow({ term: "buy widgets", campaign_id: "1", keyword: "widgets" })],
    });
    const out = (await searchTermsTool.execute(ctx, {})) as {
      terms_sample: Array<{ matched_keyword: string | null }>;
    };
    expect(out.terms_sample[0].matched_keyword).toBeNull();
  });

  it("counts how many ad groups served a term rather than silently keeping one", async () => {
    mockByResource({
      spine: [spineRow({ term: "buy widgets", campaign_id: "1" })],
      enrich: [
        enrichRow({ term: "buy widgets", campaign_id: "1", keyword: "widgets" }),
        enrichRow({ term: "buy widgets", campaign_id: "1", keyword: "buy widgets" }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, {})) as {
      terms_sample: Array<{ ad_groups_matched: number | null; matched_keyword: string | null }>;
    };
    expect(out.terms_sample[0].ad_groups_matched).toBe(2);
    expect(out.terms_sample[0].matched_keyword).toBe("widgets");
  });

  it("survives an enrichment failure with every aggregate intact", async () => {
    mockByResource({
      spine: [spineRow({ term: "widget jobs", cost: 40, conv: 0 })],
      enrichError: new Error("google_ads_query_failed: 400"),
    });

    const out = (await searchTermsTool.execute(ctx, {})) as {
      enrichment: { status: string };
      zero_conversion: { cost: number };
    };
    expect(out.enrichment.status).toContain("unavailable");
    expect(out.zero_conversion.cost).toBe(40);
  });
});

describe("google_ads_search_terms — per-keyword view", () => {
  function kwRow(o: { term: string; keyword: string; criterion: string; ag?: string; cost: number; clicks: number; impr: number; conv?: number; allConv?: number }) {
    return {
      searchTermView: { searchTerm: o.term, status: "NONE" },
      campaign: { id: "1" },
      adGroup: { id: o.ag ?? "7", name: "AG 7" },
      segments: {
        keyword: { adGroupCriterion: `customers/1/adGroupCriteria/${o.ag ?? "7"}~${o.criterion}`, info: { text: o.keyword, matchType: "BROAD" } },
        searchTermMatchType: "BROAD",
      },
      metrics: {
        costMicros: String(Math.round(o.cost * 1_000_000)),
        clicks: String(o.clicks),
        impressions: String(o.impr),
        conversions: String(o.conv ?? 0),
        allConversions: String(o.allConv ?? o.conv ?? 0),
      },
    };
  }

  type KW = { keyword: string; criterion_id: string | null; cost: number; clicks: number; ctr: number | null; cpc: number | null; conversions: number; all_conversions: number; top_terms: Array<{ term: string; cost: number }> };

  it("selects the per-keyword metrics on the ad-group-grain read", async () => {
    await searchTermsTool.execute(ctx, {});
    const fields = selectedFields(queryFor("search_term_view")!);
    for (const f of ["metrics.clicks", "metrics.impressions", "metrics.conversions", "metrics.all_conversions", "ad_group.id", "segments.keyword.ad_group_criterion"]) {
      expect(fields).toContain(f);
    }
  });

  it("rolls rows up per keyword, cost-ranked, with rates and the costliest three terms", async () => {
    mockByResource({
      enrich: [
        kwRow({ term: "cheap widgets", keyword: "widgets", criterion: "11", cost: 30, clicks: 10, impr: 200 }),
        kwRow({ term: "widgets near me", keyword: "widgets", criterion: "11", cost: 20, clicks: 10, impr: 300, allConv: 2 }),
        kwRow({ term: "free widgets", keyword: "widgets", criterion: "11", cost: 5, clicks: 5, impr: 100 }),
        kwRow({ term: "widget repair", keyword: "widgets", criterion: "11", cost: 1, clicks: 1, impr: 50 }),
        kwRow({ term: "buy gadget", keyword: "gadget", criterion: "22", cost: 80, clicks: 0, impr: 0, conv: 1 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, {})) as { by_keyword: KW[] };
    expect(out.by_keyword.map((k) => k.keyword)).toEqual(["gadget", "widgets"]);
    const w = out.by_keyword[1];
    expect(w).toMatchObject({ criterion_id: "11", cost: 56, clicks: 26, conversions: 0, all_conversions: 2 });
    expect(w.ctr).toBe(0.0400);
    expect(w.cpc).toBe(2.15);
    expect(w.top_terms.map((t) => t.term)).toEqual(["cheap widgets", "widgets near me", "free widgets"]);
    expect(out.by_keyword[0]).toMatchObject({ ctr: null, cpc: null });
  });

  it("caps the view at 40 keywords", async () => {
    mockByResource({
      enrich: Array.from({ length: 55 }, (_, i) => kwRow({ term: `t${i}`, keyword: `k${i}`, criterion: String(i), cost: i + 1, clicks: 1, impr: 10 })),
    });
    const out = (await searchTermsTool.execute(ctx, {})) as { by_keyword: KW[] };
    expect(out.by_keyword).toHaveLength(40);
    expect(out.by_keyword[0].keyword).toBe("k54");
  });

  it("is null, not empty, when the keyword read failed or was skipped", async () => {
    mockByResource({ spine: [spineRow({ term: "x", cost: 5 })], enrichError: new Error("boom") });
    expect(((await searchTermsTool.execute(ctx, {})) as { by_keyword: unknown }).by_keyword).toBeNull();
    expect(((await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as { by_keyword: unknown }).by_keyword).toBeNull();
  });

  it("scopes the keyword read to ad_group_id and leaves the campaign-grain spine unscoped", async () => {
    await searchTermsTool.execute(ctx, { ad_group_id: "7" });
    expect(queryFor("search_term_view")).toContain("ad_group.id = 7");
    expect(queryFor("campaign_search_term_view")).not.toContain("ad_group.id");
  });

  it("derives per-term ctr and cpc, null on zero denominators", async () => {
    mockByResource({
      spine: [
        { ...spineRow({ term: "a", cost: 10, clicks: 4 }), metrics: { costMicros: "10000000", clicks: "4", impressions: "100", conversions: "0", allConversions: "0" } },
        spineRow({ term: "b", cost: 3, clicks: 0 }),
      ],
    });
    const out = (await searchTermsTool.execute(ctx, { skip_keyword_enrichment: true })) as {
      terms_sample: Array<{ search_term: string; ctr: number | null; cpc: number | null }>;
    };
    expect(out.terms_sample.find((t) => t.search_term === "a")).toMatchObject({ ctr: 0.04, cpc: 2.5 });
    expect(out.terms_sample.find((t) => t.search_term === "b")).toMatchObject({ ctr: null, cpc: null });
  });
});
