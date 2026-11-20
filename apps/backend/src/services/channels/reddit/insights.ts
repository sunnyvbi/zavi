import type { SupabaseClient } from "@supabase/supabase-js";
import { redditCopyIssue } from "@/agents/lib/channel-recipe-step";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import { isOpenAction } from "@/services/channels/rank-actions";
import { stripItemIds } from "./item-ids";
import { readRedditWorkspace, type RedditWorkspace } from "./workspace";
import { canonicalRedditUrl, firstRedditThreadUrl, redditPostId } from "./permalink";
import type { RedditInsights, RedditSweepStatus, Sentiment } from "./insights-types";
import { minimalSweepEstimate } from "./sweep";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const MAX_SWEEPS = 500;
const MAX_THREADS = 3000;
const MAX_COMMENTS = 5000;
const MAX_MENTIONS = 10000;
const MAX_STATS = 5000;

type SweepRow = RedditSweepStatus & {
  heartbeat_at: string | null;
  est_cost_usd: number | string | null;
  cost_usd: number | string | null;
};

type ThreadRow = {
  id: string;
  url: string;
  author: string | null;
  subreddit: string;
  title: string;
  body_excerpt: string | null;
  score: number | null;
  comment_count: number | null;
  posted_at: string | null;
  locked: boolean | null;
  removed: boolean | null;
  matched_terms: string[] | null;
  first_seen_at: string;
  last_seen_at: string;
  post_relevance: number | null;
  relevance_why: string | null;
  is_question: boolean | null;
  sentiment: Sentiment | null;
  google_rank: number | null;
  google_query: string | null;
  google_checked_at: string | null;
  draft_text: string | null;
  draft_state: "drafted" | "posted" | "dismissed" | null;
};

type CommentRow = {
  id: string;
  thread_id: string;
  author: string | null;
  body_excerpt: string | null;
  score: number | null;
  matched_terms: string[] | null;
  comment_relevance: number | null;
  sentiment: Sentiment | null;
  first_seen_at: string;
  last_sweep_id: string | null;
};

type MentionRow = {
  id: string;
  thread_id: string;
  comment_id: string | null;
  term: string;
  kind: "brand" | "competitor" | "keyword";
  keyword_id: string | null;
  competitor_id: string | null;
  subreddit: string;
  sentiment: Sentiment | null;
  observed_at: string;
};

type StatsRow = {
  name: string;
  relevance: number | null;
  relevance_why: string | null;
  subscribers: number | null;
  posts_per_day: number | null;
  posts_per_day_capped: boolean | null;
};

type SnapshotRow = {
  day: string;
  reply_opportunities: number;
  posts_relevant: number;
  comments_relevant: number;
};

const SWEEP_COLS =
  "id, status, trigger, started_at, finished_at, heartbeat_at, posts_scanned, comments_scanned, communities_scanned, error_code, est_cost_usd, cost_usd";
const THREAD_COLS =
  "id, url, author, subreddit, title, body_excerpt, score, comment_count, posted_at, locked, removed, matched_terms, first_seen_at, last_seen_at, post_relevance, relevance_why, is_question, sentiment, google_rank, google_query, google_checked_at, draft_text, draft_state";
const COMMENT_COLS =
  "id, thread_id, author, body_excerpt, score, matched_terms, comment_relevance, sentiment, first_seen_at, last_sweep_id";
const MENTION_COLS = "id, thread_id, comment_id, term, kind, keyword_id, competitor_id, subreddit, sentiment, observed_at";
const STATS_COLS = "name, relevance, relevance_why, subscribers, posts_per_day, posts_per_day_capped";

