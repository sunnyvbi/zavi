
import { describe, it, expect, vi, afterEach } from "vitest";
import type { StartCardProfileEvidence } from "@zavi/shared";
import type { SerpAnswer } from "@/services/channels/reddit/google-rank";
import type { StageContext } from "../checks/contract";
import { runGoogle, positionOf, topDomains } from "../checks/google";
import {
  brandKeys,
  candidateTerms,
  fetchRankedTerms,
  parseRankedItems,
  pickBuyerTerm,
  type RankedAnswer,
  type RankedTerm,
} from "../checks/ranked-terms";
import { googlePoints } from "../checks/points";
import { MODEL_CALL_EST_USD, RANKED_KEYWORDS_EST_USD } from "../checks/costs";
import { composeFounderResult } from "../site-check-result";

const profile: StartCardProfileEvidence = {
  company_name: "Vercel",
  category: "frontend cloud platform",
  description: "Vercel is a cloud platform for deploying and hosting frontend web apps.",
  search_term: "app deployment platform",
  country: "US",
  country_from: "default_us",
  country_label: "United States",
  city: null,
  rivals: [{ name: "Render", domain: "render.com", no_site: false, source_url: null }],
};

const ctx = (over: Partial<StageContext> = {}): StageContext => ({
  card_id: "c1",
  domain: "vercel.com",
  url: "https://vercel.com/",
  profile,
  parts: {},
  ...over,
});

const t = (term: string, position: number, volume: number): RankedTerm => ({ term, position, volume });

const RANKED: RankedTerm[] = [
  t("supabase", 5, 301000),
  t("vercel", 1, 246000),
  t("mistral", 8, 201000),
  t("shadcn", 3, 110000),
  t("vercel app", 1, 49500),
  t("cron job", 6, 40500),
  t("vercel login", 1, 33100),
  t("404 page", 4, 18100),
  t("what is vercel", 1, 9900),
  t("next.js hosting", 1, 1600),
  t("frontend cloud platform", 1, 480),
];

const rankedOk: RankedAnswer = { ok: true, terms: RANKED, cost_usd: 0.017 };

