import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RedditWorkspace } from "../workspace";
import {
  buildSweepJobs,
  canonicalRedditUrl,
  commentHash,
  downstreamSteps,
  estimateSweepCost,
  estimateScoreBatches,
  failRedditSweep,
  finalizeSweep,
  fitSweepJobs,
  minimalSweepEstimate,
  tenantSpend7d,
  listSweepableTenants,
  TENANT_LIST_PAGE,
  LLM_BATCH_EST_USD,
  loadSweepJobs,
  mapAdmission,
  parseStoredJobs,
  matchTerms,
  openRedditSweep,
  redditPostId,
  REDDIT_SWEEP_EVENT,
  runDownstreamStep,
  runSweepJob,
  sweepCost,
  sweepFinalStatus,
  touchSweep,
  trackedTermsOf,
  type SweepDeps,
  type SweepJob,
} from "../sweep";

type Call = {
  table: string;
  op: "select" | "count" | "upsert" | "insert" | "update" | "rpc";
  payload?: unknown;
  opts?: unknown;
  filters: Array<[string, string, unknown]>;
};
type Res = { data: unknown; error: { code?: string; message: string } | null; count?: number };

function fakeDb(handler: (c: Call) => Res = () => ({ data: null, error: null })) {
  const calls: Call[] = [];
  const run = (c: Call) => {
    calls.push(c);
    return Promise.resolve(handler(c));
  };
  const builder = (table: string) => {
    const c: Call = { table, op: "select", filters: [] };
    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string }) => (opts?.count && c.op === "select" ? (c.op = "count") : null, b),
      upsert: (payload: unknown, opts: unknown) => ((c.op = "upsert"), (c.payload = payload), (c.opts = opts), b),
      insert: (payload: unknown) => ((c.op = "insert"), (c.payload = payload), b),
      update: (payload: unknown) => ((c.op = "update"), (c.payload = payload), b),
      eq: (col: string, v: unknown) => (c.filters.push(["eq", col, v]), b),
      gt: (col: string, v: unknown) => (c.filters.push(["gt", col, v]), b),
      in: (col: string, v: unknown) => (c.filters.push(["in", col, v]), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => run(c),
      single: () => run(c),
      then: (res: (r: Res) => unknown, rej: (e: unknown) => unknown) => run(c).then(res, rej),
    };
    return b;
  };
  const db = {
    from: builder,
    rpc: (fn: string, args: unknown) => run({ table: fn, op: "rpc", payload: args, filters: [] }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

const T = "11111111-1111-1111-1111-111111111111";
const S = "22222222-2222-2222-2222-222222222222";

function ws(partial: Partial<RedditWorkspace> = {}): RedditWorkspace {
  return { keywords: [], competitors: [], communities: [], ...partial };
}
const kw = (id: string, term: string, type: string, status = "tracking") =>
  ({ id, term, type, status, origin: "custom", why: null, created_at: "" }) as RedditWorkspace["keywords"][number];
const comp = (id: string, name: string, status = "tracking") =>
  ({ id, name, status, domain: null, origin: "custom", why: null, created_at: "" }) as RedditWorkspace["competitors"][number];
const sub = (id: string, name: string, selected = true, rules_verdict: "allowed" | "unclear" | "banned" | null = null) =>
  ({ id, name, selected, rules_verdict, rules_verdict_at: null, created_at: "" }) as RedditWorkspace["communities"][number];

const WS = ws({
  keywords: [
    kw("k1", "rent out my car", "problem"),
    kw("k2", "Upcar", "brand"),
    kw("k3", "peer to peer car rental", "category", "suggested"),
    kw("k4", "Turo", "comparison"),
    kw("k5", "paused one", "problem", "paused"),
  ],
  competitors: [comp("c1", "Turo"), comp("c2", "Getaround"), comp("c3", "HyreCar", "dismissed")],
  communities: [sub("m1", "turo"), sub("m2", "Frugal", false), sub("m3", "Turo"), sub("m4", "carsharing")],
});

describe("buildSweepJobs", () => {
  it("orders selected communities, then brand, competitors, other tracked keywords; dedupes", () => {
    const jobs = buildSweepJobs(WS, 12);
    expect(jobs.map((j) => j.key)).toEqual([
      "sub:turo",
      "sub:carsharing",
      "term:upcar",
      "term:turo",
      "term:getaround",
      "term:rent out my car",
    ]);
    const s = jobs[0] as Extract<SweepJob, { kind: "subreddit" }>;
    expect(s.args).toEqual({
      mode: "subreddit",
      subreddit: "turo",
      time: "day",
      max_items: 25,
      with_comments: true,
      max_comments_per_post: 5,
    });
    const t = jobs[2] as Extract<SweepJob, { kind: "term" }>;
    expect(t.args).toEqual({
      mode: "search_posts",
      query: "Upcar",
      time: "week",
      max_items: 25,
      with_comments: true,
      max_comments_per_post: 5,
    });
  });

  it("caps at max jobs, dropping the lowest priority first", () => {
    expect(buildSweepJobs(WS, 6).map((j) => j.key)).toEqual([
      "sub:turo",
      "sub:carsharing",
      "term:upcar",
      "term:turo",
      "term:getaround",
      "term:rent out my car",
    ]);
    expect(buildSweepJobs(WS, 5).map((j) => j.key)).toEqual([
      "sub:turo",
      "term:upcar",
      "term:turo",
      "term:getaround",
      "term:rent out my car",
    ]);
    expect(buildSweepJobs(WS, 0)).toEqual([]);
  });

  it("reserves room for min(terms, 4) searches, so communities cannot crowd out brand and competitors", () => {
    const many = ws({
      keywords: [kw("k1", "Upcar", "brand"), kw("k2", "rent out my car", "problem"), kw("k3", "car hire", "problem")],
      competitors: [comp("c1", "Turo"), comp("c2", "Getaround"), comp("c3", "HyreCar")],
      communities: Array.from({ length: 12 }, (_, i) => sub(`m${i}`, `sub_${i}`)),
    });
    const keys = buildSweepJobs(many, 12).map((j) => j.key);
    expect(keys).toHaveLength(12);
    expect(keys.filter((k) => k.startsWith("sub:"))).toHaveLength(8);
    expect(keys.slice(8)).toEqual(["term:upcar", "term:turo", "term:getaround", "term:hyrecar"]);
    const one = ws({ keywords: [kw("k1", "Upcar", "brand")], communities: many.communities });
    const oneKeys = buildSweepJobs(one, 12).map((j) => j.key);
    expect(oneKeys.filter((k) => k.startsWith("sub:"))).toHaveLength(11);
    expect(oneKeys[11]).toBe("term:upcar");
  });

  it("skips banned communities and lowercases subreddit names", () => {
    const w = ws({ communities: [sub("m1", "SmallBusiness"), sub("m2", "Banned_One", true, "banned"), sub("m3", "Frugal", true, "unclear")] });
    const jobs = buildSweepJobs(w, 12) as Array<Extract<SweepJob, { kind: "subreddit" }>>;
    expect(jobs.map((j) => [j.key, j.subreddit, j.args.subreddit])).toEqual([
      ["sub:smallbusiness", "smallbusiness", "smallbusiness"],
      ["sub:frugal", "frugal", "frugal"],
    ]);
  });

  it("is empty when nothing is tracked or selected", () => {
    expect(buildSweepJobs(ws({ keywords: [kw("x", "idea", "problem", "suggested")] }), 12)).toEqual([]);
  });

  it("estimates jobs x $0.04 + min(non-brand keywords, 8) x $0.004 + scoring batches x $0.035", () => {
    expect(LLM_BATCH_EST_USD).toBe(0.035);
    expect(estimateScoreBatches(6)).toBe(30);
    expect(estimateScoreBatches(12)).toBe(34);
    expect(estimateScoreBatches(1)).toBe(2 + 9);
    expect(estimateScoreBatches(0)).toBe(0);
    expect(estimateSweepCost(6, 2)).toBe(1.298);
    expect(estimateSweepCost(12, 20)).toBe(1.702);
  });
});

describe("canonicalRedditUrl", () => {
  const CANON = "https://www.reddit.com/r/turo/comments/1abc2d/";
  it.each([
    ["https://www.reddit.com/r/Turo/comments/1abc2d/my_first_rental/", CANON],
    ["https://old.reddit.com/r/Turo/comments/1ABC2D/my_first_rental?utm=x#c", CANON],
    ["https://WWW.Reddit.com/r/Turo/comments/1abc2d/my_first_rental/kx9z1/", CANON],
    ["http://reddit.com/r/Turo/comments/1abc2d", CANON],
    ["/r/TURO/comments/1abc2d/x/", CANON],
    ["https://www.reddit.com/r/turo/comments/1abc2d/", CANON],
  ])("%s", (input, out) => {
    expect(canonicalRedditUrl(input)).toBe(out);
    expect(redditPostId(input)).toBe("1abc2d");
  });

  it.each([
    "https://www.reddit.com/r/Turo/",
    "https://www.reddit.com/r/Turo/comments/",
    "https://www.reddit.com/r/Turo/comments/abc-d/x/",
    "https://www.reddit.com/user/someone/comments/abc/x/",
    "https://evilreddit.com/r/Turo/comments/abc/x/",
    "https://example.com/r/Turo/comments/abc/x/",
    "not a url at all ::",
    "",
    null,
  ])("rejects %j", (input) => {
    expect(canonicalRedditUrl(input)).toBeNull();
  });
});

describe("trackedTermsOf + matchTerms", () => {
  const terms = trackedTermsOf(WS);

  it("keeps tracked terms only, with mention kinds by source", () => {
    expect(terms).toEqual([
      { term: "Upcar", kind: "brand", keyword_id: "k2", competitor_id: null },
      { term: "Turo", kind: "competitor", keyword_id: null, competitor_id: "c1" },
      { term: "Getaround", kind: "competitor", keyword_id: null, competitor_id: "c2" },
      { term: "rent out my car", kind: "keyword", keyword_id: "k1", competitor_id: null },
    ]);
  });

  it("matches case-insensitively on word boundaries", () => {
    const hit = (text: string) => matchTerms(text, terms).map((t) => t.term);
    expect(hit("Has anyone tried TURO vs getaround?")).toEqual(["Turo", "Getaround"]);
    expect(hit("Neuturo and Turobot are not Turo")).toEqual(["Turo"]);
    expect(hit("neuturo turobot")).toEqual([]);
    expect(hit("I want to Rent  out\nmy car this summer")).toEqual(["rent out my car"]);
    expect(hit("upcar's pricing")).toEqual(["Upcar"]);
    expect(hit("")).toEqual([]);
  });

  it("handles terms with punctuation", () => {
    const t = [{ term: "C++", kind: "keyword" as const, keyword_id: "x", competitor_id: null }];
    expect(matchTerms("learning c++ today", t)).toHaveLength(1);
    expect(matchTerms("learning c++x today", t)).toHaveLength(0);
  });
});

describe("mapAdmission", () => {
  it("maps verdicts and fails closed", () => {
    expect(mapAdmission({ ok: true, sweep_id: S }, null)).toEqual({ ok: true, sweep_id: S });
    for (const reason of ["already_running", "nothing_to_scan", "tenant_cap_reached", "fleet_cap_reached"]) {
      expect(mapAdmission({ ok: false, reason }, null)).toEqual({ ok: false, reason });
    }
    expect(mapAdmission({ ok: false, reason: "surprise" }, null)).toEqual({ ok: false, reason: "admission_failed" });
    expect(mapAdmission(null, { message: "boom" })).toEqual({ ok: false, reason: "admission_failed" });
    expect(mapAdmission({ ok: true }, null)).toEqual({ ok: false, reason: "admission_failed" });
  });
});

describe("openRedditSweep", () => {
  const baseDeps = (over: Partial<SweepDeps> & { rpc?: Res; spend?: Res } = {}) => {
    const { db, calls } = fakeDb((c) =>
      c.op === "rpc"
        ? (over.rpc ?? { data: { ok: true, sweep_id: S }, error: null })
        : c.table === "reddit_sweeps" && c.op === "select"
          ? (over.spend ?? { data: [], error: null })
          : { data: null, error: null },
    );
    const send = vi.fn(async () => ({}));
    const numbers: Record<string, number> = {
      reddit_sweep_max_jobs: 12,
      reddit_sweep_tenant_cap_usd_7d: 3,
      reddit_sweep_fleet_cap_usd_24h: 25,
    };
    const deps: SweepDeps = {
      db: () => db,
      send,
      getBool: async () => true,
      getNumber: async (k) => numbers[k],
      apifyConfigured: () => true,
      readWorkspace: async () => WS,
      now: () => new Date("2026-09-18T12:00:00Z"),
      ...over,
    };
    return { deps, calls, send };
  };

  it("refuses when disabled or unconfigured, before touching the DB", async () => {
    const a = baseDeps({ getBool: async () => false });
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: false, reason: "disabled" });
    const b = baseDeps({ apifyConfigured: () => false });
    expect(await openRedditSweep(T, { trigger: "manual" }, b.deps)).toEqual({ ok: false, reason: "not_configured" });
    expect([...a.calls, ...b.calls]).toEqual([]);
  });

  it("returns nothing_to_scan without calling the RPC", async () => {
    const a = baseDeps({ readWorkspace: async () => ws() });
    expect(await openRedditSweep(T, { trigger: "cron" }, a.deps)).toEqual({ ok: false, reason: "nothing_to_scan" });
    expect(a.calls).toEqual([]);
  });

  it("admits with caps from settings and fires the event", async () => {
    const a = baseDeps();
    expect(await openRedditSweep(T, { trigger: "manual", requestedBy: "u1" }, a.deps)).toEqual({ ok: true, sweep_id: S });
    expect(a.calls).toHaveLength(2);
    expect(a.calls[0]).toEqual({
      table: "reddit_sweeps",
      op: "select",
      filters: [
        ["eq", "tenant_id", T],
        ["gt", "started_at", "2026-09-11T12:00:00.000Z"],
      ],
    });
    a.calls.shift();
    expect(a.calls[0]).toMatchObject({
      table: "reddit_open_sweep",
      op: "rpc",
      payload: {
        p_tenant_id: T,
        p_trigger: "manual",
        p_requested_by: "u1",
        p_jobs_planned: 6,
        p_est_cost_usd: 1.298,
        p_tenant_cap_usd_7d: 3,
        p_fleet_cap_usd_24h: 25,
      },
    });
    const stored = (a.calls[0].payload as { p_jobs: SweepJob[] }).p_jobs;
    expect(stored).toEqual(buildSweepJobs(WS, 12));
    expect(stored).toHaveLength(6);
    expect(a.send).toHaveBeenCalledWith({ name: REDDIT_SWEEP_EVENT, data: { sweep_id: S, tenant_id: T } });
  });

  const WS_BIG = ws({
    ...WS,
    communities: Array.from({ length: 10 }, (_, i) => sub(`b${i}`, `community${i}`)),
  });
  const rpcCalls = (calls: Call[]) => calls.filter((c) => c.op === "rpc");

  it("shrinks the job list to what the week's remaining budget pays for: $1.47 used of $3 admits 8 of 12 jobs", async () => {
    const a = baseDeps({
      readWorkspace: async () => WS_BIG,
      spend: { data: [{ cost_usd: 1, est_cost_usd: 9 }, { cost_usd: null, est_cost_usd: 0.47 }], error: null },
    });
    expect(buildSweepJobs(WS_BIG, 12)).toHaveLength(12);
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: true, sweep_id: S });
    const [rpc] = rpcCalls(a.calls);
    const p = rpc.payload as { p_jobs: SweepJob[]; p_jobs_planned: number; p_est_cost_usd: number; p_tenant_cap_usd_7d: number };
    expect(p.p_jobs_planned).toBe(8);
    expect(p.p_jobs).toEqual(buildSweepJobs(WS_BIG, 8));
    expect(p.p_est_cost_usd).toBe(1.518);
    expect(p.p_est_cost_usd).toBeLessThanOrEqual(3 - 1.47);
    expect(estimateSweepCost(9, 2)).toBeGreaterThan(3 - 1.47);
    expect(p.p_tenant_cap_usd_7d).toBe(3);
    expect(p.p_jobs.map((j) => j.key)).toEqual(expect.arrayContaining(buildSweepJobs(WS_BIG, 12).slice(-4).map((j) => j.key)));
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it("refuses tenant_cap_reached WITHOUT calling the paid RPC or the worker when not even one job fits", async () => {
    const oneJob = minimalSweepEstimate(2);
    expect(oneJob).toBe(0.433);
    const a = baseDeps({ spend: { data: [{ cost_usd: 2.6, est_cost_usd: null }], error: null } });
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: false, reason: "tenant_cap_reached" });
    expect(rpcCalls(a.calls)).toEqual([]);
    expect(a.send).not.toHaveBeenCalled();
    expect(a.calls.some((c) => c.op === "update" || c.op === "insert")).toBe(false);
  });

  it("refuses without the RPC once spend is past the cap", async () => {
    const a = baseDeps({ spend: { data: [{ cost_usd: 3.5, est_cost_usd: null }], error: null } });
    expect(await openRedditSweep(T, { trigger: "cron" }, a.deps)).toEqual({ ok: false, reason: "tenant_cap_reached" });
    expect(rpcCalls(a.calls)).toEqual([]);
  });

  it("admits a single job when the remainder pays for exactly one", async () => {
    const a = baseDeps({ spend: { data: [{ cost_usd: 2.5, est_cost_usd: null }], error: null } });
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: true, sweep_id: S });
    const p = rpcCalls(a.calls)[0].payload as { p_jobs: SweepJob[]; p_jobs_planned: number; p_est_cost_usd: number };
    expect(p.p_jobs_planned).toBe(1);
    expect(p.p_jobs).toEqual(buildSweepJobs(WS, 1));
    expect(p.p_est_cost_usd).toBe(0.433);
  });

  it("admits one job when float subtraction leaves a hair under the estimate: cap 3, used 2.567", async () => {
    expect(3 - 2.567).toBeLessThan(minimalSweepEstimate(2));
    const a = baseDeps({ spend: { data: [{ cost_usd: 2.567, est_cost_usd: null }], error: null } });
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: true, sweep_id: S });
    const rpcs = rpcCalls(a.calls);
    expect(rpcs).toHaveLength(1);
    const p = rpcs[0].payload as { p_jobs: SweepJob[]; p_jobs_planned: number; p_est_cost_usd: number };
    expect(p.p_jobs_planned).toBe(1);
    expect(p.p_jobs).toEqual(buildSweepJobs(WS, 1));
    expect(p.p_est_cost_usd).toBe(0.433);
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it("leaves the cap to the SQL admission when the spend read fails: full plan, RPC still decides", async () => {
    const a = baseDeps({ spend: { data: null, error: { message: "down" } } });
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: true, sweep_id: S });
    const p = rpcCalls(a.calls)[0].payload as { p_jobs_planned: number; p_tenant_cap_usd_7d: number };
    expect(p.p_jobs_planned).toBe(6);
    expect(p.p_tenant_cap_usd_7d).toBe(3);
  });

  it("passes refusals through and fails closed on RPC error", async () => {
    const a = baseDeps({ rpc: { data: { ok: false, reason: "tenant_cap_reached" }, error: null } });
    expect(await openRedditSweep(T, { trigger: "auto" }, a.deps)).toEqual({ ok: false, reason: "tenant_cap_reached" });
    const b = baseDeps({ rpc: { data: null, error: { message: "down" } } });
    expect(await openRedditSweep(T, { trigger: "auto" }, b.deps)).toEqual({ ok: false, reason: "admission_failed" });
    expect(a.send).not.toHaveBeenCalled();
  });

  it("never throws: a workspace read error is admission_failed", async () => {
    const a = baseDeps({ readWorkspace: async () => { throw new Error("db"); } });
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: false, reason: "admission_failed" });
  });

  it("closes the admitted row when the event cannot be sent", async () => {
    const a = baseDeps({ send: async () => { throw new Error("inngest down"); } });
    expect(await openRedditSweep(T, { trigger: "manual" }, a.deps)).toEqual({ ok: false, reason: "enqueue_failed" });
    const upd = a.calls.find((c) => c.op === "update");
    expect(upd).toMatchObject({ table: "reddit_sweeps", payload: { status: "failed", error_code: "enqueue_failed", cost_usd: 0 } });
    expect(upd?.filters).toEqual([
      ["eq", "tenant_id", T],
      ["eq", "id", S],
      ["eq", "status", "running"],
    ]);
  });
});

