import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/logging/alert", () => ({ alert: vi.fn(async () => {}) }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("tests must inject a store");
  },
}));

import {
  fetchSerp,
  GoogleRankError,
  parseOrganicItems,
  parseSerpItems,
  rankThreadsOnGoogle,
  redditPostId,
  SERP_URL,
  supabaseRankStore,
  type GoogleRankStore,
  type RankThread,
} from "../google-rank";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SWEEP = "22222222-2222-2222-2222-222222222222";

const envelope = (items: unknown[], cost = 0.004) => ({
  status_code: 20000,
  status_message: "Ok.",
  cost,
  tasks: [
    {
      id: "t1",
      status_code: 20000,
      status_message: "Ok.",
      cost,
      result: [{ keyword: "k", type: "organic", items }],
    },
  ],
});

const organic = (rank: number, url: string) => ({ type: "organic", rank_group: rank, rank_absolute: rank + 1, url });

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("redditPostId", () => {
  it.each([
    ["https://www.reddit.com/r/SaaS/comments/1abc2d/best_crm/", "1abc2d"],
    ["https://old.reddit.com/r/SaaS/comments/1ABC2D/best_crm/", "1abc2d"],
    ["https://reddit.com/r/SaaS/comments/1abc2d", "1abc2d"],
    ["https://www.reddit.com/r/SaaS/comments/1abc2d/?utm_source=share&utm_medium=web", "1abc2d"],
    ["https://m.reddit.com/r/SaaS/comments/1abc2d/best_crm/kx9y8z7/#thing", "1abc2d"],
  ])("%s → %s", (url, id) => {
    expect(redditPostId(url)).toBe(id);
  });

  it.each([
    "https://www.reddit.com/r/SaaS/",
    "https://www.reddit.com/user/bob/comments/1abc2d/x/",
    "https://notreddit.com/r/SaaS/comments/1abc2d/x/",
    "https://reddit.com.evil.io/r/SaaS/comments/1abc2d/x/",
    "https://www.example.com/r/SaaS/comments/1abc2d/x/",
    "not a url",
  ])("rejects %s", (url) => {
    expect(redditPostId(url)).toBeNull();
  });
});

describe("parseSerpItems", () => {
  it("keeps organic reddit permalinks only, best rank per post", () => {
    const hits = parseSerpItems({
      items: [
        organic(1, "https://www.hubspot.com/crm"),
        { type: "paid", rank_group: 1, url: "https://www.reddit.com/r/SaaS/comments/aaa111/x/" },
        organic(3, "https://www.reddit.com/r/SaaS/comments/aaa111/x/?rdt=1"),
        organic(7, "https://old.reddit.com/r/SaaS/comments/AAA111/"),
        organic(9, "https://www.reddit.com/r/SaaS/"),
        { type: "video", rank_group: 2, url: "https://www.reddit.com/r/SaaS/comments/bbb222/y/" },
        organic(12, "https://www.reddit.com/r/smallbusiness/comments/ccc333/z/"),
        { type: "organic", rank_group: "4", url: "https://www.reddit.com/r/a/comments/ddd444/" },
      ],
    });
    expect(hits).toEqual([
      { post_id: "aaa111", rank: 3, url: "https://www.reddit.com/r/SaaS/comments/aaa111/x/?rdt=1" },
      { post_id: "ccc333", rank: 12, url: "https://www.reddit.com/r/smallbusiness/comments/ccc333/z/" },
    ]);
  });

  it("tolerates a result with no items", () => {
    expect(parseSerpItems({})).toEqual([]);
  });
});

describe("parseOrganicItems", () => {
  it("counts the featured snippet as a ranked result and skips ads and other boxes", () => {
    const out = parseOrganicItems({
      items: [
        { type: "paid", rank_group: 1, url: "https://ads.example.com/" },
        { type: "featured_snippet", rank_group: 1, url: "https://workspace.google.com/" },
        organic(1, "https://www.iotecdigital.com/suite"),
        { type: "knowledge_graph", rank_group: 1, url: "https://en.wikipedia.org/wiki/Google_Workspace" },
        organic(2, "https://www.zoho.com/workplace/"),
      ],
    });
    expect(out).toEqual([
      { rank: 1, url: "https://workspace.google.com/", domain: "workspace.google.com" },
      { rank: 1, url: "https://www.iotecdigital.com/suite", domain: "iotecdigital.com" },
      { rank: 2, url: "https://www.zoho.com/workplace/", domain: "zoho.com" },
    ]);
  });
});