const broadSerp: SerpAnswer = {
  ok: true,
  hits: [],
  organic: [
    { rank: 1, url: "https://render.com/", domain: "render.com" },
    { rank: 2, url: "https://www.g2.com/x", domain: "g2.com" },
    { rank: 100, url: "https://other.com/", domain: "other.com" },
  ],
  cost_usd: 0.002,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ranked buying term", () => {
  it("filters brand + navigational terms, scores the validated pick, and checks the broad term as the gap line", async () => {
    const complete = vi.fn(async (_s: string, _u: string) => '{"term": "frontend cloud platform"}');
    const serp = vi.fn(async () => broadSerp);
    const out = await runGoogle(ctx(), { ranked: async () => rankedOk, complete, serp });

    const user = complete.mock.calls[0][1];
    expect(user).not.toMatch(/"vercel/);
    expect(user).not.toContain("what is vercel");
    expect(user).not.toContain("404 page");
    expect(user).toContain('"next.js hosting"');
    expect(user).toContain('"supabase"');

    expect(out.evidence).toMatchObject({
      search_term: "frontend cloud platform",
      scored_term: "frontend cloud platform",
      term_source: "ranked",
      position: 1,
      broad_term: "app deployment platform",
      broad_position: null,
      broad_results_checked: 100,
      broad_top_domain: "render.com",
      rivals: [],
    });
    expect(out.points).toBe(googlePoints(1));
    expect(serp).toHaveBeenCalledTimes(1);
    expect(serp).toHaveBeenCalledWith("app deployment platform", "US");
    expect(out.evidence.note).toBe(
      "#1 on Google for “frontend cloud platform”. For the broader “app deployment platform” you're not in the top 100 (render.com ranks first).",
    );
    expect(out.cost_usd).toBeCloseTo(0.017 + MODEL_CALL_EST_USD + 0.002, 4);
  });

  it("a gap line where the site does rank for the broad term", async () => {
    const serp = async (): Promise<SerpAnswer> => ({
      ...broadSerp,
      organic: [...broadSerp.organic, { rank: 12, url: "https://vercel.com/x", domain: "vercel.com" }],
    });
    const out = await runGoogle(ctx(), { ranked: async () => rankedOk, complete: async () => '{"term":"next.js hosting"}', serp });
    expect(out.evidence.note).toBe("#1 on Google for “next.js hosting”. For the broader “app deployment platform” you're #12.");
  });

  it("a failed gap SERP still scores the ranked term, without a gap line", async () => {
    const out = await runGoogle(ctx(), {
      ranked: async () => rankedOk,
      complete: async () => '{"term":"next.js hosting"}',
      serp: async () => ({ ok: false, error_code: "dataforseo_timeout", cost_usd: null }),
    });
    expect(out.evidence.term_source).toBe("ranked");
    expect(out.evidence.broad_position).toBeUndefined();
    expect(out.evidence.note).toBe("#1 on Google for “next.js hosting”.");
  });

  it.each([
    ["a term not in the list", '{"term": "best hosting for startups"}'],
    ["NONE", '{"term": null}'],
    ["a filtered brand term", '{"term": "vercel app"}'],
    ["free text", "I would pick hosting."],
  ])("model returns %s → falls back to the profile term", async (_label, reply) => {
    const serp = vi.fn(async () => broadSerp);
    const out = await runGoogle(ctx(), { ranked: async () => rankedOk, complete: async () => reply, serp });
    expect(out.evidence.term_source).toBe("profile");
    expect(out.evidence.search_term).toBe("app deployment platform");
    expect(out.evidence.position).toBeNull();
    expect(out.points).toBe(0);
    expect(out.evidence.rivals).toEqual([{ domain: "render.com", position: 1 }]);
    expect(out.cost_usd).toBeCloseTo(0.017 + MODEL_CALL_EST_USD + 0.002, 4);
  });

  it("a model outage → fallback, stage still done", async () => {
    const out = await runGoogle(ctx(), {
      ranked: async () => rankedOk,
      complete: async () => {
        throw new Error("overloaded");
      },
      serp: async () => broadSerp,
    });
    expect(out.evidence.term_source).toBe("profile");
  });

  it.each([
    ["out of credit", { ok: false, error_code: "dataforseo_http_402", cost_usd: null } as RankedAnswer, 0],
    ["not configured", { ok: false, error_code: "dataforseo_not_configured", cost_usd: null } as RankedAnswer, 0],
    ["a vendor error", { ok: false, error_code: "dataforseo_timeout", cost_usd: null } as RankedAnswer, RANKED_KEYWORDS_EST_USD],
    ["zero results", { ok: true, terms: [], cost_usd: 0.011 } as RankedAnswer, 0.011],
  ])("ranked keywords %s → fallback, no model call, stage done", async (_label, answer, rankedCost) => {
    const complete = vi.fn(async () => '{"term":"x"}');
    const out = await runGoogle(ctx(), { ranked: async () => answer, complete, serp: async () => broadSerp });
    expect(complete).not.toHaveBeenCalled();
    expect(out.evidence.term_source).toBe("profile");
    expect(out.cost_usd).toBeCloseTo(rankedCost + 0.002, 4);
  });

  it("a ranked client that throws → fallback", async () => {
    const out = await runGoogle(ctx(), {
      ranked: async () => {
        throw new Error("boom");
      },
      serp: async () => broadSerp,
    });
    expect(out.evidence.term_source).toBe("profile");
  });

  it("a small site with only brand terms is scored exactly as today", async () => {
    const complete = vi.fn(async () => '{"term":"x"}');
    const small: RankedAnswer = { ok: true, terms: [t("vercel", 1, 10)], cost_usd: 0.011 };
    const out = await runGoogle(ctx(), { ranked: async () => small, complete, serp: async () => broadSerp });
    expect(complete).not.toHaveBeenCalled();
    expect(out.evidence).toMatchObject({ search_term: "app deployment platform", term_source: "profile", position: null });
    expect(out.evidence.note).toBe("Not in the top 100 Google results for “app deployment platform”; render.com ranks first.");
  });

  it("points per rank are googlePoints of the ranked position", async () => {
    for (const pos of [1, 3, 7, 15, 20]) {
      const out = await runGoogle(ctx(), {
        ranked: async () => ({ ok: true, terms: [t("next.js hosting", pos, 100)], cost_usd: 0.017 }),
        complete: async () => '{"term":"next.js hosting"}',
        serp: async () => broadSerp,
      });
      expect(out.points).toBe(googlePoints(pos));
    }
  });
});