describe("runSweepJob", () => {
  const job = buildSweepJobs(WS, 12)[0];
  const post = (id: string, over: Record<string, unknown> = {}) => ({
    title: `Post ${id} about Turo`,
    url: `https://old.reddit.com/r/turo/comments/${id}/slug_${id}/?share=1`,
    community: "r/turo",
    author: "a",
    score: 10,
    comments: 3,
    subscribers: 41200,
    age_hours: 5,
    locked: false,
    removed_by: null,
    body: "Thinking to rent out my car",
    ...over,
  });

  function harness(apifyContent: { ok: boolean; content: string }, status = "running") {
    const { db, calls } = fakeDb((c) => {
      if (c.table === "reddit_sweeps" && c.op === "select") {
        return {
          data: { status, posts_scanned: 1, comments_scanned: 0, jobs_done: 1, jobs_failed: 0, communities_scanned: 0 },
          error: null,
        };
      }
      if (c.table === "reddit_threads" && c.op === "upsert") {
        return { data: (c.payload as Array<{ url: string }>).map((r, i) => ({ id: `th${i}`, url: r.url })), error: null };
      }
      if (c.table === "reddit_comments" && c.op === "upsert") {
        return {
          data: (c.payload as Array<{ content_hash: string }>).map((r, i) => ({ id: `cm${i}`, content_hash: r.content_hash })),
          error: null,
        };
      }
      if (c.table === "reddit_mentions" && c.op === "select") return { data: [], error: null };
      if (c.op === "count") return { data: null, error: null, count: c.table === "reddit_threads" ? 7 : 4 };
      return { data: null, error: null };
    });
    const apify = vi.fn(async () => ({ ...apifyContent, is_error: !apifyContent.ok, ms: 1 }));
    const deps: SweepDeps = {
      db: () => db,
      apify,
      readWorkspace: async () => WS,
      now: () => new Date("2026-09-18T12:00:00Z"),
    };
    return { deps, calls, apify };
  }

  it("gives a new mention on an already-scored thread or comment that row's sentiment", async () => {
    const { db, calls } = fakeDb((c) => {
      if (c.table === "reddit_sweeps" && c.op === "select") {
        return { data: { status: "running", jobs_done: 0, jobs_failed: 0, communities_scanned: 0 }, error: null };
      }
      if (c.table === "reddit_threads" && c.op === "upsert") {
        return { data: (c.payload as Array<{ url: string }>).map((r) => ({ id: "th0", url: r.url, sentiment: "negative" })), error: null };
      }
      if (c.table === "reddit_comments" && c.op === "upsert") {
        return {
          data: (c.payload as Array<{ content_hash: string }>).map((r) => ({ id: "cm0", content_hash: r.content_hash, sentiment: "positive" })),
          error: null,
        };
      }
      if (c.table === "reddit_mentions" && c.op === "select") return { data: [], error: null };
      if (c.op === "count") return { data: null, error: null, count: 1 };
      return { data: null, error: null };
    });
    const apify = vi.fn(async () => ({
      ok: true,
      is_error: false,
      ms: 1,
      content: JSON.stringify({
        posts: [post("aa1")],
        comments: [{ author: "c", score: 2, community: "r/turo", post_url: "https://www.reddit.com/r/turo/comments/aa1/x/", body: "Getaround was cheaper" }],
      }),
    }));

    await runSweepJob(T, S, job, { db: () => db, apify, readWorkspace: async () => WS, now: () => new Date("2026-09-18T12:00:00Z") });

    const mentions = calls.find((c) => c.table === "reddit_mentions" && c.op === "insert")!.payload as Array<Record<string, unknown>>;
    expect(mentions.filter((m) => m.comment_id === null).every((m) => m.sentiment === "negative")).toBe(true);
    expect(mentions.find((m) => m.comment_id === "cm0")).toMatchObject({ term: "Getaround", sentiment: "positive" });
  });

  it("stores canonical threads, linked comments, mentions, stats and counters", async () => {
    const posts = [
      post("aa1"),
      post("aa1", { url: "https://www.reddit.com/r/Turo/comments/AA1/a_different_slug/" }),
      post("bb2", { age_hours: 30, subscribers: null }),
      post("zz", { url: "https://example.com/x" }),
    ];
    const comments = [
      { author: "c", score: 2, community: "r/turo", post_url: "https://www.reddit.com/r/turo/comments/aa1/slug_aa1/kc1/", body: "Getaround was cheaper" },
      { author: "c", score: 2, community: "r/turo", post_url: "https://www.reddit.com/r/turo/comments/aa1/slug_aa1/", body: "Getaround was cheaper" },
      { author: "d", score: 1, community: "r/turo", post_url: "https://www.reddit.com/r/other/comments/nope/x/", body: "orphan" },
    ];
    const h = harness({ ok: true, content: JSON.stringify({ posts, comments }) });
    const r = await runSweepJob(T, S, job, h.deps);
    expect(r).toEqual({ ok: true, posts: 2, comments: 1, mentions: 5 });
    expect(h.apify).toHaveBeenCalledWith(T, "scrape_reddit", job.args);

    const threads = h.calls.find((c) => c.table === "reddit_threads")!;
    expect(threads.opts).toEqual({ onConflict: "tenant_id,url" });
    const rows = threads.payload as Array<Record<string, unknown>>;
    expect(rows.map((t) => t.url)).toEqual([
      "https://www.reddit.com/r/turo/comments/aa1/",
      "https://www.reddit.com/r/turo/comments/bb2/",
    ]);
    expect(rows[0]).toMatchObject({
      tenant_id: T,
      subreddit: "turo",
      posted_at: "2026-09-18T07:00:00.000Z",
      last_seen_at: "2026-09-18T12:00:00.000Z",
      last_sweep_id: S,
      removed: false,
      matched_terms: ["Turo", "rent out my car"],
    });
    for (const col of ["post_relevance", "score_hash", "google_rank", "first_seen_at", "sentiment"]) {
      expect(rows[0]).not.toHaveProperty(col);
    }

    const cm = h.calls.find((c) => c.table === "reddit_comments")!;
    expect(cm.opts).toEqual({ onConflict: "tenant_id,content_hash" });
    expect(cm.payload).toEqual([
      expect.objectContaining({
        thread_id: "th0",
        content_hash: commentHash("https://www.reddit.com/r/turo/comments/aa1/", "c", "Getaround was cheaper"),
        matched_terms: ["Getaround"],
      }),
    ]);

    const mentions = h.calls.find((c) => c.table === "reddit_mentions" && c.op === "insert")!.payload as Array<Record<string, unknown>>;
    expect(mentions.map((m) => [m.thread_id, m.comment_id, m.term, m.kind])).toEqual([
      ["th0", null, "Turo", "competitor"],
      ["th0", null, "rent out my car", "keyword"],
      ["th1", null, "Turo", "competitor"],
      ["th1", null, "rent out my car", "keyword"],
      ["th0", "cm0", "Getaround", "competitor"],
    ]);
    expect(mentions[0]).toMatchObject({ observed_at: "2026-09-18T07:00:00.000Z" });
    expect(mentions[4]).toMatchObject({ competitor_id: "c2", keyword_id: null, subreddit: "turo", observed_at: "2026-09-18T12:00:00.000Z" });

    const stats = h.calls.find((c) => c.table === "reddit_community_stats")!;
    expect(stats.payload).toEqual({
      tenant_id: T,
      name: "turo",
      subscribers: 41200,
      posts_per_day: 3,
      posts_per_day_capped: false,
      updated_at: "2026-09-18T12:00:00.000Z",
    });

    const bump = h.calls.find((c) => c.table === "reddit_sweeps" && c.op === "update")!;
    expect(bump.payload).toEqual({
      posts_scanned: 7,
      comments_scanned: 4,
      jobs_done: 2,
      jobs_failed: 0,
      communities_scanned: 1,
      heartbeat_at: "2026-09-18T12:00:00.000Z",
    });
    expect(bump.filters).toContainEqual(["eq", "status", "running"]);
    const counts = h.calls.filter((c) => c.op === "count");
    expect(counts.map((c) => [c.table, c.filters])).toEqual([
      ["reddit_threads", [["eq", "tenant_id", T], ["eq", "last_sweep_id", S]]],
      ["reddit_comments", [["eq", "tenant_id", T], ["eq", "last_sweep_id", S]]],
    ]);
    for (const c of h.calls.filter((c) => c.op === "select")) expect(c.filters).toContainEqual(["eq", "tenant_id", T]);
  });

  it("stores only a thread permalink: short links resolve via the community, external/share links are skipped", async () => {
    const posts = [
      post("rr1", { url: "https://redd.it/rr1" }),
      post("rr2", { url: "/r/turo/comments/rr2/relative_slug/" }),
      post("rr3", { url: "https://www.reddit.com/r/turo/comments/rr3/x/lk2c9/?context=3" }),
      post("ext", { url: "https://techcrunch.com/story" }),
      post("shr", { url: "https://www.reddit.com/r/turo/s/AbCdEf" }),
    ];
    const h = harness({ ok: true, content: JSON.stringify({ posts, comments: [] }) });
    const r = await runSweepJob(T, S, job, h.deps);
    expect(r.ok).toBe(true);
    const rows = h.calls.find((c) => c.table === "reddit_threads")!.payload as Array<Record<string, unknown>>;
    expect(rows.map((t) => t.url)).toEqual([
      "https://www.reddit.com/r/turo/comments/rr1/",
      "https://www.reddit.com/r/turo/comments/rr2/",
      "https://www.reddit.com/r/turo/comments/rr3/",
    ]);
    for (const row of rows) expect(row.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+\/$/);
  });

  it("flags removed/deleted posts from the actor field or Reddit's own markers, and drops deleted comments", async () => {
    const posts = [
      post("ok1"),
      post("rb1", { removed_by: "moderator" }),
      post("rb2", { removed_by: null, body: "[removed]" }),
      post("rb3", { removed_by: null, body: "[deleted]" }),
      post("rb4", { removed_by: null, title: "[deleted by user]" }),
      post("ok2", { author: "[deleted]" }),
      post("lk1", { locked: true }),
    ];
    const comments = [
      { author: "[deleted]", score: 1, community: "r/turo", post_url: "https://www.reddit.com/r/turo/comments/ok1/", body: "[deleted]" },
      { author: "x", score: 1, community: "r/turo", post_url: "https://www.reddit.com/r/turo/comments/ok1/", body: " [removed] " },
      { author: "y", score: 1, community: "r/turo", post_url: "https://www.reddit.com/r/turo/comments/ok1/", body: "real reply" },
    ];
    const h = harness({ ok: true, content: JSON.stringify({ posts, comments }) });
    const r = await runSweepJob(T, S, job, h.deps);
    expect(r).toMatchObject({ ok: true, posts: 7, comments: 1 });
    const rows = h.calls.find((c) => c.table === "reddit_threads")!.payload as Array<Record<string, unknown>>;
    const by = new Map(rows.map((t) => [String(t.url).match(/comments\/([a-z0-9]+)\//)![1], t]));
    expect([...by.entries()].map(([id, t]) => [id, t.removed, t.locked])).toEqual([
      ["ok1", false, false],
      ["rb1", true, false],
      ["rb2", true, false],
      ["rb3", true, false],
      ["rb4", true, false],
      ["ok2", false, false],
      ["lk1", false, true],
    ]);
    expect(by.get("rb2")!.body_excerpt).toBeNull();
    const cm = h.calls.find((c) => c.table === "reddit_comments")!.payload as Array<Record<string, unknown>>;
    expect(cm.map((c) => c.body_excerpt)).toEqual(["real reply"]);
  });

  it("writes community stats under the lowercase name", async () => {
    const h = harness({ ok: true, content: JSON.stringify({ posts: [post("dd4")], comments: [] }) });
    const mixed: SweepJob = { ...(job as Extract<SweepJob, { kind: "subreddit" }>), subreddit: "TuRo" };
    await runSweepJob(T, S, mixed, h.deps);
    expect(h.calls.find((c) => c.table === "reddit_community_stats")!.payload).toMatchObject({ name: "turo" });
  });

  it("keeps counters exact when the recount fails: job counts only, no posts/comments", async () => {
    const h = harness({ ok: true, content: JSON.stringify({ posts: [post("ee5")], comments: [] }) });
    const { db, calls } = fakeDb((c) => {
      if (c.op === "count") return { data: null, error: { message: "timeout" } };
      if (c.table === "reddit_threads") return { data: [{ id: "th0", url: "https://www.reddit.com/r/turo/comments/ee5/" }], error: null };
      if (c.table === "reddit_sweeps") return { data: { status: "running", jobs_done: 0, jobs_failed: 0, communities_scanned: 0 }, error: null };
      if (c.table === "reddit_mentions") return { data: [], error: null };
      return { data: null, error: null };
    });
    await runSweepJob(T, S, job, { ...h.deps, db: () => db });
    expect(calls.find((c) => c.table === "reddit_sweeps" && c.op === "update")!.payload).toEqual({
      jobs_done: 1,
      jobs_failed: 0,
      communities_scanned: 1,
      heartbeat_at: "2026-09-18T12:00:00.000Z",
    });
  });

  it("reports a counter write failure instead of swallowing it, so the sweep cannot finalize as a clean complete", async () => {
    const h = harness({ ok: true, content: JSON.stringify({ posts: [post("ff6")], comments: [] }) });
    const { db } = fakeDb((c) => {
      if (c.table === "reddit_threads") return { data: [{ id: "th0", url: "https://www.reddit.com/r/turo/comments/ff6/" }], error: null };
      if (c.table === "reddit_sweeps" && c.op === "update") return { data: null, error: { message: "write timeout" } };
      if (c.table === "reddit_sweeps") return { data: { status: "running", jobs_done: 0, jobs_failed: 0, communities_scanned: 0 }, error: null };
      if (c.table === "reddit_mentions") return { data: [], error: null };
      return { data: null, error: null };
    });
    const r = await runSweepJob(T, S, job, { ...h.deps, db: () => db });
    expect(r.ok).toBe(true);
    expect(r.counter_error).toMatch(/write timeout/);
  });

  it("marks brand mentions as brand", async () => {
    const h = harness({ ok: true, content: JSON.stringify({ posts: [post("cc3", { title: "Upcar review", body: "" })], comments: [] }) });
    await runSweepJob(T, S, job, h.deps);
    const mentions = h.calls.find((c) => c.table === "reddit_mentions" && c.op === "insert")!.payload as Array<Record<string, unknown>>;
    expect(mentions).toEqual([expect.objectContaining({ term: "Upcar", kind: "brand", keyword_id: "k2" })]);
  });

  it("skips mentions already stored", async () => {
    const h = harness({ ok: true, content: JSON.stringify({ posts: [post("aa1")], comments: [] }) });
    const { db, calls } = fakeDb((c) => {
      if (c.table === "reddit_mentions" && c.op === "select") {
        return { data: [{ thread_id: "th0", comment_id: null, term: "turo" }], error: null };
      }
      if (c.table === "reddit_threads") return { data: [{ id: "th0", url: "https://www.reddit.com/r/turo/comments/aa1/" }], error: null };
      if (c.table === "reddit_sweeps") return { data: { status: "running" }, error: null };
      return { data: null, error: null };
    });
    const r = await runSweepJob(T, S, job, { ...h.deps, db: () => db });
    expect(r.mentions).toBe(1);
    const ins = calls.find((c) => c.table === "reddit_mentions" && c.op === "insert")!.payload as Array<{ term: string }>;
    expect(ins.map((m) => m.term)).toEqual(["rent out my car"]);
  });

  it("treats tool_no_data as zero results, not a failure", async () => {
    const h = harness({ ok: false, content: JSON.stringify({ error: "tool_no_data", message: "none" }) });
    const r = await runSweepJob(T, S, job, h.deps);
    expect(r).toEqual({ ok: true, posts: 0, comments: 0, mentions: 0 });
    const bump = h.calls.find((c) => c.table === "reddit_sweeps" && c.op === "update")!;
    expect(bump.payload).toMatchObject({ jobs_done: 2, jobs_failed: 0 });
    expect(h.calls.find((c) => c.table === "reddit_community_stats")!.payload).not.toHaveProperty("subscribers");
  });

  it("counts a vendor error as a failed job and never throws", async () => {
    const h = harness({ ok: false, content: JSON.stringify({ error: "apify_quota", message: "x" }) });
    const r = await runSweepJob(T, S, job, h.deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("apify_quota");
    const bump = h.calls.find((c) => c.table === "reddit_sweeps" && c.op === "update")!;
    expect(bump.payload).toMatchObject({ jobs_done: 1, jobs_failed: 1, communities_scanned: 0 });
  });

  it("does nothing for a sweep that is no longer running", async () => {
    const h = harness({ ok: true, content: "{}" }, "failed");
    const r = await runSweepJob(T, S, job, h.deps);
    expect(r.error).toBe("sweep_not_running");
    expect(h.apify).not.toHaveBeenCalled();
  });
});

describe("sweepFinalStatus", () => {
  it.each([
    [{ jobs_done: 3, jobs_failed: 0, step_failures: 0 }, "complete"],
    [{ jobs_done: 3, jobs_failed: 1, step_failures: 0 }, "partial"],
    [{ jobs_done: 3, jobs_failed: 0, step_failures: 1 }, "partial"],
    [{ jobs_done: 0, jobs_failed: 3, step_failures: 0 }, "failed"],
    [{ jobs_done: 0, jobs_failed: 0, step_failures: 0 }, "failed"],
  ])("%j → %s", (c, status) => {
    expect(sweepFinalStatus(c).status).toBe(status);
  });

  it("fails a sweep whose jobs ran but read nothing, instead of calling it complete", () => {
    expect(sweepFinalStatus({ jobs_done: 4, jobs_failed: 0, step_failures: 0, items_read: 0 })).toEqual({
      status: "failed",
      error_code: "no_data_returned",
    });
    expect(sweepFinalStatus({ jobs_done: 3, jobs_failed: 1, step_failures: 2, items_read: 0 })).toEqual({
      status: "failed",
      error_code: "no_data_returned",
    });
  });

  it("keeps the job verdict first, and an unknown item count changes nothing", () => {
    expect(sweepFinalStatus({ jobs_done: 0, jobs_failed: 2, step_failures: 0, items_read: 0 })).toEqual({
      status: "failed",
      error_code: "all_jobs_failed",
    });
    expect(sweepFinalStatus({ jobs_done: 4, jobs_failed: 0, step_failures: 0, items_read: null })).toEqual({
      status: "complete",
      error_code: null,
    });
    expect(sweepFinalStatus({ jobs_done: 4, jobs_failed: 0, step_failures: 0, items_read: 1 })).toEqual({
      status: "complete",
      error_code: null,
    });
  });
});

describe("fitSweepJobs + tenantSpend7d", () => {
  it("returns the full plan with no budget figure, and nothing when the budget is negative", () => {
    expect(fitSweepJobs(WS, 12, 2, null)).toEqual(buildSweepJobs(WS, 12));
    expect(fitSweepJobs(WS, 12, 2, -0.5)).toEqual([]);
    expect(fitSweepJobs(WS, 12, 2, 0)).toEqual([]);
  });

  it("picks the largest count whose estimate fits", () => {
    for (let n = 1; n <= 6; n++) {
      const budget = estimateSweepCost(n, 2);
      expect(fitSweepJobs(WS, 12, 2, budget)).toEqual(buildSweepJobs(WS, n));
      expect(fitSweepJobs(WS, 12, 2, budget - 0.0001)).toHaveLength(n - 1);
    }
  });

  it("sums reported cost, falling back to the estimate per row, tenant-scoped over the last 7 days", async () => {
    const { db, calls } = fakeDb(() => ({
      data: [{ cost_usd: "0.3", est_cost_usd: 0.4 }, { cost_usd: null, est_cost_usd: 0.5 }, { cost_usd: null, est_cost_usd: null }, { cost_usd: "x" }],
      error: null,
    }));
    expect(await tenantSpend7d(db, T, new Date("2026-09-18T12:00:00Z"))).toBeCloseTo(0.8, 10);
    expect(calls[0].filters).toEqual([
      ["eq", "tenant_id", T],
      ["gt", "started_at", "2026-09-11T12:00:00.000Z"],
    ]);
  });

  it("is null on a read error, so the caller cannot mistake an outage for an empty week", async () => {
    const { db } = fakeDb(() => ({ data: null, error: { message: "down" } }));
    expect(await tenantSpend7d(db, T, new Date())).toBeNull();
  });
});

describe("sweepCost", () => {
  it("charges the Apify estimate per successful job, capped at the estimate, plus reported spend", () => {
    const row = { est_cost_usd: 1.3, jobs_done: 3, jobs_planned: 4 };
    expect(sweepCost("complete", { ...row, jobs_done: 4 })).toBe(0.16);
    expect(sweepCost("partial", row)).toBe(0.12);
    expect(sweepCost("partial", { ...row, jobs_failed: 1 })).toBe(0.16);
    expect(sweepCost("partial", { ...row, jobs_done: 9 })).toBe(0.16);
    expect(sweepCost("partial", { ...row, jobs_planned: 0 })).toBe(0);
    expect(sweepCost("partial", row, 0.032)).toBe(0.152);
    expect(sweepCost("complete", { ...row, est_cost_usd: 0.1, jobs_done: 4 })).toBe(0.1);
    expect(sweepCost("failed", { ...row, jobs_done: 0 })).toBe(0);
    expect(sweepCost("failed", { ...row, jobs_done: 0, jobs_failed: 4 })).toBe(0.16);
    expect(sweepCost("failed", { ...row, jobs_done: 0 }, 0.008)).toBe(0.008);
    expect(sweepCost("complete", { ...row, est_cost_usd: Number.NaN })).toBe(0);
    expect(sweepCost("complete", { ...row, jobs_done: 4 }, Number.NaN)).toBe(0.16);
  });
});

describe("finalizeSweep", () => {
  const harness = (row: Record<string, unknown>) =>
    fakeDb((c) =>
      c.op === "select"
        ? { data: row, error: null }
        : c.op === "count"
          ? { data: null, error: null, count: c.table === "reddit_threads" ? 31 : 12 }
          : { data: null, error: null },
    );

  it("settles status, cost = Apify share + SERP spend, distinct counts, guarded on running", async () => {
    const { db, calls } = harness({ status: "running", jobs_planned: 4, jobs_done: 4, jobs_failed: 0, est_cost_usd: "1.3000" });
    const r = await finalizeSweep(T, S, { step_failures: 1, spend_usd: 0.032 }, { db: () => db, now: () => new Date("2026-09-18T12:00:00Z") });
    expect(r).toEqual({ status: "partial", posts_scanned: 31 });
    const upd = calls.find((c) => c.op === "update")!;
    expect(upd.payload).toEqual({
      status: "partial",
      error_code: "downstream_step_failed",
      finished_at: "2026-09-18T12:00:00.000Z",
      cost_usd: 0.192,
      posts_scanned: 31,
      comments_scanned: 12,
    });
    expect(upd.filters).toEqual([
      ["eq", "tenant_id", T],
      ["eq", "id", S],
      ["eq", "status", "running"],
    ]);
  });

  it("charges a partial sweep for every job attempted, not only the ones that succeeded", async () => {
    const { db, calls } = harness({ status: "running", jobs_planned: 4, jobs_done: 3, jobs_failed: 1, est_cost_usd: 1.3 });
    await finalizeSweep(T, S, { step_failures: 0 }, { db: () => db });
    expect(calls.find((c) => c.op === "update")!.payload).toMatchObject({ status: "partial", cost_usd: 0.16 });
  });

  it("charges a fully failed sweep for the calls its failed jobs still made", async () => {
    const { db, calls } = harness({ status: "running", jobs_planned: 4, jobs_done: 0, jobs_failed: 4, est_cost_usd: 1.3 });
    expect(await finalizeSweep(T, S, { step_failures: 0 }, { db: () => db })).toMatchObject({ status: "failed" });
    expect(calls.find((c) => c.op === "update")!.payload).toMatchObject({ status: "failed", error_code: "all_jobs_failed", cost_usd: 0.16 });
  });

  it("books the Apify spend and a real status when the DB counters never moved but the worker ran every job", async () => {
    const { db, calls } = harness({ status: "running", jobs_planned: 4, jobs_done: 0, jobs_failed: 0, est_cost_usd: 1.3 });
    const r = await finalizeSweep(T, S, { step_failures: 4, ran: { jobs_done: 4, jobs_failed: 0 } }, { db: () => db });

    expect(r.status).toBe("partial");
    const upd = calls.find((c) => c.op === "update")!.payload as { cost_usd: number; error_code: string };
    expect(upd.cost_usd).toBe(0.16);
    expect(upd.error_code).toBe("downstream_step_failed");
  });

  it("fails a sweep whose jobs all succeeded but stored no posts or comments", async () => {
    const { db, calls } = fakeDb((c) =>
      c.op === "select"
        ? { data: { status: "running", jobs_planned: 4, jobs_done: 4, jobs_failed: 0, est_cost_usd: 1.3 }, error: null }
        : c.op === "count"
          ? { data: null, error: null, count: 0 }
          : { data: null, error: null },
    );
    expect(await finalizeSweep(T, S, { step_failures: 0 }, { db: () => db })).toMatchObject({ status: "failed" });
    expect(calls.find((c) => c.op === "update")!.payload).toMatchObject({
      status: "failed",
      error_code: "no_data_returned",
      posts_scanned: 0,
      comments_scanned: 0,
    });
  });

  it("leaves a closed sweep alone", async () => {
    const { db, calls } = fakeDb(() => ({ data: { status: "failed", jobs_done: 0, jobs_failed: 0, est_cost_usd: 0 }, error: null }));
    expect(await finalizeSweep(T, S, { step_failures: 0 }, { db: () => db })).toEqual({ status: "failed" });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });
});

describe("failRedditSweep", () => {
  const run = async (row: Record<string, unknown> | null) => {
    const { db, calls } = fakeDb((c) => (c.op === "select" ? { data: row, error: null } : { data: null, error: null }));
    await failRedditSweep(T, S, "worker_failed", { db: () => db, now: () => new Date("2026-09-18T12:00:00Z") });
    return calls;
  };

  it("fails a running sweep, charging the estimate prorated by the jobs that ran, tenant-scoped", async () => {
    const calls = await run({ jobs_planned: 4, jobs_done: 1, jobs_failed: 1, est_cost_usd: "1.3000" });
    expect(calls[0].filters).toEqual([
      ["eq", "tenant_id", T],
      ["eq", "id", S],
    ]);
    const upd = calls.find((c) => c.op === "update")!;
    expect(upd.payload).toEqual({
      status: "failed",
      error_code: "worker_failed",
      finished_at: "2026-09-18T12:00:00.000Z",
      cost_usd: 0.65,
    });
    expect(upd.filters).toEqual([
      ["eq", "tenant_id", T],
      ["eq", "id", S],
      ["eq", "status", "running"],
    ]);
  });

  it("charges 0 when nothing ran, and never more than the estimate", async () => {
    expect((await run({ jobs_planned: 4, jobs_done: 0, jobs_failed: 0, est_cost_usd: 1.3 })).find((c) => c.op === "update")!.payload).toMatchObject({ cost_usd: 0 });
    expect((await run({ jobs_planned: 2, jobs_done: 2, jobs_failed: 5, est_cost_usd: 1.3 })).find((c) => c.op === "update")!.payload).toMatchObject({ cost_usd: 1.3 });
    expect((await run(null)).find((c) => c.op === "update")!.payload).toMatchObject({ cost_usd: 0 });
  });
});

describe("parseStoredJobs + loadSweepJobs", () => {
  const admitted = buildSweepJobs(WS, 12);

  it("round-trips the admitted plan through JSON", () => {
    expect(parseStoredJobs(JSON.parse(JSON.stringify(admitted)), admitted.length)).toEqual(admitted);
  });

  it("never returns more than jobs_planned, and rebuilds args instead of trusting them", () => {
    expect(parseStoredJobs(admitted, 2).map((j) => j.key)).toEqual(["sub:turo", "sub:carsharing"]);
    const tampered = [
      { kind: "subreddit", subreddit: "Turo", args: { mode: "subreddit", subreddit: "x", max_items: 5000 } },
      { kind: "subreddit", subreddit: "turo" },
      { kind: "subreddit", subreddit: "bad name!" },
      { kind: "term", term: "x" },
      { kind: "other" },
      null,
      "junk",
      { kind: "term", term: "  rent   out my car " },
    ];
    const jobs = parseStoredJobs(tampered, 10);
    expect(jobs.map((j) => j.key)).toEqual(["sub:turo", "term:rent out my car"]);
    expect(jobs[0].args).toMatchObject({ subreddit: "turo", max_items: 25 });
    expect(parseStoredJobs(null, 5)).toEqual([]);
    expect(parseStoredJobs(admitted, Number.NaN)).toEqual([]);
  });

  it("loads the jobs from the sweep row, tenant-scoped, not from the workspace", async () => {
    const { db, calls } = fakeDb(() => ({ data: { jobs: admitted, jobs_planned: 3 }, error: null }));
    const readWorkspace = vi.fn(async () => WS);
    const jobs = await loadSweepJobs(T, S, { db: () => db, readWorkspace });
    expect(jobs).toEqual(admitted.slice(0, 3));
    expect(readWorkspace).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ table: "reddit_sweeps", filters: [["eq", "tenant_id", T], ["eq", "id", S]] });
    const missing = fakeDb(() => ({ data: null, error: null }));
    expect(await loadSweepJobs(T, S, { db: () => missing.db })).toEqual([]);
    const broken = fakeDb(() => ({ data: null, error: { message: "down" } }));
    await expect(loadSweepJobs(T, S, { db: () => broken.db })).rejects.toThrow(/down/);
  });
});

describe("touchSweep", () => {
  it("bumps heartbeat_at on a running sweep and reports jobs_done", async () => {
    const { db, calls } = fakeDb(() => ({ data: { status: "running", jobs_done: 2 }, error: null }));
    expect(await touchSweep(T, S, { db: () => db, now: () => new Date("2026-09-18T12:00:00Z") })).toEqual({ jobs_done: 2 });
    expect(calls[0]).toMatchObject({
      table: "reddit_sweeps",
      op: "update",
      payload: { heartbeat_at: "2026-09-18T12:00:00.000Z" },
      filters: [["eq", "tenant_id", T], ["eq", "id", S], ["eq", "status", "running"]],
    });
  });

  it("is null once the sweep is closed", async () => {
    const { db } = fakeDb(() => ({ data: null, error: null }));
    expect(await touchSweep(T, S, { db: () => db })).toBeNull();
  });
});

describe("downstream steps", () => {
  const live = (jobsDone: number | null) =>
    fakeDb((c) =>
      c.table === "reddit_sweeps" && c.op === "update"
        ? { data: jobsDone === null ? null : { status: "running", jobs_done: jobsDone }, error: null }
        : { data: null, error: null },
    );

  it("run in order, heartbeat first, and a failure is reported, not thrown", async () => {
    const order: string[] = [];
    const { db, calls } = live(3);
    const steps = downstreamSteps({
      db: () => db,
      score: async () => (order.push("score"), { threads_scored: 0, comments_scored: 0, keyword_ideas: 0, cost_usd: 0 }),
      communityStats: async () => (order.push("community-stats"), 0),
      googleRank: async () => {
        order.push("google-rank");
        throw new Error("vendor down");
      },
      snapshot: async (sb, t) => {
        expect(sb).toBe(db);
        expect(t).toBe(T);
        order.push("snapshot");
      },
    });
    expect(steps.map((s) => [s.id, s.paid])).toEqual([
      ["score", true],
      ["community-stats", false],
      ["google-rank", true],
      ["snapshot", false],
    ]);
    const results = [];
    for (const s of steps) results.push(await runDownstreamStep(s, T, S, { db: () => db }));
    expect(order).toEqual(["score", "community-stats", "google-rank", "snapshot"]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true]);
    expect(results[2].error).toBe("vendor down");
    expect(calls.filter((c) => c.table === "reddit_sweeps" && c.op === "update")).toHaveLength(4);
  });

  it("reports the spend a step made, also when it throws after spending", async () => {
    const { db } = live(1);
    const ok = await runDownstreamStep({ id: "google-rank", paid: true, run: async () => ({ queries: 8, threads_ranked: 1, cost_usd: 0.032 }) }, T, S, { db: () => db });
    expect(ok).toEqual({ ok: true, cost_usd: 0.032 });
    const err = Object.assign(new Error("write failed"), { cost_usd: 0.012 });
    const bad = await runDownstreamStep({ id: "google-rank", paid: true, run: async () => { throw err; } }, T, S, { db: () => db });
    expect(bad).toEqual({ ok: false, cost_usd: 0.012, error: "write failed" });
    const free = await runDownstreamStep({ id: "snapshot", paid: false, run: async () => undefined }, T, S, { db: () => db });
    expect(free).toEqual({ ok: true, cost_usd: 0 });
  });

  it("skips paid steps when no job succeeded, so a failed sweep spends nothing downstream", async () => {
    const { db } = live(0);
    const score = vi.fn(async () => ({ threads_scored: 0, comments_scored: 0, keyword_ideas: 0, cost_usd: 0 }));
    const googleRank = vi.fn(async () => ({ queries: 8, threads_ranked: 0, cost_usd: 0.032 }));
    const communityStats = vi.fn(async () => 0);
    const snapshot = vi.fn(async () => undefined);
    const results = [];
    for (const s of downstreamSteps({ db: () => db, score, googleRank, communityStats, snapshot })) {
      results.push(await runDownstreamStep(s, T, S, { db: () => db }));
    }
    expect(score).not.toHaveBeenCalled();
    expect(googleRank).not.toHaveBeenCalled();
    expect(communityStats).toHaveBeenCalled();
    expect(results.map((r) => r.skipped ?? null)).toEqual(["no_jobs_done", null, "no_jobs_done", null]);
    expect(results.reduce((n, r) => n + r.cost_usd, 0)).toBe(0);
  });

  it("still scores when the jobs ran but their counter writes failed", async () => {
    const { db } = live(0);
    const score = vi.fn(async () => ({ threads_scored: 12, comments_scored: 0, keyword_ideas: 0, cost_usd: 0.07 }));
    const [scoreStep] = downstreamSteps({ db: () => db, score });

    const r = await runDownstreamStep(scoreStep, T, S, { db: () => db }, { jobs_done: 12, jobs_failed: 0 });

    expect(score).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, cost_usd: 0.07 });
  });

  it("skips every step once the sweep is no longer running (stale-killed)", async () => {
    const { db } = live(null);
    const googleRank = vi.fn(async () => ({ queries: 8, threads_ranked: 0, cost_usd: 0.032 }));
    const [, , rank] = downstreamSteps({ db: () => db, googleRank });
    expect(await runDownstreamStep(rank, T, S, { db: () => db })).toEqual({ ok: true, cost_usd: 0, skipped: "sweep_not_running" });
    expect(googleRank).not.toHaveBeenCalled();
  });

  it("a heartbeat DB error is a failed step, not a throw", async () => {
    const { db } = fakeDb(() => ({ data: null, error: { message: "db down" } }));
    const r = await runDownstreamStep({ id: "snapshot", paid: false, run: async () => undefined }, T, S, { db: () => db });
    expect(r).toMatchObject({ ok: false, cost_usd: 0 });
  });
});

