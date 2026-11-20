import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const rows: Array<Record<string, unknown>> = [];
const apifyUrls: string[] = [];
let respond: (url: string) => unknown = () => [];

beforeEach(async () => {
  process.env.APIFY_TOKEN = "test-token";
  process.env.TAVILY_API_KEY = "test-key";
  delete process.env.APIFY_RAG_MEMORY_MB;
  rows.length = 0;
  apifyUrls.length = 0;
  respond = () => [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("api.apify.com")) apifyUrls.push(u);
      if (u.includes("api.apify.com") || u.includes("api.tavily.com")) {
        return new Response(JSON.stringify(respond(u)), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 200, headers: { "content-type": "text/html" } });
    }),
  );
  const usage = await import("../usage");
  usage.__setVendorUsageWriterForTests(async (r) => {
    rows.push(r);
  });
  const { resetUnreachableForTest } = await import("@/services/mcp/internal/apify");
  resetUnreachableForTest();
});

const RUN = "11111111-2222-4333-8444-555555555555";
const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const page = (bytes: number) => [{ markdown: "x".repeat(bytes), crawl: { httpStatusCode: 200 }, metadata: { url: "u" } }];

describe("what a tool call records", () => {
  it("records a page read against the tenant and the run, with the memory it asked for", async () => {
    respond = () => page(500);
    const { callApifyTool } = await import("@/services/mcp/internal/apify");
    await callApifyTool(TENANT, "rag_web_browser", { url: "https://example.com/a" }, RUN);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT,
      agent_run_id: RUN,
      source: "run",
      vendor: "apify",
      workload: "apify/rag-web-browser",
      units: 1,
      memory_mb: 4096,
    });
    expect(rows[0].usd_est as number).toBeGreaterThan(0);
    expect(rows[0].usd).toBeNull();
  });

  it("records both paid runs when a blocked page retries on the residential proxy", async () => {
    let n = 0;
    respond = () => (n++ === 0 ? [{ markdown: "", crawl: { httpStatusCode: 503 }, metadata: { url: "u" } }] : page(400));
    const { callApifyTool } = await import("@/services/mcp/internal/apify");
    await callApifyTool(TENANT, "rag_web_browser", { url: "https://g2.com/x" }, RUN);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows.filter((r) => r.vendor === "apify")).toHaveLength(2);
  });

  it("keeps the source a caller set (the reddit sweep) instead of guessing", async () => {
    const { callApifyTool } = await import("@/services/mcp/internal/apify");
    const { withVendorContext } = await import("../usage");
    await withVendorContext({ tenant_id: TENANT, source: "reddit_sweep" }, () =>
      callApifyTool(TENANT, "scrape_reddit", { mode: "search_posts", query: "best crm" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(rows[0]).toMatchObject({ source: "reddit_sweep", tenant_id: TENANT, agent_run_id: null });
  });

  it("charges a Tavily call to the caller's tenant even inside another context", async () => {
    respond = () => ({ results: [] });
    const { callWebSearchTool } = await import("@/services/mcp/internal/web-search");
    const { withVendorContext } = await import("../usage");
    await withVendorContext({ tenant_id: null, source: "onboarding" }, () =>
      callWebSearchTool(TENANT, "search", { query: "crm" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(rows[0]).toMatchObject({ tenant_id: TENANT, source: "onboarding" });
  });

  it("records a Tavily search with its credit price and the run it ran in", async () => {
    respond = () => ({ results: [{ title: "t", url: "https://a.com", content: "c" }] });
    const { callWebSearchTool } = await import("@/services/mcp/internal/web-search");
    await callWebSearchTool(TENANT, "search", { query: "crm pricing", search_depth: "advanced" }, RUN);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows[0]).toMatchObject({ vendor: "tavily", workload: "search_advanced", agent_run_id: RUN, usd: 0.016 });
  });

  it("never lets a failed write break the call it records", async () => {
    const usage = await import("../usage");
    usage.__setVendorUsageWriterForTests(async () => {
      throw new Error("db down");
    });
    respond = () => page(500);
    const { callApifyTool } = await import("@/services/mcp/internal/apify");
    const r = (await callApifyTool(TENANT, "rag_web_browser", { url: "https://example.com/b" }, RUN)) as {
      is_error: boolean;
    };
    expect(r.is_error).toBe(false);
  });
});

describe("loop guards", () => {
  it("stops the 31st page read in one run before it reaches Apify", async () => {
    respond = () => page(500);
    const { callApifyTool } = await import("@/services/mcp/internal/apify");
    let last: { content: string } | undefined;
    for (let i = 0; i < 31; i++) {
      last = (await callApifyTool(TENANT, "rag_web_browser", { url: `https://example.com/p${i}` }, "run-loop")) as {
        content: string;
      };
    }
    expect(apifyUrls).toHaveLength(30);
    expect(last?.content).toContain("apify_run_budget_spent");
  });

  it("stops the 9th TikTok scrape in one run, and another run is untouched", async () => {
    const { callApifyTool } = await import("@/services/mcp/internal/apify");
    for (let i = 0; i < 9; i++) {
      await callApifyTool(TENANT, "scrape_tiktok", { hashtag: `h${i}` }, "run-tt");
    }
    expect(apifyUrls).toHaveLength(8);
    await callApifyTool(TENANT, "scrape_tiktok", { hashtag: "other" }, "run-tt-2");
    expect(apifyUrls).toHaveLength(9);
  });
});

describe("Apify estimates", () => {
  it("prices a longer, bigger run above a short one on the same actor", async () => {
    const { estimateApifyUsd } = await import("../usage");
    const short = estimateApifyUsd({ actor: "apify~rag-web-browser", ms: 10_000, memoryMb: 4096, items: 1 });
    const long = estimateApifyUsd({ actor: "apify~rag-web-browser", ms: 40_000, memoryMb: 8192, items: 1 });
    const search = estimateApifyUsd({ actor: "apify~rag-web-browser", ms: 10_000, memoryMb: 4096, items: 6, search: true });
    expect(long).toBeGreaterThan(short);
    expect(search).toBeGreaterThan(short);
  });
});

describe("daily reconcile", () => {
  const day = "2026-10-13";
  function fakeApify(runs: Array<{ actId: string; startedAt: string; usageTotalUsd: number }>) {
    const acts: Record<string, { username: string; name: string }> = {
      A1: { username: "apify", name: "rag-web-browser" },
      R1: { username: "harshmaur", name: "reddit-scraper-pro" },
      X1: { username: "someone", name: "console-only" },
    };
    return vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/actor-runs")) {
        const offset = Number(u.searchParams.get("offset"));
        const limit = Number(u.searchParams.get("limit"));
        return new Response(JSON.stringify({ data: { items: runs.slice(offset, offset + limit) } }));
      }
      const id = u.pathname.split("/").pop() as string;
      return new Response(JSON.stringify({ data: acts[id] }));
    });
  }

  it("sums only that UTC day's runs per actor, and books recorded-but-unbilled actors at $0", async () => {
    const { reconcileApifyDay } = await import("../reconcile");
    const calls: Array<[string, number]> = [];
    const res = await reconcileApifyDay(day, {
      token: "t",
      fetchFn: fakeApify([
        { actId: "A1", startedAt: "2026-10-14T00:00:01.000Z", usageTotalUsd: 9 },
        { actId: "A1", startedAt: "2026-10-13T20:00:00.000Z", usageTotalUsd: 0.5 },
        { actId: "A1", startedAt: "2026-10-13T01:00:00.000Z", usageTotalUsd: 0.25 },
        { actId: "X1", startedAt: "2026-10-13T02:00:00.000Z", usageTotalUsd: 0.1 },
        { actId: "R1", startedAt: "2026-10-12T23:59:59.000Z", usageTotalUsd: 7 },
      ]),
      recordedActors: async () => ["apify/rag-web-browser", "clockworks/tiktok-scraper"],
      reconcile: async (_d, w, usd) => {
        calls.push([w, usd]);
        return "ok";
      },
    });
    expect(Object.fromEntries(calls)).toEqual({
      "apify/rag-web-browser": 0.75,
      "someone/console-only": 0.1,
      "clockworks/tiktok-scraper": 0,
    });
    expect(res.real_usd).toBe(0.85);
  });

  it("fails the day instead of booking spend under an unknown actor when a name lookup fails", async () => {
    const { reconcileApifyDay } = await import("../reconcile");
    const fetchFn = vi.fn(async (url: string) =>
      String(url).includes("/actor-runs")
        ? new Response(JSON.stringify({ data: { items: [{ actId: "A1", startedAt: `${day}T05:00:00.000Z`, usageTotalUsd: 1 }] } }))
        : new Response("nope", { status: 500 }),
    );
    const reconcile = vi.fn(async () => "ok");
    await expect(
      reconcileApifyDay(day, { token: "t", fetchFn, recordedActors: async () => ["apify/rag-web-browser"], reconcile }),
    ).rejects.toThrow();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("Apify limit alert", () => {
  function limits(used: number, start = "2026-10-13T00:00:00.000Z") {
    return vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { monthlyUsageCycle: { startAt: start }, limits: { maxMonthlyUsageUsd: 100 }, current: { monthlyUsageUsd: used } },
          }),
        ),
    );
  }

  it("pages once at 50% and once at 80% per billing cycle", async () => {
    const { checkApifyUsage } = await import("../reconcile");
    const claimed = new Set<string>();
    const claim = async (k: string) => (claimed.has(k) ? false : (claimed.add(k), true));
    const page = vi.fn(async () => {});
    const d = (used: number, start?: string) => ({ token: "t", fetchFn: limits(used, start), page, claim });
    expect(await checkApifyUsage(d(30))).toEqual([]);
    expect(await checkApifyUsage(d(55))).toEqual([0.5]);
    expect(await checkApifyUsage(d(60))).toEqual([]);
    expect(await checkApifyUsage(d(85))).toEqual([0.8]);
    expect(await checkApifyUsage(d(60, "2026-11-12T00:00:00.000Z"))).toEqual([0.5]);
    expect(page).toHaveBeenCalledTimes(3);
  });

  it("releases the claim when the page fails, so the next run pages again", async () => {
    const { checkApifyUsage } = await import("../reconcile");
    const claimed = new Set<string>();
    const claim = async (k: string) => (claimed.has(k) ? false : (claimed.add(k), true));
    const release = async (k: string) => {
      claimed.delete(k);
    };
    const failing = vi.fn(async () => {
      throw new Error("sendgrid down");
    });
    expect(await checkApifyUsage({ token: "t", fetchFn: limits(55), page: failing, claim, release })).toEqual([]);
    const ok = vi.fn(async () => {});
    expect(await checkApifyUsage({ token: "t", fetchFn: limits(55), page: ok, claim, release })).toEqual([0.5]);
  });
});