describe("ranked-terms helpers", () => {
  it("parseRankedItems reads the Labs shape, keeps the best rank, drops >20 and non-organic", () => {
    const item = (keyword: string, rank: number, volume: number, type = "organic") => ({
      keyword_data: { keyword, keyword_info: { search_volume: volume } },
      ranked_serp_element: { serp_item: { type, rank_group: rank } },
    });
    const out = parseRankedItems({
      items: [
        item("Next.js Hosting", 4, 1600),
        item("next.js hosting", 1, 1600),
        item("far away", 35, 9000),
        item("question box", 2, 5000, "people_also_ask"),
        item("frontend cloud platform", 1, 480),
      ],
    });
    expect(out).toEqual([t("next.js hosting", 1, 1600), t("frontend cloud platform", 1, 480)]);
    expect(parseRankedItems({ items: null })).toEqual([]);
  });

  it("brandKeys: domain label, company name, and its first word when the label starts with it", () => {
    expect(brandKeys("vercel.com", "Vercel")).toEqual(["vercel"]);
    expect(brandKeys("www.acmedental.co.uk", "Acme Dental Care")).toEqual(["acmedental", "acmedentalcare", "acme"]);
    expect(candidateTerms([t("dental implants", 3, 900)], brandKeys("brightsmile.com", "Dental Studio"))).toHaveLength(1);
  });

  it("a two-letter brand is filtered as a whole word only", () => {
    const keys = brandKeys("3m.com", "3M");
    expect(keys).toEqual(["3m"]);
    const out = candidateTerms([t("3m tape", 1, 900), t("3mm drill bit", 2, 500), t("tape for 3m hooks", 3, 100)], keys);
    expect(out.map((x) => x.term)).toEqual(["3mm drill bit"]);
  });

  it("the picker gets the business name to skip", async () => {
    let user = "";
    await pickBuyerTerm({ ...profile, company_name: "3M" }, [t("a b", 1, 1)], async (_s, u) => {
      user = u;
      return "{}";
    });
    expect(user).toContain('name="3M"');
  });

  it("pickBuyerTerm accepts only an exact (case/quote-insensitive) list term", async () => {
    const cands = [t("next.js hosting", 1, 1600)];
    expect(await pickBuyerTerm(profile, cands, async () => '{"term":"“Next.js Hosting”"}')).toEqual(cands[0]);
    expect(await pickBuyerTerm(profile, cands, async () => '{"term":"next.js hosting platform"}')).toBeNull();
    expect(await pickBuyerTerm(profile, [], async () => '{"term":"x"}')).toBeNull();
  });

  it("the relevance prompt names no business or vertical (overfit rule)", async () => {
    let system = "";
    await pickBuyerTerm(profile, [t("a b", 1, 1)], async (s) => {
      system = s;
      return "{}";
    });
    expect(system).not.toMatch(/vercel|upcar|next\.js|hosting|deploy|plumb|dental/i);
  });

  it("fetchRankedTerms posts the measured request shape and parses the result", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "l");
    vi.stubEnv("DATAFORSEO_PASSWORD", "p");
    const fetch = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              cost: 0.0171,
              result: [
                {
                  items: [
                    {
                      keyword_data: { keyword: "next.js hosting", keyword_info: { search_volume: 1600 } },
                      ranked_serp_element: { serp_item: { type: "organic", rank_group: 1 } },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    const out = await fetchRankedTerms("www.vercel.com", "US", { fetch });
    expect(out).toEqual({ ok: true, terms: [t("next.js hosting", 1, 1600)], cost_usd: 0.0171 });
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body).toEqual([
      {
        target: "vercel.com",
        location_code: 2840,
        language_code: "en",
        limit: 100,
        order_by: ["keyword_data.keyword_info.search_volume,desc"],
        filters: [["ranked_serp_element.serp_item.rank_group", "<=", 20]],
      },
    ]);
  });

  it("fetchRankedTerms without keys never calls out", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "");
    const fetch = vi.fn();
    expect(await fetchRankedTerms("vercel.com", "US", { fetch })).toMatchObject({ ok: false, error_code: "dataforseo_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("founder text", () => {
  it("says which search was scored and the broad gap", async () => {
    const out = await runGoogle(ctx(), {
      ranked: async () => rankedOk,
      complete: async () => '{"term":"frontend cloud platform"}',
      serp: async () => broadSerp,
    });
    const text = composeFounderResult({
      domain: "vercel.com",
      public_id: "abc",
      status: "done",
      score: { total: 20, out_of: 20, by_check: { google: 20, ai: null, seo: null, design: null, compare: null } },
      search_term: "app deployment platform",
      parts: { google: { state: "done", evidence: out.evidence, points: 20, max_points: 20, fetched_at: null } },
    });
    expect(text).toContain("#1 on Google for “frontend cloud platform”. For the broader “app deployment platform” you're not in the top 100");
    expect(text).not.toContain("Search term we checked");
  });
});

describe("hosted company identity", () => {
  it("does not score the provider or a sibling as the company", () => {
    const organic = [
      {rank: 1, domain: "netlify.app", url: "https://netlify.app/"},
      {rank: 2, domain: "rival.netlify.app", url: "https://rival.netlify.app/"},
      {rank: 7, domain: "clinic.netlify.app", url: "https://clinic.netlify.app/"},
    ];
    expect(positionOf(organic, "clinic.netlify.app")).toBe(7);
    expect(positionOf(organic.slice(0, 2), "clinic.netlify.app")).toBeNull();
    expect(positionOf([{rank: 3, domain: "netlify.app", url: "https://www.netlify.app/"}], "www.netlify.app")).toBe(3);
    expect(topDomains(organic)).toEqual(["netlify.app", "rival.netlify.app", "clinic.netlify.app"]);
    expect(brandKeys("clinic.netlify.app", "Example Clinic")).toContain("clinic");
    expect(brandKeys("clinic.netlify.app", "Example Clinic")).not.toContain("netlify");
  });
  it("asks ranked keywords for the hosted company, not the provider", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
    const fetch = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}"));
    await fetchRankedTerms("clinic.netlify.app", "US", {fetch});
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))[0].target).toBe("clinic.netlify.app");
  });
});
