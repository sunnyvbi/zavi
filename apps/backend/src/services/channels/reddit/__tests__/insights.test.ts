import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  facts: vi.fn(),
  numbers: {} as Record<string, number>,
  enabled: true,
}));

vi.mock("@/services/settings", () => ({
  getNumberSetting: vi.fn(async (key: string) => mocks.numbers[key] ?? 0),
  getBoolSetting: vi.fn(async () => mocks.enabled),
}));
vi.mock("@/services/company/facts", () => ({ getCompanyFacts: mocks.facts }));

import { buildRedditInsights, redditPostId, termRegex, writeMetricSnapshot } from "../insights";
import { minimalSweepEstimate } from "../sweep";

const T = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-09-18T12:00:00.000Z";

type Row = Record<string, unknown>;

const asTime = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
const cmp = (a: unknown, b: unknown) => {
  const x = asTime(a) as number | string;
  const y = asTime(b) as number | string;
  return x < y ? -1 : x > y ? 1 : 0;
};

const MAX_ROWS = 1000;

function fakeSb(tables: Record<string, Row[]>, failTable?: string) {
  const calls: Array<{ table: string; tenantFiltered: boolean; ordered: boolean; ranged: boolean }> = [];
  const upserts: Array<{ table: string; row: Row; opts: unknown }> = [];
  const sb = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const call = { table, tenantFiltered: false, ordered: false, ranged: false };
      calls.push(call);
      const orders: Array<[string, boolean]> = [];
      let slice: [number, number] | null = null;
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: (k: string, v: unknown) => {
          if (k === "tenant_id") call.tenantFiltered = true;
          rows = rows.filter((r) => r[k] === v);
          return chain;
        },
        gte: (k: string, v: unknown) => {
          rows = rows.filter((r) => r[k] != null && cmp(r[k], v) >= 0);
          return chain;
        },
        lte: (k: string, v: unknown) => {
          rows = rows.filter((r) => r[k] != null && cmp(r[k], v) <= 0);
          return chain;
        },
        in: (k: string, vs: unknown[]) => {
          rows = rows.filter((r) => vs.includes(r[k]));
          return chain;
        },
        order: (k: string, o?: { ascending?: boolean }) => {
          call.ordered = true;
          orders.push([k, o?.ascending !== false]);
          return chain;
        },
        limit: (n: number) => {
          slice = [0, n];
          return chain;
        },
        range: (from: number, to: number) => {
          call.ranged = true;
          slice = [from, to + 1];
          return chain;
        },
        upsert: async (row: Row, opts: unknown) => {
          upserts.push({ table, row, opts });
          return { error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === failTable) return resolve({ data: null, error: { message: "missing" } });
          const out = [...rows].sort((a, b) => {
            for (const [k, asc] of orders) {
              const c = cmp(a[k], b[k]);
              if (c) return asc ? c : -c;
            }
            return 0;
          });
          const [from, to] = slice ?? [0, out.length];
          return resolve({ data: out.slice(from, Math.min(to, from + MAX_ROWS)), error: null });
        },
      });
      return chain;
    },
  };
  return { sb: sb as never, calls, upserts };
}

const SETTINGS_DEFAULTS = {
  tenant_id: T,
  channel_slug: "reddit_organic",
  item_type: null as string | null,
  status: null as string | null,
  position: 0,
  note: null as string | null,
  origin: "custom",
  detail: null as string | null,
  updated_at: "2026-09-01T00:00:00.000Z",
  updated_by: null as string | null,
};
const kw = (id: string, term: string, type: string, status: string, position = 0) => ({
  ...SETTINGS_DEFAULTS,
  id,
  field_id: "keywords",
  item: term,
  item_type: type,
  status,
  position,
});
const competitor = (
  id: string,
  name: string,
  o: { domain?: string | null; origin?: string; status: string; position: number },
) => ({
  ...SETTINGS_DEFAULTS,
  id,
  field_id: "competitors",
  item: name,
  detail: o.domain ?? null,
  origin: o.origin ?? "custom",
  status: o.status,
  position: o.position,
});
const community = (name: string, selected: boolean, rules_verdict: string | null, position = 0) => ({
  ...SETTINGS_DEFAULTS,
  id: `c-${name}`,
  field_id: "communities",
  item: name,
  item_type: rules_verdict,
  status: selected ? "tracking" : "paused",
  position,
});
const thread = (id: string, o: Row) => ({
  id,
  tenant_id: T,
  url: `https://www.reddit.com/r/${o.subreddit}/comments/${id}/slug/`,
  title: `Thread ${id}`,
  body_excerpt: null,
  score: 5,
  comment_count: 3,
  posted_at: o.first_seen_at,
  locked: false,
  removed: false,
  matched_terms: [],
  last_seen_at: o.first_seen_at,
  relevance_why: null,
  is_question: true,
  google_rank: null,
  google_query: null,
  google_checked_at: null,
  draft_text: null,
  draft_state: null,
  ...o,
});
const mention = (id: string, o: Row) => ({
  id,
  tenant_id: T,
  keyword_id: null,
  competitor_id: null,
  sentiment: null,
  ...o,
});

const channelAction = (
  id: string,
  status: string,
  run: string,
  proposed: string,
  url: string,
  content: string,
  snoozed_until: string | null = null,
) => ({
  id,
  tenant_id: T,
  channel_slug: "reddit_organic",
  run_id: run,
  position: 1,
  run_of: 1,
  status,
  snoozed_until,
  proposed_at: proposed,
  body: { step: { deliverable: { content, presentation: { type: "reddit_reply", thread_url: url } } } },
});

