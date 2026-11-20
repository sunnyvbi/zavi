import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool, takeApifyCall } from "../apify";
import { smartTruncateToolResult, toolResultCapBytes } from "@/services/agents/smart-truncate";

const TENANT = "00000000-0000-0000-0000-000000000000";

async function call(args: Record<string, unknown>): Promise<any> {
  const r = await callApifyTool(TENANT, "scrape_pinterest", args);
  return { ...r, parsed: JSON.parse(r.content) };
}

const SEARCH_PIN = {
  type: "pin",
  url: "https://www.pinterest.com/pin/9077636743258272/",
  description: "Linen maxi dress with covered buttons and a V-neck.",
  isVideo: false,
  saves: 6,
  comments: 0,
  createdAt: "Wed, 17 Jul 2024 01:32:10 +0000",
  pinner: { username: "WolvesbutWomen", followerCount: 1270 },
  board: { name: "Looks I Love!" },
  link: "https://www.linennaive.com/products/maxi-linen-dress",
  domain: "linennaive.com",
};
const TREND = {
  term: "rio hoco dress",
  rank: 2,
  weeklyChange: -0.04,
  monthlyChange: 7,
  yearlyChange: 6,
  seasonalityScore: 0.415,
};

describe("scrape_pinterest", () => {
  const realFetch = global.fetch;
  let bodies: any[] = [];
  let actors: string[] = [];
  function respond(items: unknown[]) {
    global.fetch = vi.fn(async (url: string, init: RequestInit) => {
      actors.push(String(url).split("/acts/")[1].split("/")[0]);
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(items), { status: 200 });
    }) as never;
  }
  beforeEach(() => {
    process.env.APIFY_TOKEN = "test-token";
    bodies = [];
    actors = [];
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("search: maps saves, domain and pinner, with a per-query summary first", async () => {
    respond([
      SEARCH_PIN,
      { ...SEARCH_PIN, saves: 20, domain: "other.example" },
      { ...SEARCH_PIN, saves: 2 },
      { ...SEARCH_PIN, saves: 0, domain: "Uploaded by user", link: null },
    ]);
    const r = await call({ mode: "search", queries: ["linen dress"] });
    expect(r.ok).toBe(true);
    expect(actors[0]).toBe("silentflow~pinterest-scraper-ppr");
    expect(bodies[0]).toMatchObject({ search: "linen dress", maxItems: 15 });
    const s = r.parsed.summaries[0];
    expect(s).toMatchObject({ query: "linen dress", pins_read: 4, median_saves: 4, max_saves: 20 });
    expect(s.winning_domains).toEqual({ "linennaive.com": 2, "other.example": 1 });
    expect(r.parsed.results[0].pins[0]).toMatchObject({
      saves: 6,
      domain: "linennaive.com",
      pinner: "WolvesbutWomen",
      pinner_followers: 1270,
      created_at: "2024-07-17",
      board: "Looks I Love!",
    });
  });

  it("search: an empty result is loud, never 'nobody pins this'", async () => {
    respond([]);
    const r = await call({ mode: "search", queries: ["zzz"] });
    expect(r.ok).toBe(false);
    expect(r.parsed.error).toBe("tool_no_data");
  });

  it("trends: maps change and seasonality from the trends actor", async () => {
    respond([TREND]);
    const r = await call({ mode: "trends", queries: ["dress"], trend_type: "growing" });
    expect(actors[0]).toBe("automation-lab~pinterest-trends-scraper");
    expect(bodies[0]).toMatchObject({ countries: ["US"], trendTypes: ["growing"], keywordsToInclude: ["dress"] });
    expect(r.parsed.terms[0]).toMatchObject({ term: "rio hoco dress", monthly_change: 7, seasonality: 0.415 });
  });

  it("trends: the actor's FAILED run is reported as NOT RUN, never a dispatch failure or a zero-demand claim", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: "run-failed", message: "Actor run did not succeed (run ID: x, status: FAILED)." } }), { status: 400 }),
    ) as never;
    const r = await call({ mode: "trends", queries: ["car rental"], trend_type: "seasonal" });
    expect(r.ok).toBe(false);
    expect(r.parsed.error).toBe("pinterest_trends_unavailable");
    expect(r.parsed.message).toMatch(/NOT RUN/);
  });

  it("a three-query search at the default size keeps its summaries under the cap", () => {
    const pins = Array.from({ length: 15 }, (_, i) => ({ ...SEARCH_PIN, saves: i, description: "d".repeat(240) }));
    const payload = {
      source: "pinterest_search_public",
      summaries: [1, 2, 3].map((q) => ({ query: `q${q}`, pins_read: 15, median_saves: 7, max_saves: 14, video_pins: 0, winning_domains: {} })),
      results: [1, 2, 3].map((q) => ({ query: `q${q}`, pins })),
      bounds: "x",
    };
    const cap = toolResultCapBytes("apify", "scrape_pinterest");
    expect(cap).toBe(32 * 1024);
    expect(smartTruncateToolResult(JSON.stringify(payload), cap)).toContain("median_saves");
  });
});

describe("scrape_pinterest per-run cap", () => {
  it("allows 4 paid calls per run, then refuses; other runs and tools are unaffected", () => {
    const run = "run-cap-test";
    for (let i = 0; i < 4; i++) expect(takeApifyCall(run, "scrape_pinterest")).toBe(true);
    expect(takeApifyCall(run, "scrape_pinterest")).toBe(false);
    expect(takeApifyCall("another-run", "scrape_pinterest")).toBe(true);
    expect(takeApifyCall(run, "scrape_tiktok")).toBe(true);
    expect(takeApifyCall(undefined, "scrape_pinterest")).toBe(true);
  });
});