type Write = { threadId: string; rank: number | null; query: string | null; tenantId: string };

function fakeStore(opts: { keywords: string[]; threads: RankThread[]; sweepThreadIds: string[] }) {
  const writes: Write[] = [];
  const calls = { keywordsLimit: 0, lookups: [] as string[][] };
  const store: GoogleRankStore = {
    async rankKeywords(tenantId, limit) {
      expect(tenantId).toBe(TENANT);
      calls.keywordsLimit = limit;
      return opts.keywords.slice(0, limit);
    },
    async sweepThreads(tenantId, sweepId) {
      expect(tenantId).toBe(TENANT);
      expect(sweepId).toBe(SWEEP);
      return opts.threads.filter((t) => opts.sweepThreadIds.includes(t.id));
    },
    async threadsByPostIds(tenantId, ids) {
      expect(tenantId).toBe(TENANT);
      calls.lookups.push(ids);
      return opts.threads.filter((t) => ids.some((id) => t.url.includes(`/comments/${id}/`)));
    },
    async setRank(tenantId, threadId, rank, query) {
      writes.push({ tenantId, threadId, rank, query });
    },
  };
  return { store, writes, calls };
}

const THREADS: RankThread[] = [
  { id: "th-a", url: "https://www.reddit.com/r/saas/comments/aaa111/best_crm/", matched_terms: ["CRM for startups"] },
  { id: "th-b", url: "https://www.reddit.com/r/saas/comments/bbb222/crm_help/", matched_terms: ["crm for startups"] },
  { id: "th-c", url: "https://www.reddit.com/r/sales/comments/ccc333/old_thread/", matched_terms: [] },
  { id: "th-d", url: "https://www.reddit.com/r/sales/comments/ddd444/other/", matched_terms: ["cold email"] },
];