type Clock = {
  now: number;
  todayStart: number;
  ago7: number;
  ago14: number;
  day: string;
};

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function clockFor(day?: string): Clock {
  const real = Date.now();
  const todayStart = day ? Date.parse(`${day}T00:00:00.000Z`) : Math.floor(real / DAY) * DAY;
  if (!Number.isFinite(todayStart)) throw new Error(`invalid snapshot day: ${day}`);
  const now = Math.min(real, todayStart + DAY - 1);
  return { now, todayStart, ago7: now - 7 * DAY, ago14: now - 14 * DAY, day: dayKey(todayStart) };
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const inRange = (iso: string | null | undefined, from: number, to: number) => {
  const t = ms(iso);
  return t >= from && t <= to;
};
const lower = (s: string) => s.trim().toLowerCase();
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function check<T>(res: { data: T[] | null; error: { message?: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`reddit insights: ${what} read failed: ${res.error.message ?? "error"}`);
  return res.data ?? [];
}

const PAGE = 1000;

type PageResult = PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>;

async function readAll<T>(page: (from: number, to: number) => PageResult, cap: number, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const to = Math.min(from + PAGE, cap) - 1;
    const rows = check<T>((await page(from, to)) as never, what);
    out.push(...rows);
    if (rows.length < to - from + 1) break;
  }
  return out;
}

type Loaded = {
  clock: Clock;
  threshold: number;
  workspace: RedditWorkspace;
  sweeps: SweepRow[];
  lastSweep: SweepRow | null;
  threads: ThreadRow[];
  comments: CommentRow[];
  todaySweepIds: Set<string>;
  mentions: MentionRow[];
  stats: StatsRow[];
};

async function load(sb: SupabaseClient, tenantId: string, clock: Clock): Promise<Loaded> {
  const nowIso = new Date(clock.now).toISOString();
  const ago7 = new Date(clock.ago7).toISOString();
  const [threshold, workspace, sweeps, lastRes, threads, commentRows, mentions, stats] = await Promise.all([
    getNumberSetting("reddit_relevance_threshold", tenantId),
    readRedditWorkspace(sb, tenantId),
    readAll<SweepRow>(
      (from, to) =>
        sb
          .from("reddit_sweeps")
          .select(SWEEP_COLS)
          .eq("tenant_id", tenantId)
          .gte("started_at", ago7)
          .lte("started_at", nowIso)
          .order("started_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SWEEPS,
      "sweeps",
    ),
    sb
      .from("reddit_sweeps")
      .select(SWEEP_COLS)
      .eq("tenant_id", tenantId)
      .lte("started_at", nowIso)
      .order("started_at", { ascending: false })
      .limit(1),
    readAll<ThreadRow>(
      (from, to) =>
        sb
          .from("reddit_threads")
          .select(THREAD_COLS)
          .eq("tenant_id", tenantId)
          .gte("last_seen_at", new Date(clock.ago14).toISOString())
          .order("last_seen_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      MAX_THREADS,
      "threads",
    ),
    readAll<CommentRow>(
      (from, to) =>
        sb
          .from("reddit_comments")
          .select(COMMENT_COLS)
          .eq("tenant_id", tenantId)
          .gte("first_seen_at", ago7)
          .order("first_seen_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      MAX_COMMENTS,
      "comments",
    ),
    readAll<MentionRow>(
      (from, to) =>
        sb
          .from("reddit_mentions")
          .select(MENTION_COLS)
          .eq("tenant_id", tenantId)
          .gte("observed_at", new Date(clock.ago14).toISOString())
          .order("observed_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      MAX_MENTIONS,
      "mentions",
    ),
    readAll<StatsRow>(
      (from, to) =>
        sb
          .from("reddit_community_stats")
          .select(STATS_COLS)
          .eq("tenant_id", tenantId)
          .order("name", { ascending: true })
          .range(from, to),
      MAX_STATS,
      "community stats",
    ),
  ]);
  const last = check<SweepRow>(lastRes as never, "last sweep")[0] ?? null;
  const todaySweepIds = new Set(
    sweeps.filter((s) => inRange(s.started_at, clock.todayStart, clock.now)).map((s) => s.id),
  );
  const comments = new Map(commentRows.map((c) => [c.id, c]));
  if (todaySweepIds.size > 0) {
    const reread = await readAll<CommentRow>(
      (from, to) =>
        sb
          .from("reddit_comments")
          .select(COMMENT_COLS)
          .eq("tenant_id", tenantId)
          .in("last_sweep_id", [...todaySweepIds])
          .order("first_seen_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      MAX_COMMENTS,
      "comments",
    );
    for (const c of reread) comments.set(c.id, c);
  }
  return {
    clock,
    threshold,
    workspace,
    sweeps,
    todaySweepIds,
    lastSweep: last,
    threads: threads
      .filter((t) => ms(t.first_seen_at) <= clock.now)
      .map((t) => ({ ...t, url: canonicalRedditUrl(t.url) ?? "" })),
    comments: [...comments.values()].filter((c) => ms(c.first_seen_at) <= clock.now),
    mentions: mentions.filter((m) => ms(m.observed_at) <= clock.now),
    stats,
  };
}

function bannedSet(ws: RedditWorkspace): Set<string> {
  return new Set(ws.communities.filter((c) => c.rules_verdict === "banned").map((c) => lower(c.name)));
}

function bestCommentByThread(comments: CommentRow[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const c of comments) {
    if (c.comment_relevance === null || c.comment_relevance === undefined) continue;
    best.set(c.thread_id, Math.max(best.get(c.thread_id) ?? 0, c.comment_relevance));
  }
  return best;
}

function rankOpportunities(d: Loaded): Array<{ thread: ThreadRow; best: number | null; rank: number }> {
  const banned = bannedSet(d.workspace);
  const best = bestCommentByThread(d.comments);
  return d.threads
    .filter(
      (t) =>
        inRange(t.last_seen_at, d.clock.ago7, d.clock.now) &&
        (t.post_relevance ?? -1) >= d.threshold &&
        t.is_question === true &&
        hasLink(t) &&
        t.locked !== true &&
        t.removed !== true &&
        t.draft_state !== "dismissed" &&
        t.draft_state !== "posted" &&
        !banned.has(lower(t.subreddit)),
    )
    .map((thread) => {
      const b = best.has(thread.id) ? (best.get(thread.id) as number) : null;
      return { thread, best: b, rank: (thread.post_relevance ?? 0) + (b ?? 0) };
    })
    .sort((a, b) => b.rank - a.rank || ms(b.thread.last_seen_at) - ms(a.thread.last_seen_at));
}

const hasLink = (t: { url: string }) => t.url !== "";

function topCommunityStat(stats: StatsRow[], banned: Set<string>): { name: string; relevance: number } | null {
  let top: { name: string; relevance: number } | null = null;
  for (const s of stats) {
    if (s.relevance === null || s.relevance === undefined || banned.has(lower(s.name))) continue;
    if (!top || s.relevance > top.relevance) top = { name: s.name, relevance: s.relevance };
  }
  return top;
}

type Core = {
  brandMentions7d: number;
  brandMentionsPrev: number;
  replyOpportunities: number;
  postsScannedToday: number;
  commentsScannedToday: number;
  communitiesScannedToday: number;
  postsRelevantToday: number;
  commentsRelevantToday: number;
  subredditsTracked: number;
  top: { name: string; relevance: number } | null;
};

function core(d: Loaded): Core {
  const { clock, threshold } = d;
  const brand = d.mentions.filter((m) => m.kind === "brand");
  const threadsToday = d.threads.filter((t) => inRange(t.last_seen_at, clock.todayStart, clock.now));
  const commentsToday = d.comments.filter(
    (c) =>
      (c.last_sweep_id !== null && d.todaySweepIds.has(c.last_sweep_id)) ||
      inRange(c.first_seen_at, clock.todayStart, clock.now),
  );
  return {
    brandMentions7d: brand.filter((m) => inRange(m.observed_at, clock.ago7, clock.now)).length,
    brandMentionsPrev: brand.filter((m) => inRange(m.observed_at, clock.ago14, clock.ago7 - 1)).length,
    replyOpportunities: rankOpportunities(d).length,
    postsScannedToday: threadsToday.length,
    commentsScannedToday: commentsToday.length,
    communitiesScannedToday: new Set(threadsToday.map((t) => lower(t.subreddit))).size,
    postsRelevantToday: threadsToday.filter((t) => (t.post_relevance ?? -1) >= threshold).length,
    commentsRelevantToday: commentsToday.filter((c) => (c.comment_relevance ?? -1) >= threshold).length,
    subredditsTracked: d.workspace.communities.filter((c) => c.selected).length,
    top: topCommunityStat(d.stats, bannedSet(d.workspace)),
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function termRegex(term: string): RegExp | null {
  const body = term.split(/\s+/).filter(Boolean).map(escapeRegex).join("\\s+");
  if (!body) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
}

function countBy<T>(items: T[], key: (t: T) => string): Array<[string, number]> {
  const counts = new Map<string, { label: string; n: number }>();
  for (const it of items) {
    const label = key(it);
    const k = lower(label);
    const cur = counts.get(k);
    if (cur) cur.n++;
    else counts.set(k, { label, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).map((c) => [c.label, c.n]);
}

export { redditPostId };

type RunDraft = {
  decision_id: string;
  action_source: "decision" | "channel_action";
  body: string;
  state: "proposed" | "posted";
  rule_status: "ready" | "verify_manually" | "not_allowed" | null;
};

const DRAFT_RUNS = 5;

const PROPOSED_STATUSES = ["proposed"] as const;
const POSTED_STATUSES = ["approved", "dispatching", "dispatched", "acted"] as const;

const CHANNEL_ACTION_OPEN = ["pending", "snoozed"] as const;
const CHANNEL_ACTION_POSTED = ["acted"] as const;

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

type DraftRow = {
  id: string;
  at: string;
  body: Record<string, unknown> | null;
  posted: boolean;
  action_source: "decision" | "channel_action";
};

async function loadRunDrafts(sb: SupabaseClient, tenantId: string): Promise<Map<string, RunDraft>> {
  const drafts = new Map<string, RunDraft>();
  try {
    const runs = await sb
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("agent_slug", "reddit_organic")
      .order("enqueued_at", { ascending: false })
      .limit(DRAFT_RUNS);
    const runIds = ((runs.data as Array<{ id?: unknown }> | null) ?? []).map((r) => text(r.id)).filter((x): x is string => !!x);
    if (runs.error || runIds.length === 0) return drafts;
    const [legacy, current] = await Promise.all([
      sb
        .from("decisions")
        .select("id, body, status, emitted_at, agent_run_id, archived_at")
        .eq("tenant_id", tenantId)
        .eq("decision_class", "channel.recipe_step")
        .in("agent_run_id", runIds)
        .in("status", [...PROPOSED_STATUSES, ...POSTED_STATUSES])
        .order("emitted_at", { ascending: false })
        .limit(250),
      sb
        .from("channel_actions")
        .select("id, body, status, proposed_at, run_id, snoozed_until")
        .eq("tenant_id", tenantId)
        .in("run_id", runIds)
        .in("status", [...CHANNEL_ACTION_OPEN, ...CHANNEL_ACTION_POSTED])
        .order("proposed_at", { ascending: false })
        .limit(250),
    ]);
    const rows: DraftRow[] = [];
    if (!legacy.error && Array.isArray(legacy.data)) {
      for (const row of legacy.data as Array<{ id: string; status: string; emitted_at: string; body: Record<string, unknown> | null; archived_at?: string | null }>) {
        if (row.archived_at) continue;
        rows.push({ id: row.id, at: row.emitted_at, body: row.body, posted: row.status !== "proposed", action_source: "decision" });
      }
    }
    if (!current.error && Array.isArray(current.data)) {
      const now = Date.now();
      for (const row of current.data as Array<{ id: string; status: string; proposed_at: string; body: Record<string, unknown> | null; snoozed_until?: string | null }>) {
        const posted = (CHANNEL_ACTION_POSTED as readonly string[]).includes(row.status);
        if (!posted && !isOpenAction({ status: row.status, snoozed_until: text(row.snoozed_until) }, now)) {
          continue;
        }
        rows.push({
          id: row.id,
          at: row.proposed_at,
          body: row.body,
          posted,
          action_source: "channel_action",
        });
      }
    }
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const row of rows) {
      const step = (row.body ?? {}).step as Record<string, unknown> | undefined;
      const deliverable = step?.deliverable as Record<string, unknown> | undefined;
      const body = text(deliverable?.content);
      if (!body || redditCopyIssue(body)) continue;
      const presentation = deliverable?.presentation as Record<string, unknown> | undefined;
      let url: string | null = null;
      if (presentation?.type === "reddit_reply") url = text(presentation.thread_url);
      else if (!presentation && deliverable?.kind === "comment") {
        const evidence = Array.isArray(step?.evidence) ? step.evidence : [];
        const context = [step?.title, step?.body, deliverable?.label, ...evidence].map(text).filter(Boolean).join(" ");
        url = firstRedditThreadUrl(context);
      }
      const id = redditPostId(url);
      const state = row.posted ? "posted" : "proposed";
      const rule = text(presentation?.rule_status);
      const rule_status = rule === "ready" || rule === "verify_manually" || rule === "not_allowed" ? rule : null;
      if (id && !drafts.has(id)) drafts.set(id, { decision_id: row.id, action_source: row.action_source, body, state, rule_status });
    }
  } catch {
  }
  return drafts;
}

function draftFor(
  t: ThreadRow,
  runDrafts: Map<string, RunDraft>,
  banned: Set<string>,
): RedditInsights["opportunities"][number]["draft"] {
  const own = text(t.draft_text);
  if (own) {
    return {
      text: own,
      source: "zavi",
      state: t.draft_state ?? "drafted",
      decision_id: null,
      action_source: null,
      rule_status: banned.has(lower(t.subreddit)) ? "not_allowed" : null,
    };
  }
  const run = runDrafts.get(redditPostId(t.url) ?? "");
  if (!run) return null;
  return {
    text: run.body,
    source: "run",
    state: t.draft_state === "posted" ? "posted" : run.state,
    decision_id: run.decision_id,
    action_source: run.action_source,
    rule_status: run.rule_status,
  };
}

async function loadSnapshots(sb: SupabaseClient, tenantId: string, clock: Clock): Promise<Map<string, SnapshotRow>> {
  const d7 = dayKey(clock.todayStart - 7 * DAY);
  const d1 = dayKey(clock.todayStart - DAY);
  const res = await sb
    .from("reddit_metric_snapshots")
    .select("day, reply_opportunities, posts_relevant, comments_relevant")
    .eq("tenant_id", tenantId)
    .in("day", [d7, d1]);
  const rows = check<SnapshotRow>(res as never, "snapshots");
  return new Map(rows.map((r) => [String(r.day).slice(0, 10), r]));
}

const STUCK_AFTER_MS = 60 * 60 * 1000;
const OPPORTUNITY_LIMIT = 50;
const COMMUNITY_LIMIT = 10;

async function hasFinishedSweep(sb: SupabaseClient, tenantId: string): Promise<boolean> {
  const res = await sb
    .from("reddit_sweeps")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("status", ["complete", "partial"])
    .limit(1);
  return check<{ id: string }>(res as never, "finished sweep").length > 0;
}

export async function buildRedditInsights(sb: SupabaseClient, tenantId: string): Promise<RedditInsights> {
  const clock = clockFor();
  const [d, snapshots, runDrafts, enabled, cap, finished] = await Promise.all([
    load(sb, tenantId, clock),
    loadSnapshots(sb, tenantId, clock),
    loadRunDrafts(sb, tenantId),
    getBoolSetting("reddit_sweep_enabled", tenantId),
    getNumberSetting("reddit_sweep_tenant_cap_usd_7d", tenantId),
    hasFinishedSweep(sb, tenantId),
  ]);
  const c = core(d);
  const snap7 = snapshots.get(dayKey(clock.todayStart - 7 * DAY)) ?? null;
  const snap1 = snapshots.get(dayKey(clock.todayStart - DAY)) ?? null;
  const ws = d.workspace;
  const banned = bannedSet(ws);
  const threadById = new Map(d.threads.map((t) => [t.id, t]));
  const in7 = (iso: string | null) => inRange(iso, clock.ago7, clock.now);
  const inPrev = (iso: string | null) => inRange(iso, clock.ago14, clock.ago7 - 1);
  const isToday = (iso: string | null) => inRange(iso, clock.todayStart, clock.now);

  const ranked = rankOpportunities(d);
  const opportunities: RedditInsights["opportunities"] = ranked.slice(0, OPPORTUNITY_LIMIT).map(({ thread: t, best }) => ({
    thread_id: t.id,
    url: t.url,
    subreddit: t.subreddit,
    title: t.title,
    posted_at: t.posted_at,
    score: t.score,
    comment_count: t.comment_count,
    post_relevance: t.post_relevance ?? 0,
    comment_relevance: best,
    relevance_why: stripItemIds(t.relevance_why),
    matched_terms: t.matched_terms ?? [],
    google: { checked: !!t.google_checked_at, rank: t.google_rank, query: t.google_query },
    draft: draftFor(t, runDrafts, banned),
  }));
  const checked7 = ranked.slice(0, 7).map((r) => r.thread).filter((t) => t.google_checked_at);
  const on_google = checked7.length
    ? { ranked: checked7.filter((t) => t.google_rank !== null && t.google_rank <= 10).length, of: checked7.length }
    : null;

  const oppsBySub = new Map<string, number>();
  for (const r of ranked) oppsBySub.set(lower(r.thread.subreddit), (oppsBySub.get(lower(r.thread.subreddit)) ?? 0) + 1);
  const saved = new Map(ws.communities.map((m) => [lower(m.name), m]));
  const statsByName = new Map(d.stats.map((s) => [lower(s.name), s]));
  const names = new Map<string, string>();
  for (const s of d.stats) names.set(lower(s.name), s.name);
  for (const m of ws.communities) names.set(lower(m.name), m.name);
  const communitiesAll = [...names.entries()].map(([key, name]) => {
    const s = statsByName.get(key);
    const m = saved.get(key);
    return {
      name,
      relevance: s?.relevance ?? null,
      relevance_why: s?.relevance_why ?? null,
      subscribers: s?.subscribers ?? null,
      posts_per_day: s?.posts_per_day ?? null,
      posts_per_day_capped: s?.posts_per_day_capped === true,
      rules_verdict: m?.rules_verdict ?? null,
      selected: m?.selected ?? false,
      saved: !!m,
      recommended: false,
      reply_opportunities: oppsBySub.get(key) ?? 0,
    };
  });
  communitiesAll.sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) ||
      (b.relevance ?? -1) - (a.relevance ?? -1) ||
      a.name.localeCompare(b.name),
  );
  const communities = communitiesAll.slice(0, COMMUNITY_LIMIT);
  let rec: (typeof communities)[number] | null = null;
  for (const x of communities) {
    if (banned.has(lower(x.name)) || x.relevance === null || x.relevance < d.threshold) continue;
    if (!rec || x.relevance > (rec.relevance ?? -1)) rec = x;
  }
  if (rec) rec.recommended = true;

  const keyword_stats: RedditInsights["keyword_stats"] = {};
  const threads7 = d.threads.filter((t) => in7(t.last_seen_at));
  const threadsPrev = d.threads.filter((t) => inPrev(t.last_seen_at));
  for (const k of ws.keywords) {
    if (k.status === "dismissed") continue;
    const term = lower(k.term);
    if (k.status === "suggested") {
      const re = termRegex(k.term);
      const hit = (t: ThreadRow) => !!re && re.test(`${t.title}\n${t.body_excerpt ?? ""}`);
      const hits7 = threads7.filter(hit);
      keyword_stats[k.id] = {
        mentions_7d: hits7.length,
        mentions_prev_7d: threadsPrev.filter(hit).length,
        top_subreddit: countBy(hits7, (t) => t.subreddit)[0]?.[0] ?? null,
        matches_today: d.threads.filter((t) => isToday(t.last_seen_at) && hit(t)).length,
      };
      continue;
    }
    const mine = d.mentions.filter((m) =>
      m.kind === "competitor"
        ? lower(m.term) === term
        : m.keyword_id === k.id || (!m.keyword_id && lower(m.term) === term),
    );
    const m7 = mine.filter((m) => in7(m.observed_at));
    keyword_stats[k.id] = {
      mentions_7d: m7.length,
      mentions_prev_7d: mine.filter((m) => inPrev(m.observed_at)).length,
      top_subreddit: countBy(m7, (m) => m.subreddit)[0]?.[0] ?? null,
      matches_today: mine.filter((m) => isToday(m.observed_at)).length,
    };
  }

  const summarize = (
    mentions: MentionRow[],
    head: { id: string; name: string; domain: string | null },
  ): RedditInsights["competitors"][number] => {
    const m7 = mentions.filter((m) => in7(m.observed_at));
    const withSentiment = m7.filter((m) => m.sentiment);
    const sentiment = withSentiment.length
      ? {
          positive: withSentiment.filter((m) => m.sentiment === "positive").length,
          neutral: withSentiment.filter((m) => m.sentiment === "neutral").length,
          negative: withSentiment.filter((m) => m.sentiment === "negative").length,
          sample: withSentiment.length,
        }
      : null;
    const latestMention = [...m7].sort((a, b) => ms(b.observed_at) - ms(a.observed_at)).find((m) => {
      const t = threadById.get(m.thread_id);
      return !!t && hasLink(t);
    });
    const lt = latestMention ? threadById.get(latestMention.thread_id)! : null;
    return {
      ...head,
      is_you: false,
      mentions_7d: m7.length,
      mentions_prev_7d: mentions.filter((m) => inPrev(m.observed_at)).length,
      sentiment,
      top_subreddits: countBy(m7, (m) => m.subreddit)
        .slice(0, 3)
        .map(([s]) => s),
      latest_thread: lt
        ? { title: lt.title, url: lt.url, subreddit: lt.subreddit, posted_at: lt.posted_at, seen_at: lt.last_seen_at }
        : null,
    };
  };
  const summarizeFromText = (
    name: string,
    head: { id: string; name: string; domain: string | null; status: NonNullable<RedditInsights["competitors"][number]["status"]> },
  ): RedditInsights["competitors"][number] => {
    const re = termRegex(name);
    const hitThread = (t: ThreadRow) => !!re && re.test(`${t.title}\n${t.body_excerpt ?? ""}`);
    const hits7 = threads7.filter(hitThread);
    const commentHits = d.comments.filter(
      (c) => !!re && !!c.body_excerpt && re.test(c.body_excerpt) && in7(c.first_seen_at) && threadById.has(c.thread_id),
    );
    const subredditOf = (c: CommentRow) => threadById.get(c.thread_id)!.subreddit;
    const tones = [...hits7.map((t) => t.sentiment), ...commentHits.map((c) => c.sentiment)].filter(
      (x): x is Sentiment => !!x,
    );
    const latest = [...hits7].sort((a, b) => ms(b.posted_at ?? b.last_seen_at) - ms(a.posted_at ?? a.last_seen_at)).find(hasLink) ?? null;
    return {
      ...head,
      is_you: false,
      mentions_7d: hits7.length + commentHits.length,
      mentions_prev_7d: threadsPrev.filter(hitThread).length,
      sentiment: tones.length
        ? {
            positive: tones.filter((x) => x === "positive").length,
            neutral: tones.filter((x) => x === "neutral").length,
            negative: tones.filter((x) => x === "negative").length,
            sample: tones.length,
          }
        : null,
      top_subreddits: countBy([...hits7.map((t) => t.subreddit), ...commentHits.map(subredditOf)], (x) => x)
        .slice(0, 3)
        .map(([s]) => s),
      latest_thread: latest
        ? { title: latest.title, url: latest.url, subreddit: latest.subreddit, posted_at: latest.posted_at, seen_at: latest.last_seen_at }
        : null,
    };
  };

  const brandTerms = ws.keywords.filter((k) => k.type === "brand" && k.status === "tracking");
  const competitors: RedditInsights["competitors"] = ws.competitors
    .filter((x) => x.status !== "dismissed")
    .map((x) => {
      const head = { id: x.id, name: x.name, domain: x.domain, status: x.status as NonNullable<RedditInsights["competitors"][number]["status"]> };
      const mine = d.mentions.filter(
        (m) => m.kind === "competitor" && (m.competitor_id === x.id || (!m.competitor_id && lower(m.term) === lower(x.name))),
      );
      return mine.length > 0 ? { ...summarize(mine, head), status: head.status } : summarizeFromText(x.name, head);
    });

  const total = competitors.reduce((n, x) => n + x.mentions_7d, 0);
  const share_of_voice: RedditInsights["share_of_voice"] = {
    window_days: 7,
    total_mentions: total,
    items:
      total === 0
        ? []
        : competitors
            .filter((x) => x.mentions_7d > 0)
            .map((x) => ({ name: x.name, mentions: x.mentions_7d, share: x.mentions_7d / total, is_you: false }))
            .sort((a, b) => b.mentions - a.mentions),
  };

  const used = d.sweeps.reduce((n, s) => n + num(s.cost_usd ?? s.est_cost_usd), 0);
  const fresh = d.sweeps.some(
    (s) => (s.status === "complete" || s.status === "partial") && ms(s.finished_at ?? s.started_at) >= clock.now - DAY,
  );
  const scannedWeek = d.sweeps.some((s) => s.status === "complete" || s.status === "partial") ? 1 : 0;
  const ls = d.lastSweep;
  const stuck =
    !!ls && ls.status === "running" && ms(ls.heartbeat_at ?? ls.started_at) < clock.now - STUCK_AFTER_MS;
  const last: RedditSweepStatus | null = ls
    ? {
        id: ls.id,
        status: stuck ? "failed" : ls.status,
        trigger: ls.trigger,
        started_at: ls.started_at,
        finished_at: ls.finished_at,
        posts_scanned: num(ls.posts_scanned),
        comments_scanned: num(ls.comments_scanned),
        communities_scanned: num(ls.communities_scanned),
        error_code: stuck ? "stale_running" : ls.error_code,
      }
    : null;
  const remaining = Math.max(0, Math.round((Math.max(cap, 0) - used) * 10000) / 10000);
  const serpKeywords = ws.keywords.filter((k) => k.status === "tracking" && k.type !== "brand").length;
  const exhausted = remaining < minimalSweepEstimate(serpKeywords);

  return {
    has_data: finished,
    sweep: {
      enabled,
      last,
      budget: { used_usd_7d: Math.round(used * 10000) / 10000, cap_usd_7d: cap, remaining_usd: remaining, exhausted },
      stale: !fresh,
    },
    threshold: d.threshold,
    today: {
      posts_scanned: c.postsScannedToday,
      communities_scanned: c.communitiesScannedToday,
      posts_relevant: c.postsRelevantToday,
    },
    kpis: {
      brand_mentions: {
        value: c.brandMentions7d,
        previous: c.brandMentionsPrev,
        brand_terms: brandTerms.length,
        scanned: scannedWeek,
      },
      reply_opportunities: { value: c.replyOpportunities, previous: snap7?.reply_opportunities ?? null, on_google },
      relevant_posts: { value: c.postsRelevantToday, previous: snap1?.posts_relevant ?? null, scanned: c.postsScannedToday },
      relevant_comments: {
        value: c.commentsRelevantToday,
        previous: snap1?.comments_relevant ?? null,
        scanned: c.commentsScannedToday,
      },
      subreddits: { value: c.subredditsTracked, top: c.top },
    },
    communities,
    opportunities,
    keyword_stats,
    competitors,
    lists: await buildLists(sb, tenantId, d, threadById),
    share_of_voice,
  };
}

const LIST_LIMIT = 25;

async function commentAuthors(
  sb: SupabaseClient,
  tenantId: string,
  ids: string[],
  known: CommentRow[],
): Promise<Map<string, string | null>> {
  const authors = new Map<string, string | null>();
  const want = new Set(ids);
  for (const c of known) if (want.has(c.id)) authors.set(c.id, c.author ?? null);
  const missing = [...want].filter((id) => !authors.has(id));
  if (missing.length > 0) {
    const res = await sb.from("reddit_comments").select("id, author").eq("tenant_id", tenantId).in("id", missing);
    for (const c of check<{ id: string; author: string | null }>(res as never, "mention comments"))
      authors.set(c.id, c.author ?? null);
  }
  return authors;
}

async function buildLists(
  sb: SupabaseClient,
  tenantId: string,
  d: Loaded,
  threadById: Map<string, ThreadRow>,
): Promise<RedditInsights["lists"]> {
  const { clock, threshold } = d;
  const today = (iso: string | null) => inRange(iso, clock.todayStart, clock.now);

  const brandRows = d.mentions
    .filter((m) => {
      const t = threadById.get(m.thread_id);
      return m.kind === "brand" && inRange(m.observed_at, clock.ago7, clock.now) && !!t && hasLink(t);
    })
    .sort((a, b) => ms(b.observed_at) - ms(a.observed_at))
    .slice(0, LIST_LIMIT);
  const authors = await commentAuthors(
    sb,
    tenantId,
    brandRows.map((m) => m.comment_id).filter((x): x is string => !!x),
    d.comments,
  );
  const brand_mentions = brandRows.map((m) => {
    const t = threadById.get(m.thread_id)!;
    return {
      thread_id: t.id,
      url: t.url,
      subreddit: t.subreddit,
      title: t.title,
      author: m.comment_id ? (authors.get(m.comment_id) ?? null) : (t.author ?? null),
      term: m.term,
      sentiment: m.sentiment ?? null,
      score: t.score,
      comment_count: t.comment_count,
      observed_at: m.observed_at,
      draft: t.draft_state || text(t.draft_text) ? { text: text(t.draft_text), state: t.draft_state ?? "drafted" } : null,
    };
  });

  const relevant_posts = d.threads
    .filter((t) => hasLink(t) && today(t.last_seen_at) && (t.post_relevance ?? -1) >= threshold)
    .sort((a, b) => (b.post_relevance ?? 0) - (a.post_relevance ?? 0) || (b.score ?? 0) - (a.score ?? 0))
    .slice(0, LIST_LIMIT)
    .map((t) => ({
      thread_id: t.id,
      url: t.url,
      subreddit: t.subreddit,
      title: t.title,
      posted_at: t.posted_at,
      relevance: t.post_relevance ?? 0,
      matched_terms: t.matched_terms ?? [],
      score: t.score,
      comment_count: t.comment_count,
    }));

  const relevant_comments = d.comments
    .filter(
      (c) =>
        ((c.last_sweep_id !== null && d.todaySweepIds.has(c.last_sweep_id)) || today(c.first_seen_at)) &&
        (c.comment_relevance ?? -1) >= threshold,
    )
    .sort((a, b) => (b.comment_relevance ?? 0) - (a.comment_relevance ?? 0) || (b.score ?? 0) - (a.score ?? 0))
    .flatMap((c) => {
      const t = threadById.get(c.thread_id);
      if (!t || !hasLink(t)) return [];
      return [{
        comment_id: c.id,
        thread_id: t.id,
        url: t.url,
        subreddit: t.subreddit,
        thread_title: t.title,
        author: c.author ?? null,
        excerpt: (c.body_excerpt ?? "").slice(0, 280),
        relevance: c.comment_relevance ?? 0,
        matched_terms: c.matched_terms ?? [],
        score: c.score,
      }];
    })
    .slice(0, LIST_LIMIT);

  return { brand_mentions, relevant_posts, relevant_comments };
}

export async function writeMetricSnapshot(sb: SupabaseClient, tenantId: string, day?: string): Promise<void> {
  const clock = clockFor(day);
  const c = core(await load(sb, tenantId, clock));
  const { error } = await sb.from("reddit_metric_snapshots").upsert(
    {
      tenant_id: tenantId,
      day: clock.day,
      brand_mentions_7d: c.brandMentions7d,
      reply_opportunities: c.replyOpportunities,
      posts_scanned: c.postsScannedToday,
      posts_relevant: c.postsRelevantToday,
      comments_scanned: c.commentsScannedToday,
      comments_relevant: c.commentsRelevantToday,
      subreddits_tracked: c.subredditsTracked,
      top_subreddit: c.top?.name ?? null,
      top_subreddit_relevance: c.top?.relevance ?? null,
    },
    { onConflict: "tenant_id,day" },
  );
  if (error) throw new Error(`reddit insights: snapshot write failed: ${error.message}`);
}