function withDraftableThread(f: Record<string, Row[]>): Record<string, Row[]> {
  f.reddit_threads = [
    ...f.reddit_threads,
    thread("t10", { subreddit: "smallbusiness", post_relevance: 85, first_seen_at: "2026-09-18T02:04:00.000Z" }),
  ];
  return f;
}

const decision = (id: string, status: string, run: string, emitted: string, url: string, content: string) => ({
  id,
  tenant_id: T,
  status,
  decision_class: "channel.recipe_step",
  agent_run_id: run,
  emitted_at: emitted,
  body: { step: { deliverable: { content, presentation: { type: "reddit_reply", thread_url: url } } } },
});

function fixture(): Record<string, Row[]> {
  return {
    channel_settings: [
      kw("k-brand", "Acme", "brand", "tracking", 0),
      kw("k-kw", "invoice software", "problem", "tracking", 1),
      kw("k-sug", "late payments", "problem", "suggested", 2),
      kw("k-sug2", "late pay", "problem", "suggested", 3),
      kw("k-dis", "dismissed term", "problem", "dismissed", 4),
      competitor("c1", "Rival", { domain: "rival.com", status: "tracking", position: 0 }),
      competitor("c2", "Other", { origin: "suggested", status: "suggested", position: 1 }),
      competitor("c3", "Paused Co", { status: "paused", position: 2 }),
      community("smallbusiness", true, "allowed", 0),
      community("banned_sub", false, "banned", 1),
      community("freelance", true, null, 2),
    ],
    reddit_sweeps: [
      { id: "s1", tenant_id: T, status: "complete", trigger: "manual", started_at: "2026-09-18T02:00:00.000Z", finished_at: "2026-09-18T02:10:00.000Z", posts_scanned: 40, comments_scanned: 100, communities_scanned: 2, error_code: null, est_cost_usd: 0.5, cost_usd: null },
      { id: "s2", tenant_id: T, status: "complete", trigger: "cron", started_at: "2026-09-15T13:00:00.000Z", finished_at: "2026-09-15T13:10:00.000Z", posts_scanned: 30, comments_scanned: 20, communities_scanned: 2, error_code: null, est_cost_usd: 0.4, cost_usd: "0.3" },
      { id: "s-old", tenant_id: T, status: "complete", trigger: "cron", started_at: "2026-09-01T13:00:00.000Z", finished_at: null, posts_scanned: 9, comments_scanned: 9, communities_scanned: 9, error_code: null, est_cost_usd: 5, cost_usd: null },
      { id: "s-x", tenant_id: OTHER, status: "running", trigger: "manual", started_at: "2026-09-18T11:00:00.000Z", finished_at: null, posts_scanned: 999, comments_scanned: 999, communities_scanned: 9, error_code: null, est_cost_usd: 2, cost_usd: null },
    ],
    reddit_threads: [
      thread("t1", { subreddit: "smallbusiness", post_relevance: 90, first_seen_at: "2026-09-18T02:05:00.000Z", title: "How do I chase late payments?", google_rank: 4, google_query: "invoice software", google_checked_at: "2026-09-18T02:09:00.000Z" }),
      thread("t2", { subreddit: "smallbusiness", post_relevance: 70, first_seen_at: "2026-09-14T13:00:00.000Z", last_seen_at: "2026-09-17T13:00:00.000Z", google_checked_at: "2026-09-17T13:05:00.000Z" }),
      thread("t3", { subreddit: "banned_sub", post_relevance: 95, first_seen_at: "2026-09-16T13:00:00.000Z" }),
      thread("t4", { subreddit: "freelance", post_relevance: 80, is_question: false, first_seen_at: "2026-09-18T02:06:00.000Z" }),
      thread("t5", { subreddit: "freelance", post_relevance: 65, locked: true, first_seen_at: "2026-09-17T13:00:00.000Z" }),
      thread("t6", { subreddit: "smallbusiness", post_relevance: 50, first_seen_at: "2026-09-17T13:00:00.000Z" }),
      thread("t7", { subreddit: "freelance", post_relevance: 40, first_seen_at: "2026-09-08T13:00:00.000Z", body_excerpt: "Late Payments are killing me" }),
      thread("t8", { subreddit: "smallbusiness", post_relevance: 65, first_seen_at: "2026-09-17T13:00:00.000Z", draft_text: "What worked for me was a short reminder on day three.", draft_state: "drafted" }),
      thread("t9", { subreddit: "smallbusiness", post_relevance: 99, first_seen_at: "2026-09-17T13:00:00.000Z", draft_state: "dismissed" }),
      { ...thread("tx", { subreddit: "smallbusiness", post_relevance: 99, first_seen_at: "2026-09-18T03:00:00.000Z" }), tenant_id: OTHER },
    ],
    reddit_comments: [
      { id: "cm1", tenant_id: T, thread_id: "t2", comment_relevance: 40, first_seen_at: "2026-09-18T02:07:00.000Z", last_sweep_id: "s1" },
      { id: "cm3", tenant_id: T, thread_id: "t4", comment_relevance: 75, first_seen_at: "2026-09-18T02:07:00.000Z", last_sweep_id: "s1" },
      { id: "cm-old", tenant_id: T, thread_id: "t2", comment_relevance: 70, first_seen_at: "2026-09-01T02:07:00.000Z", last_sweep_id: "s1" },
      { id: "cm-stale", tenant_id: T, thread_id: "t2", comment_relevance: 95, first_seen_at: "2026-09-01T02:07:00.000Z", last_sweep_id: "s-old" },
      { id: "cmx", tenant_id: OTHER, thread_id: "tx", comment_relevance: 99, first_seen_at: "2026-09-18T03:00:00.000Z", last_sweep_id: "s1" },
    ],
    reddit_mentions: [
      mention("m1", { thread_id: "t1", term: "Acme", kind: "brand", keyword_id: "k-brand", subreddit: "smallbusiness", sentiment: "positive", observed_at: "2026-09-17T10:00:00.000Z" }),
      mention("m2", { thread_id: "t2", term: "acme", kind: "brand", keyword_id: "k-brand", subreddit: "smallbusiness", observed_at: "2026-09-14T10:00:00.000Z" }),
      mention("m3", { thread_id: "t7", term: "Acme", kind: "brand", keyword_id: "k-brand", subreddit: "freelance", observed_at: "2026-09-06T10:00:00.000Z" }),
      mention("m4", { thread_id: "t2", term: "Rival", kind: "competitor", competitor_id: "c1", subreddit: "smallbusiness", sentiment: "negative", observed_at: "2026-09-15T10:00:00.000Z" }),
      mention("m5", { thread_id: "t1", term: "Rival", kind: "competitor", competitor_id: "c1", subreddit: "smallbusiness", sentiment: "neutral", observed_at: "2026-09-16T10:00:00.000Z" }),
      mention("m6", { thread_id: "t4", term: "rival", kind: "competitor", competitor_id: "c1", subreddit: "freelance", observed_at: "2026-09-17T10:00:00.000Z" }),
      mention("m7", { thread_id: "t1", term: "invoice software", kind: "keyword", keyword_id: "k-kw", subreddit: "smallbusiness", observed_at: "2026-09-18T01:00:00.000Z" }),
      mention("m8", { thread_id: "t1", term: "Paused Co", kind: "competitor", competitor_id: "c3", subreddit: "smallbusiness", sentiment: "positive", observed_at: "2026-09-17T10:00:00.000Z" }),
      { ...mention("mx", { thread_id: "tx", term: "Acme", kind: "brand", subreddit: "smallbusiness", observed_at: "2026-09-18T01:00:00.000Z" }), tenant_id: OTHER },
    ],
    reddit_community_stats: [
      { tenant_id: T, name: "smallbusiness", relevance: 72, relevance_why: "12 of 25 relevant", subscribers: 2000000, posts_per_day: 25, posts_per_day_capped: true },
      { tenant_id: T, name: "freelance", relevance: 55, relevance_why: null, subscribers: 500000, posts_per_day: 8, posts_per_day_capped: false },
      { tenant_id: T, name: "entrepreneur", relevance: 64, relevance_why: null, subscribers: null, posts_per_day: null, posts_per_day_capped: false },
      { tenant_id: T, name: "banned_sub", relevance: 99, relevance_why: null, subscribers: null, posts_per_day: null, posts_per_day_capped: false },
      { tenant_id: OTHER, name: "secret", relevance: 100, relevance_why: null, subscribers: null, posts_per_day: null, posts_per_day_capped: false },
    ],
    reddit_metric_snapshots: [
      { tenant_id: T, day: "2026-09-11", reply_opportunities: 1, posts_relevant: 9, comments_relevant: 9 },
      { tenant_id: T, day: "2026-09-17", reply_opportunities: 5, posts_relevant: 3, comments_relevant: 0 },
      { tenant_id: OTHER, day: "2026-09-17", reply_opportunities: 50, posts_relevant: 50, comments_relevant: 50 },
    ],
    agent_runs: [
      { id: "run-new", tenant_id: T, agent_slug: "reddit_organic", enqueued_at: "2026-09-18T01:00:00.000Z" },
      { id: "run-old", tenant_id: T, agent_slug: "reddit_organic", enqueued_at: "2026-09-10T01:00:00.000Z" },
      { id: "run-seo", tenant_id: T, agent_slug: "seo", enqueued_at: "2026-09-18T02:00:00.000Z" },
    ],
    decisions: [
      decision("d1", "proposed", "run-new", "2026-09-18T01:05:00.000Z", "https://old.reddit.com/r/smallbusiness/comments/T1/?utm=x", "Full disclosure, I work on Acme. What worked for us was a polite day-3 reminder."),
      decision("d-rej", "rejected", "run-new", "2026-09-18T01:06:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t2/", "A rejected draft must never show on the card."),
      decision("d-old", "acted", "run-old", "2026-09-10T01:05:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t2/", "An older draft for t2 that the founder already approved."),
      decision("d-seo", "proposed", "run-seo", "2026-09-18T02:05:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t1/", "Another agent's decision must not attach here."),
    ],
    channel_actions: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  mocks.numbers = { reddit_relevance_threshold: 60, reddit_sweep_tenant_cap_usd_7d: 3 };
  mocks.enabled = true;
  mocks.facts.mockReset().mockResolvedValue({ name: "Acme Inc", website: "https://www.acme.com/", competitors: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("buildRedditInsights", () => {
  it("computes every KPI from the fixture rows", async () => {
    const { sb, calls } = fakeSb(fixture());
    const r = await buildRedditInsights(sb, T);

    expect(r.has_data).toBe(true);
    expect(r.threshold).toBe(60);
    expect(r.today).toEqual({ posts_scanned: 2, communities_scanned: 2, posts_relevant: 2 });
    expect(r.kpis.brand_mentions).toEqual({ value: 2, previous: 1, brand_terms: 1, scanned: 1 });
    expect(r.kpis.reply_opportunities).toEqual({ value: 3, previous: 1, on_google: { ranked: 1, of: 2 } });
    expect(r.kpis.relevant_posts).toEqual({ value: 2, previous: 3, scanned: 2 });
    expect(r.kpis.relevant_comments).toEqual({ value: 2, previous: 0, scanned: 3 });
    expect(r.kpis.subreddits).toEqual({ value: 2, top: { name: "smallbusiness", relevance: 72 } });

    expect(calls.every((c) => c.tenantFiltered)).toBe(true);
  });

  it("lists the rows behind the KPI cards with the same windows as the counts", async () => {
    const r = await buildRedditInsights(fakeSb(fixture()).sb, T);
    expect(r.lists.brand_mentions).toHaveLength(r.kpis.brand_mentions.value);
    const times = r.lists.brand_mentions.map((m) => Date.parse(m.observed_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(r.lists.relevant_posts).toHaveLength(r.kpis.relevant_posts.value);
    expect(r.lists.relevant_comments).toHaveLength(r.kpis.relevant_comments.value);
    for (const list of [r.lists.relevant_posts.map((p) => p.relevance), r.lists.relevant_comments.map((c) => c.relevance)]) {
      expect([...list].sort((a, b) => b - a)).toEqual(list);
      expect(list.every((v) => v >= r.threshold)).toBe(true);
    }
  });

  it("ranks opportunities by post + best comment relevance, excluding dismissed threads", async () => {
    const r = await buildRedditInsights(fakeSb(fixture()).sb, T);
    expect(r.opportunities.map((o) => [o.thread_id, o.post_relevance, o.comment_relevance])).toEqual([
      ["t2", 70, 70],
      ["t1", 90, null],
      ["t8", 65, null],
    ]);
    expect(r.opportunities.map((o) => o.thread_id)).not.toContain("t9");
    expect(r.opportunities[0].google).toEqual({ checked: true, rank: null, query: null });
    expect(r.opportunities[1].google).toEqual({ checked: true, rank: 4, query: "invoice software" });
  });

  it("emits only canonical thread links: normalizes a stored variant, drops a row with no thread link from cards and lists", async () => {
    const f = fixture();
    const seen = "2026-09-18T09:00:00.000Z";
    f.reddit_threads.push(
      thread("tvar", { subreddit: "smallbusiness", post_relevance: 95, first_seen_at: seen, url: "https://old.reddit.com/r/SmallBusiness/comments/TVAR/slug/lk9/?utm_source=share" }),
      thread("tbad", { subreddit: "smallbusiness", post_relevance: 99, first_seen_at: seen, url: "https://techcrunch.com/story" }),
    );
    const before = (await buildRedditInsights(fakeSb(fixture()).sb, T)).kpis.reply_opportunities.value;
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    const ids = r.opportunities.map((o) => o.thread_id);
    expect(ids).toContain("tvar");
    expect(ids).not.toContain("tbad");
    expect(r.kpis.reply_opportunities.value).toBe(before + 1);
    expect(r.opportunities.find((o) => o.thread_id === "tvar")!.url).toBe("https://www.reddit.com/r/smallbusiness/comments/tvar/");
    const links = [
      ...r.opportunities.map((o) => o.url),
      ...r.lists.relevant_posts.map((p) => p.url),
      ...r.lists.relevant_comments.map((c) => c.url),
      ...r.lists.brand_mentions.map((m) => m.url),
      ...r.competitors.map((c) => c.latest_thread?.url).filter((u): u is string => !!u),
    ];
    expect(links.length).toBeGreaterThan(0);
    for (const u of links) expect(u).toMatch(/^https:\/\/www\.reddit\.com\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+\/$/);
    expect(r.lists.relevant_posts.map((p) => p.thread_id)).not.toContain("tbad");
  });

  it("caps opportunities at 50", async () => {
    const f = fixture();
    for (let i = 0; i < 60; i++)
      f.reddit_threads.push(thread(`bulk${i}`, { subreddit: "smallbusiness", post_relevance: 61, first_seen_at: "2026-09-17T10:00:00.000Z" }));
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    expect(r.opportunities).toHaveLength(50);
    expect(r.kpis.reply_opportunities.value).toBe(63);
  });

  it("attaches drafts: Zavi's own first, else the newest run draft across recent runs by post id", async () => {
    const r = await buildRedditInsights(fakeSb(fixture()).sb, T);
    const by = Object.fromEntries(r.opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by.t1).toEqual({ text: expect.stringContaining("day-3 reminder"), source: "run", state: "proposed", decision_id: "d1", action_source: "decision", rule_status: null });
    expect(by.t2).toEqual({ text: expect.stringContaining("already approved"), source: "run", state: "posted", decision_id: "d-old", action_source: "decision", rule_status: null });
    expect(by.t8).toEqual({ text: expect.stringContaining("day three"), source: "zavi", state: "drafted", decision_id: null, action_source: null, rule_status: null });
  });

  it("drops a thread the founder marked Done from the list and the count, and shows no draft when none exists", async () => {
    const f = fixture();
    const before = (await buildRedditInsights(fakeSb(f).sb, T)).kpis.reply_opportunities.value;
    f.reddit_threads = f.reddit_threads.map((t) => (t.id === "t1" ? { ...t, draft_state: "posted" } : t));
    f.decisions = f.decisions.filter((d) => d.id !== "d-old");
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    const by = Object.fromEntries(r.opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by).not.toHaveProperty("t1");
    expect(r.kpis.reply_opportunities.value).toBe(before - 1);
    expect(by.t2).toBeNull();
  });

  it("reads a run's drafts from channel_actions, the store reddit_organic writes to now", async () => {
    const f = withDraftableThread(fixture());
    f.channel_actions = [
      channelAction("ca-1", "pending", "run-new", "2026-09-18T01:07:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t10/", "A draft that only exists in the new store."),
    ];
    const by = Object.fromEntries((await buildRedditInsights(fakeSb(f).sb, T)).opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by.t10).toEqual({
      text: expect.stringContaining("only exists in the new store"),
      source: "run",
      state: "proposed",
      decision_id: "ca-1",
      action_source: "channel_action",
      rule_status: null,
    });
  });

  it("does not show a closed channel action as a draft to approve", async () => {
    const f = withDraftableThread(fixture());
    f.channel_actions = [
      channelAction("ca-rej", "rejected", "run-new", "2026-09-18T01:07:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t10/", "A rejected draft must never show on the card."),
      channelAction("ca-stale", "stale", "run-new", "2026-09-18T01:08:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t10/", "A stale draft must never show on the card."),
    ];
    const by = Object.fromEntries((await buildRedditInsights(fakeSb(f).sb, T)).opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by.t10).toBeNull();
  });

  it("does not resurface a card the founder hid with Not now", async () => {
    const f = withDraftableThread(fixture());
    f.channel_actions = [
      channelAction(
        "ca-snoozed",
        "snoozed",
        "run-new",
        "2026-09-18T01:07:00.000Z",
        "https://www.reddit.com/r/smallbusiness/comments/t10/",
        "A draft the founder pushed to next week.",
        "2026-09-25T00:00:00.000Z",
      ),
    ];
    const by = Object.fromEntries((await buildRedditInsights(fakeSb(f).sb, T)).opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by.t10).toBeNull();
  });

  it("shows a snooze that has run out, and one with no readable date", async () => {
    const f = withDraftableThread(fixture());
    f.channel_actions = [
      channelAction(
        "ca-due",
        "snoozed",
        "run-new",
        "2026-09-18T01:07:00.000Z",
        "https://www.reddit.com/r/smallbusiness/comments/t10/",
        "A draft whose snooze has run out.",
        "2026-09-17T00:00:00.000Z",
      ),
    ];
    const due = Object.fromEntries((await buildRedditInsights(fakeSb(f).sb, T)).opportunities.map((o) => [o.thread_id, o.draft]));
    expect(due.t10?.decision_id).toBe("ca-due");

    const g = withDraftableThread(fixture());
    g.channel_actions = [
      channelAction(
        "ca-dateless",
        "snoozed",
        "run-new",
        "2026-09-18T01:07:00.000Z",
        "https://www.reddit.com/r/smallbusiness/comments/t10/",
        "A snooze with no date at all.",
        null,
      ),
    ];
    const dateless = Object.fromEntries((await buildRedditInsights(fakeSb(g).sb, T)).opportunities.map((o) => [o.thread_id, o.draft]));
    expect(dateless.t10?.decision_id).toBe("ca-dateless");
  });

  it("lets the newest draft win across both stores, not the store it came from", async () => {
    const f = fixture();
    f.channel_actions = [
      channelAction("ca-new", "pending", "run-new", "2026-09-18T01:09:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t1/", "The newer draft, written after the switch."),
    ];
    const by = Object.fromEntries((await buildRedditInsights(fakeSb(f).sb, T)).opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by.t1).toEqual({
      text: expect.stringContaining("after the switch"),
      source: "run",
      state: "proposed",
      decision_id: "ca-new",
      action_source: "channel_action",
      rule_status: null,
    });
  });

  it("keeps a run draft's community-rule verdict so a prohibited reply cannot be posted", async () => {
    const f = withDraftableThread(fixture());
    const banned = channelAction("ca-banned", "pending", "run-new", "2026-09-18T01:07:00.000Z", "https://www.reddit.com/r/smallbusiness/comments/t10/", "A reply this community's rules do not allow.");
    banned.body.step.deliverable.presentation = { ...banned.body.step.deliverable.presentation, rule_status: "not_allowed" } as typeof banned.body.step.deliverable.presentation;
    f.channel_actions = [banned];
    const by = Object.fromEntries((await buildRedditInsights(fakeSb(f).sb, T)).opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by.t10?.rule_status).toBe("not_allowed");
  });

  it("does not read an archived run draft (acted + archived_at = 'I did not do it') as posted", async () => {
    const f = fixture();
    f.decisions = f.decisions.map((d) => (d.id === "d-old" ? { ...d, archived_at: "2026-09-17T10:00:00.000Z" } : d));
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    const by = Object.fromEntries(r.opportunities.map((o) => [o.thread_id, o.draft]));
    expect(by.t2).toBeNull();
  });

  it("counts only checked threads for on_google, null when none is checked", async () => {
    const f = fixture();
    f.reddit_threads = f.reddit_threads.map((t) => (t.id === "t2" ? { ...t, google_checked_at: null } : t));
    expect((await buildRedditInsights(fakeSb(f).sb, T)).kpis.reply_opportunities.on_google).toEqual({ ranked: 1, of: 1 });

    f.reddit_threads = f.reddit_threads.map((t) => (t.id === "t1" ? { ...t, google_rank: 11 } : t));
    expect((await buildRedditInsights(fakeSb(f).sb, T)).kpis.reply_opportunities.on_google).toEqual({ ranked: 0, of: 1 });
  });

  it("lists selected communities first, then the rest by relevance; never recommends a banned one", async () => {
    const r = await buildRedditInsights(fakeSb(fixture()).sb, T);
    expect(r.communities.map((c) => [c.name, c.relevance, c.saved, c.selected, c.recommended, c.reply_opportunities])).toEqual([
      ["smallbusiness", 72, true, true, true, 3],
      ["freelance", 55, true, true, false, 0],
      ["banned_sub", 99, true, false, false, 0],
      ["entrepreneur", 64, false, false, false, 0],
    ]);
    expect(r.communities[0]).toMatchObject({ posts_per_day: 25, posts_per_day_capped: true, rules_verdict: "allowed" });
    expect(r.communities.map((c) => c.name)).not.toContain("secret");

    mocks.numbers.reddit_relevance_threshold = 80;
    const high = await buildRedditInsights(fakeSb(fixture()).sb, T);
    expect(high.communities.some((c) => c.recommended)).toBe(false);
    expect(high.kpis.subreddits.top).toEqual({ name: "smallbusiness", relevance: 72 });
  });

  it("merges saved names with lowercase stats names and puts nulls last among selected", async () => {
    const f = fixture();
    f.channel_settings = [
      ...f.channel_settings.filter((r) => r.field_id !== "communities"),
      community("SmallBusiness", true, "allowed", 0),
      community("NewSub", true, null, 1),
    ];
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    expect(r.communities.slice(0, 2).map((c) => [c.name, c.relevance, c.selected])).toEqual([
      ["SmallBusiness", 72, true],
      ["NewSub", null, true],
    ]);
    expect(r.communities.filter((c) => c.name.toLowerCase() === "smallbusiness")).toHaveLength(1);
  });

  it("fills keyword stats for tracked (mention rows) and suggested (whole-word text match) keywords", async () => {
    const r = await buildRedditInsights(fakeSb(fixture()).sb, T);
    expect(r.keyword_stats["k-kw"]).toEqual({ mentions_7d: 1, mentions_prev_7d: 0, top_subreddit: "smallbusiness", matches_today: 1 });
    expect(r.keyword_stats["k-brand"]).toEqual({ mentions_7d: 2, mentions_prev_7d: 1, top_subreddit: "smallbusiness", matches_today: 0 });
    expect(r.keyword_stats["k-sug"]).toEqual({ mentions_7d: 1, mentions_prev_7d: 1, top_subreddit: "smallbusiness", matches_today: 1 });
    expect(r.keyword_stats["k-sug2"]).toEqual({ mentions_7d: 0, mentions_prev_7d: 0, top_subreddit: null, matches_today: 0 });
    expect(r.keyword_stats).not.toHaveProperty("k-dis");
  });

  it("builds competitor rows (tracked, paused and suggested, never the company) and share of voice summing to 1", async () => {
    const r = await buildRedditInsights(fakeSb(fixture()).sb, T);
    expect(r.competitors.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(r.competitors.map((c) => c.status)).toEqual(["tracking", "suggested", "paused"]);
    expect(r.competitors[1]).toMatchObject({ name: "Other", mentions_7d: 0, sentiment: null, latest_thread: null });
    expect(r.competitors.every((c) => !c.is_you)).toBe(true);
    const [rival, , paused] = r.competitors;
    expect(rival).toMatchObject({
      name: "Rival",
      domain: "rival.com",
      mentions_7d: 3,
      mentions_prev_7d: 0,
      sentiment: { positive: 0, neutral: 1, negative: 1, sample: 2 },
      top_subreddits: ["smallbusiness", "freelance"],
      latest_thread: { url: expect.stringContaining("/comments/t4/") },
    });
    expect(paused).toMatchObject({ name: "Paused Co", mentions_7d: 1, sentiment: { positive: 1, neutral: 0, negative: 0, sample: 1 } });
    expect(r.share_of_voice.total_mentions).toBe(4);
    expect(r.share_of_voice.items.map((i) => [i.name, i.share, i.is_you])).toEqual([
      ["Rival", 0.75, false],
      ["Paused Co", 0.25, false],
    ]);
    expect(r.share_of_voice.items.reduce((n, i) => n + i.share, 0)).toBeCloseTo(1, 10);
  });

  it("reports the sweep budget (exhausted when the next sweep would not fit), last sweep and freshness", async () => {
    const r = await buildRedditInsights(fakeSb(fixture()).sb, T);
    expect(r.sweep.enabled).toBe(true);
    expect(r.sweep.last).toMatchObject({ id: "s1", status: "complete", posts_scanned: 40, error_code: null });
    expect(r.sweep.budget).toEqual({ used_usd_7d: 0.8, cap_usd_7d: 3, remaining_usd: 2.2, exhausted: false });
    expect(r.sweep.stale).toBe(false);

    const oneJob = minimalSweepEstimate(1);
    expect(oneJob).toBeGreaterThan(0);
    mocks.numbers.reddit_sweep_tenant_cap_usd_7d = Math.round((0.8 + oneJob) * 10000) / 10000;
    const fits = (await buildRedditInsights(fakeSb(fixture()).sb, T)).sweep.budget;
    expect(fits.remaining_usd).toBeCloseTo(oneJob, 4);
    expect(fits.exhausted).toBe(false);

    mocks.numbers.reddit_sweep_tenant_cap_usd_7d = Math.round((0.8 + oneJob - 0.0001) * 10000) / 10000;
    expect((await buildRedditInsights(fakeSb(fixture()).sb, T)).sweep.budget.exhausted).toBe(true);

    mocks.numbers.reddit_sweep_tenant_cap_usd_7d = 0.5;
    expect((await buildRedditInsights(fakeSb(fixture()).sb, T)).sweep.budget).toEqual({
      used_usd_7d: 0.8,
      cap_usd_7d: 0.5,
      remaining_usd: 0,
      exhausted: true,
    });

    mocks.numbers.reddit_sweep_tenant_cap_usd_7d = 3;
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    expect((await buildRedditInsights(fakeSb(fixture()).sb, T)).sweep.stale).toBe(true);
  });

  it("reports a sweep with no heartbeat for over an hour as failed/stale_running so the UI unlocks", async () => {
    const f = fixture();
    const running = { ...f.reddit_sweeps[0], id: "s-run", status: "running", finished_at: null, error_code: null };
    f.reddit_sweeps.push({ ...running, started_at: "2026-09-18T10:30:00.000Z", heartbeat_at: "2026-09-18T10:50:00.000Z" });
    const stuck = await buildRedditInsights(fakeSb(f).sb, T);
    expect(stuck.sweep.last).toMatchObject({ id: "s-run", status: "failed", error_code: "stale_running" });

    f.reddit_sweeps[f.reddit_sweeps.length - 1].heartbeat_at = "2026-09-18T11:40:00.000Z";
    const slow = await buildRedditInsights(fakeSb(f).sb, T);
    expect(slow.sweep.last).toMatchObject({ id: "s-run", status: "running", error_code: null });
  });

  it("counts a tracked keyword that is also a competitor name from the competitor-kind rows", async () => {
    const f = fixture();
    f.channel_settings.push(kw("k-rival", "RIVAL", "competitor", "tracking", 5));
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    expect(r.keyword_stats["k-rival"]).toEqual({ mentions_7d: 3, mentions_prev_7d: 0, top_subreddit: "smallbusiness", matches_today: 0 });
    expect(r.keyword_stats["k-kw"].mentions_7d).toBe(1);
  });

  it("shows the comment's author for a brand mention made in a comment", async () => {
    const f = fixture();
    f.reddit_threads = f.reddit_threads.map((t) => (t.id === "t1" ? { ...t, author: "post_author" } : t));
    f.reddit_comments.push(
      { id: "cm-brand", tenant_id: T, thread_id: "t1", author: "comment_author", comment_relevance: null, first_seen_at: "2026-09-01T00:00:00.000Z", last_sweep_id: "s-old" },
      { id: "cm-foreign", tenant_id: OTHER, thread_id: "tx", author: "other_tenant_author", comment_relevance: null, first_seen_at: "2026-09-18T00:00:00.000Z", last_sweep_id: null },
    );
    f.reddit_mentions.push(
      mention("m-c", { thread_id: "t1", comment_id: "cm-brand", term: "Acme", kind: "brand", keyword_id: "k-brand", subreddit: "smallbusiness", observed_at: "2026-09-18T05:00:00.000Z" }),
      mention("m-f", { thread_id: "t1", comment_id: "cm-foreign", term: "acme inc", kind: "brand", keyword_id: "k-brand", subreddit: "smallbusiness", observed_at: "2026-09-18T04:00:00.000Z" }),
    );
    const { sb, calls } = fakeSb(f);
    const r = await buildRedditInsights(sb, T);
    const rows = r.lists.brand_mentions.map((m) => [m.observed_at, m.author]);
    expect(rows.slice(0, 3)).toEqual([
      ["2026-09-18T05:00:00.000Z", "comment_author"],
      ["2026-09-18T04:00:00.000Z", null],
      ["2026-09-17T10:00:00.000Z", "post_author"],
    ]);
    expect(calls.every((c) => c.tenantFiltered)).toBe(true);
  });

  it("pages every large read past PostgREST's 1000-row cap", async () => {
    const f = fixture();
    for (let i = 0; i < 2500; i++) {
      const id = `p${String(i).padStart(4, "0")}`;
      f.reddit_threads.push(thread(id, { subreddit: "smallbusiness", post_relevance: 61, first_seen_at: "2026-09-17T09:00:00.000Z" }));
      f.reddit_comments.push({ id: `c${id}`, tenant_id: T, thread_id: id, comment_relevance: 10, first_seen_at: "2026-09-17T09:00:00.000Z", last_sweep_id: null });
      for (const n of [0, 1])
        f.reddit_mentions.push(mention(`m${id}-${n}`, { thread_id: id, term: "Acme", kind: "brand", keyword_id: "k-brand", subreddit: "smallbusiness", observed_at: "2026-09-10T09:00:00.000Z" }));
    }
    const { sb, calls } = fakeSb(f);
    const r = await buildRedditInsights(sb, T);
    expect(r.kpis.reply_opportunities.value).toBe(2503);
    expect(r.opportunities.every((o) => o.thread_id.startsWith("p") ? o.comment_relevance === 10 : true)).toBe(true);
    expect(r.kpis.brand_mentions.previous).toBe(5001);
    for (const table of ["reddit_threads", "reddit_comments", "reddit_mentions"]) {
      const reads = calls.filter((c) => c.table === table && c.ranged);
      expect(reads.length).toBeGreaterThan(1);
      expect(reads.every((c) => c.ordered)).toBe(true);
    }
  });

  it("keeps the overall row caps when paging", async () => {
    const f = fixture();
    for (let i = 0; i < 3200; i++)
      f.reddit_threads.push(thread(`q${String(i).padStart(4, "0")}`, { subreddit: "smallbusiness", post_relevance: 61, first_seen_at: "2026-09-17T09:00:00.000Z" }));
    const { sb, calls } = fakeSb(f);
    const r = await buildRedditInsights(sb, T);
    expect(calls.filter((c) => c.table === "reddit_threads").length).toBe(3);
    expect(r.kpis.reply_opportunities.value).toBeLessThanOrEqual(3000);
  });

  it("has_data only once a complete or partial sweep exists", async () => {
    const f = fixture();
    f.reddit_sweeps = [{ ...f.reddit_sweeps[0], status: "failed", error_code: "enqueue_failed" }];
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    expect(r.has_data).toBe(false);
    expect(r.sweep.last).toMatchObject({ status: "failed" });

    expect(r.kpis.brand_mentions.scanned).toBe(0);

    f.reddit_sweeps[0].status = "partial";
    const partial = await buildRedditInsights(fakeSb(f).sb, T);
    expect(partial.has_data).toBe(true);
    expect(partial.kpis.brand_mentions.scanned).toBe(1);
  });

  it("shows null deltas and no Google claim when there are no snapshots or checks", async () => {
    const f = fixture();
    f.reddit_metric_snapshots = [];
    f.reddit_threads = f.reddit_threads.map((t) => ({ ...t, google_checked_at: null, google_rank: null }));
    const r = await buildRedditInsights(fakeSb(f).sb, T);
    expect(r.kpis.reply_opportunities.previous).toBeNull();
    expect(r.kpis.reply_opportunities.on_google).toBeNull();
    expect(r.kpis.relevant_posts.previous).toBeNull();
    expect(r.kpis.relevant_comments.previous).toBeNull();
  });

  it("is an honest empty state for a tenant with no sweeps", async () => {
    const r = await buildRedditInsights(fakeSb({}).sb, T);
    expect(r.has_data).toBe(false);
    expect(r.sweep).toEqual({ enabled: true, last: null, budget: { used_usd_7d: 0, cap_usd_7d: 3, remaining_usd: 3, exhausted: false }, stale: true });
    expect(r.kpis.brand_mentions.scanned).toBe(0);
    expect(r.share_of_voice).toEqual({ window_days: 7, total_mentions: 0, items: [] });
    expect(r.competitors).toEqual([]);
    expect(r.opportunities).toEqual([]);
    expect(r.today).toEqual({ posts_scanned: 0, communities_scanned: 0, posts_relevant: 0 });
    expect(r.kpis.subreddits).toEqual({ value: 0, top: null });
  });

  it("throws when a sweep table read fails, so callers can degrade", async () => {
    await expect(buildRedditInsights(fakeSb({}, "reddit_threads").sb, T)).rejects.toThrow(/threads read failed/);
  });
});

describe("writeMetricSnapshot", () => {
  it("upserts today's row with the panel formulas", async () => {
    const { sb, upserts } = fakeSb(fixture());
    await writeMetricSnapshot(sb, T);
    expect(upserts).toEqual([
      {
        table: "reddit_metric_snapshots",
        opts: { onConflict: "tenant_id,day" },
        row: {
          tenant_id: T,
          day: "2026-09-18",
          brand_mentions_7d: 2,
          reply_opportunities: 3,
          posts_scanned: 2,
          posts_relevant: 2,
          comments_scanned: 3,
          comments_relevant: 2,
          subreddits_tracked: 2,
          top_subreddit: "smallbusiness",
          top_subreddit_relevance: 72,
        },
      },
    ]);
  });

  it("computes a past day with windows ending that day", async () => {
    const { sb, upserts } = fakeSb(fixture());
    await writeMetricSnapshot(sb, T, "2026-09-15");
    expect(upserts[0].row).toMatchObject({
      day: "2026-09-15",
      brand_mentions_7d: 1,
    });
  });
});

describe("termRegex", () => {
  it("matches whole words, case-insensitively, across whitespace", () => {
    expect(termRegex("late pay")!.test("Late payments")).toBe(false);
    expect(termRegex("late payments")!.test("chasing LATE\n payments today")).toBe(true);
    expect(termRegex("c++")!.test("I use c++ daily")).toBe(true);
    expect(termRegex("   ")).toBeNull();
  });
});

describe("redditPostId", () => {
  it("matches permalink variants by post id", () => {
    expect(redditPostId("https://old.reddit.com/r/x/comments/AbC12/title/?utm=1")).toBe("abc12");
    expect(redditPostId("https://www.reddit.com/r/x/comments/abc12")).toBe("abc12");
    expect(redditPostId("https://example.com/r/x/comments/abc12")).toBeNull();
    expect(redditPostId(null)).toBeNull();
  });
});