describe("rankThreadsOnGoogle", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DATAFORSEO_LOGIN = "login";
    process.env.DATAFORSEO_PASSWORD = "pw";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("unconfigured → zeros, no fetch, no DB", async () => {
    delete process.env.DATAFORSEO_LOGIN;
    const fetch = vi.fn();
    const store = { rankKeywords: vi.fn(), sweepThreads: vi.fn(), threadsByPostIds: vi.fn(), setRank: vi.fn() };
    const r = await rankThreadsOnGoogle(TENANT, SWEEP, { store, fetch });
    expect(r).toEqual({ queries: 0, threads_ranked: 0, cost_usd: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.rankKeywords).not.toHaveBeenCalled();
  });

  it("ranks matched threads by post id, marks unfound candidates checked, sums cost", async () => {
    const { store, writes, calls } = fakeStore({
      keywords: ["CRM for startups", "cold email"],
      threads: THREADS,
      sweepThreadIds: ["th-a", "th-b", "th-d"],
    });
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(SERP_URL);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("login:pw").toString("base64")}`,
      );
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body[0].keyword === "CRM for startups") {
        return jsonRes(
          envelope([
            organic(2, "https://www.hubspot.com/"),
            organic(4, "https://old.reddit.com/r/SaaS/comments/AAA111/best_crm/?share=1"),
            organic(15, "https://www.reddit.com/r/sales/comments/ccc333/"),
          ]),
        );
      }
      return jsonRes(envelope([organic(1, "https://www.example.com/")], 0.002));
    });

    const r = await rankThreadsOnGoogle(TENANT, SWEEP, { store, fetch, now: () => new Date("2026-09-18T12:00:00Z") });

    expect(bodies[0]).toEqual([{ keyword: "CRM for startups", location_code: 2840, language_code: "en", depth: 20 }]);
    expect(calls.keywordsLimit).toBe(8);
    expect(calls.lookups).toEqual([["aaa111", "ccc333"]]);
    expect(r).toEqual({ queries: 2, threads_ranked: 2, cost_usd: 0.006 });
    const byId = Object.fromEntries(writes.map((w) => [w.threadId, w]));
    expect(byId["th-a"]).toMatchObject({ rank: 4, query: "CRM for startups", tenantId: TENANT });
    expect(byId["th-c"]).toMatchObject({ rank: 15, query: "CRM for startups" });
    expect(byId["th-b"]).toMatchObject({ rank: null, query: null });
    expect(byId["th-d"]).toMatchObject({ rank: null, query: null });
    expect(writes).toHaveLength(4);
  });

  it("a thread ranked for one query is not reset by another query it missed", async () => {
    const threads: RankThread[] = [
      { id: "th-a", url: "https://www.reddit.com/r/saas/comments/aaa111/x/", matched_terms: ["crm", "pipeline"] },
    ];
    const { store, writes } = fakeStore({ keywords: ["crm", "pipeline"], threads, sweepThreadIds: ["th-a"] });
    const fetch = vi.fn(async (_u: string, init: RequestInit) =>
      JSON.parse(String(init.body))[0].keyword === "crm"
        ? jsonRes(envelope([organic(6, "https://www.reddit.com/r/SaaS/comments/aaa111/x/")]))
        : jsonRes(envelope([])),
    );
    const r = await rankThreadsOnGoogle(TENANT, SWEEP, { store, fetch });
    expect(r.threads_ranked).toBe(1);
    expect(writes).toEqual([{ tenantId: TENANT, threadId: "th-a", rank: 6, query: "crm" }]);
  });

  it("vendor failure never throws; failed query leaves its candidates unchecked", async () => {
    const { store, writes } = fakeStore({ keywords: ["crm for startups"], threads: THREADS, sweepThreadIds: ["th-a"] });
    const fetch = vi.fn(async () => jsonRes({ status_code: 40200, tasks: [{ status_code: 40200, cost: 0 }] }));
    const r = await rankThreadsOnGoogle(TENANT, SWEEP, { store, fetch });
    expect(r).toEqual({ queries: 0, threads_ranked: 0, cost_usd: 0 });
    expect(writes).toEqual([]);
  });

  it("a DB error after paid SERP calls throws with the spend so far, so the sweep is still charged it", async () => {
    const { store } = fakeStore({ keywords: ["crm for startups", "cold email"], threads: THREADS, sweepThreadIds: ["th-a"] });
    store.setRank = async () => {
      throw new Error("write failed");
    };
    const fetch = vi.fn(async () => jsonRes(envelope([organic(4, "https://www.reddit.com/r/saas/comments/aaa111/x/")], 0.004)));
    const err = await rankThreadsOnGoogle(TENANT, SWEEP, { store, fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleRankError);
    expect(err).toMatchObject({ message: expect.stringContaining("write failed"), cost_usd: 0.008 });
    const early = fakeStore({ keywords: ["crm"], threads: THREADS, sweepThreadIds: [] });
    early.store.sweepThreads = async () => {
      throw new Error("read failed");
    };
    await expect(rankThreadsOnGoogle(TENANT, SWEEP, { store: early.store, fetch })).rejects.toMatchObject({ cost_usd: 0 });
  });

  it("no tracked keywords → zeros without calling the vendor", async () => {
    const { store } = fakeStore({ keywords: [], threads: THREADS, sweepThreadIds: [] });
    const fetch = vi.fn();
    expect(await rankThreadsOnGoogle(TENANT, SWEEP, { store, fetch })).toEqual({
      queries: 0,
      threads_ranked: 0,
      cost_usd: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("fetchSerp retry policy", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DATAFORSEO_LOGIN = "login";
    process.env.DATAFORSEO_PASSWORD = "pw";
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const sleep = async () => {};

  it("retries once on 429, then succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(jsonRes(envelope([])));
    const r = await fetchSerp("crm", { fetch, sleep });
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("asks from the given country and depth, and returns every organic result (the /start card)", async () => {
    const fetch = vi.fn(async (_u: string, _i: RequestInit) =>
      jsonRes(envelope([organic(2, "https://www.acme.co.uk/x"), organic(1, "https://www.reddit.com/r/a/comments/abc/t/"), { type: "local_pack" }])),
    );
    const r = await fetchSerp("plumber leeds", { fetch, sleep, country: "GB", depth: 100 });
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual([
      { keyword: "plumber leeds", location_code: 2826, language_code: "en", depth: 100 },
    ]);
    expect(r).toMatchObject({
      ok: true,
      organic: [
        { rank: 1, url: "https://www.reddit.com/r/a/comments/abc/t/", domain: "reddit.com" },
        { rank: 2, url: "https://www.acme.co.uk/x", domain: "acme.co.uk" },
      ],
    });
  });

  it("gives up after one retry on 5xx", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    const r = await fetchSerp("crm", { fetch, sleep });
    expect(r).toEqual({ ok: false, error_code: "dataforseo_http_503", cost_usd: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  const taskErr = (code: number, cost = 0.002) => ({
    status_code: 20000,
    cost,
    tasks: [{ id: "t1", status_code: code, status_message: "err", cost, result: null }],
  });

  it("retries once on a Google-side task error (40101/40106) and reports both attempts' cost", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(taskErr(40101)))
      .mockResolvedValueOnce(jsonRes(envelope([], 0.004)));
    const r = await fetchSerp("crm", { fetch, sleep });
    expect(r.ok).toBe(true);
    expect(r.cost_usd).toBeCloseTo(0.006);
    expect(fetch).toHaveBeenCalledTimes(2);

    const twice = vi.fn(async () => jsonRes(taskErr(40106)));
    expect(await fetchSerp("crm", { fetch: twice, sleep })).toMatchObject({ ok: false, error_code: "dataforseo_task_40106" });
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it("keeps the first attempt's cost when the retry then fails another way", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetch = vi.fn().mockResolvedValueOnce(jsonRes(taskErr(40101, 0.002))).mockRejectedValueOnce(abort);
    expect(await fetchSerp("crm", { fetch, sleep })).toEqual({ ok: false, error_code: "dataforseo_timeout", cost_usd: 0.002 });
  });

  it("does not retry other task errors", async () => {
    const fetch = vi.fn(async () => jsonRes(taskErr(40501)));
    expect(await fetchSerp("crm", { fetch, sleep })).toMatchObject({ ok: false, error_code: "dataforseo_task_40501" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx, a timeout or a network error", async () => {
    const f401 = vi.fn(async () => new Response("no", { status: 401 }));
    expect((await fetchSerp("crm", { fetch: f401, sleep })).ok).toBe(false);
    expect(f401).toHaveBeenCalledTimes(1);

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fAbort = vi.fn(async () => Promise.reject(abort));
    expect(await fetchSerp("crm", { fetch: fAbort, sleep })).toMatchObject({ error_code: "dataforseo_timeout" });
    expect(fAbort).toHaveBeenCalledTimes(1);

    const fNet = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    expect(await fetchSerp("crm", { fetch: fNet, sleep })).toMatchObject({ error_code: "dataforseo_network" });
    expect(fNet).toHaveBeenCalledTimes(1);
  });
});

describe("supabaseRankStore", () => {
  function recorder(data: unknown) {
    const log: Array<[string, unknown[]]> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "order", "limit", "or", "update"]) {
      chain[m] = (...args: unknown[]) => {
        log.push([m, args]);
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data, error: null });
    const sb = {
      from: (t: string) => {
        log.push(["from", [t]]);
        return chain;
      },
    };
    return { sb: sb as never, log };
  }

  it("filters every read and write on tenant_id", async () => {
    const k = recorder([
      { item: "crm", item_type: null },
      { item: "Acme", item_type: "brand" },
      { item: "invoice app", item_type: "category" },
    ]);
    expect(await supabaseRankStore(k.sb).rankKeywords(TENANT, 8)).toEqual(["crm", "invoice app"]);
    expect(k.log).toContainEqual(["from", ["channel_settings"]]);
    expect(k.log).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(k.log).toContainEqual(["eq", ["channel_slug", "reddit_organic"]]);
    expect(k.log).toContainEqual(["eq", ["field_id", "keywords"]]);
    expect(k.log).toContainEqual(["eq", ["status", "tracking"]]);

    const l = recorder([]);
    await supabaseRankStore(l.sb).threadsByPostIds(TENANT, ["aaa111", "bad,id"]);
    expect(l.log).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(l.log).toContainEqual(["or", ["url.ilike.*/comments/aaa111/*"]]);

    const w = recorder(null);
    await supabaseRankStore(w.sb).setRank(TENANT, "th-a", 3, "crm", "2026-09-18T00:00:00Z");
    expect(w.log).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(w.log).toContainEqual(["eq", ["id", "th-a"]]);
  });
});