describe("listSweepableTenants", () => {
  it("pages past PostgREST's 1000-row cap and dedupes tenants across the three fields", async () => {
    const rows = [
      ...Array.from({ length: 2500 }, (_, i) => ({ field_id: "keywords", tenant_id: `t${String(i).padStart(4, "0")}` })),
      { field_id: "communities", tenant_id: "t0001" },
      { field_id: "communities", tenant_id: "zz" },
    ];
    const ranges: Array<[string, number, number]> = [];
    const fields: unknown[] = [];
    const eqs: Array<[string, unknown]> = [];
    const db = {
      from: (table: string) => {
        let from = 0;
        let to = 0;
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => (eqs.push([c, v]), b),
          in: (c: string, v: unknown) => (c === "field_id" && fields.push(v), b),
          order: () => b,
          range: (f: number, t: number) => ((from = f), (to = t), ranges.push([table, f, t]), b),
          then: (res: (r: Res) => unknown) => {
            const all = table === "channel_settings" ? rows : [];
            return Promise.resolve({ data: all.slice(from, Math.min(to + 1, from + TENANT_LIST_PAGE)), error: null }).then(res);
          },
        };
        return b;
      },
    } as unknown as SupabaseClient;
    const ids = await listSweepableTenants({ db: () => db });
    expect(ids).toHaveLength(2501);
    expect(ids[0]).toBe("t0000");
    expect(ids).toContain("t2499");
    expect(ids).toContain("zz");
    expect(ranges.filter(([t]) => t === "channel_settings").map(([, f]) => f)).toEqual([0, 1000, 2000]);
    expect(eqs).toContainEqual(["channel_slug", "reddit_organic"]);
    expect(eqs).toContainEqual(["status", "tracking"]);
    expect(fields[0]).toEqual(["keywords", "competitors", "communities"]);
  });

  it("throws on a read error so the cron step retries", async () => {
    const { db } = fakeDb(() => ({ data: null, error: { message: "db down" } }));
    const withRange = { from: (t: string) => Object.assign(db.from(t), { range() { return this; } }) } as unknown as SupabaseClient;
    await expect(listSweepableTenants({ db: () => withRange })).rejects.toThrow(/tenant list failed/);
  });
});
