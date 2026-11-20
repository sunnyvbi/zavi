import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redditDb as serviceClient } from "@/services/channels/reddit/db";
import { getCompanyFacts } from "@/services/company/facts";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import { callApifyTool } from "@/services/mcp/internal/apify";
import { withVendorContext } from "@/services/vendors/usage";
import type { McpCallResult } from "@/services/mcp/types";
import { listLiveRedditTenantIds, readRedditWorkspace, type RedditWorkspace } from "./workspace";
import { LLM_BATCH_EST_USD, refreshCommunityStats, scoreSweep } from "./score";
import { rankThreadsOnGoogle } from "./google-rank";
import { writeMetricSnapshot } from "./insights";
import { canonicalRedditUrl, redditPostId } from "./permalink";

export const REDDIT_SWEEP_EVENT = "reddit.sweep.requested" as const;

export type OpenSweepResult =
  | { ok: true; sweep_id: string }
  | {
      ok: false;
      reason:
        | "disabled"
        | "not_configured"
        | "nothing_to_scan"
        | "already_running"
        | "tenant_cap_reached"
        | "fleet_cap_reached"
        | "admission_failed"
        | "enqueue_failed";
    };

type RefusalReason = Extract<OpenSweepResult, { ok: false }>["reason"];

export const APIFY_JOB_EST_USD = 0.04;
export const SERP_CHECK_EST_USD = 0.004;
export const SERP_MAX_KEYWORDS = 8;
export const JOB_MAX_ITEMS = 25;
const MAX_COMMENTS_PER_POST = 5;

export type SweepJob =
  | {
      kind: "subreddit";
      key: string;
      subreddit: string;
      args: {
        mode: "subreddit";
        subreddit: string;
        time: "day";
        max_items: number;
        with_comments: true;
        max_comments_per_post: number;
      };
    }
  | {
      kind: "term";
      key: string;
      term: string;
      args: {
        mode: "search_posts";
        query: string;
        time: "week";
        max_items: number;
        with_comments: true;
        max_comments_per_post: number;
      };
    };

export type TrackedTerm = {
  term: string;
  kind: "brand" | "competitor" | "keyword";
  keyword_id: string | null;
  competitor_id: string | null;
};

function subredditJob(rawName: unknown): SweepJob | null {
  if (typeof rawName !== "string" || !/^[A-Za-z0-9_]{2,21}$/.test(rawName)) return null;
  const name = rawName.toLowerCase();
  return {
    kind: "subreddit",
    key: `sub:${name}`,
    subreddit: name,
    args: {
      mode: "subreddit",
      subreddit: name,
      time: "day",
      max_items: JOB_MAX_ITEMS,
      with_comments: true,
      max_comments_per_post: MAX_COMMENTS_PER_POST,
    },
  };
}

function termJob(raw: unknown): SweepJob | null {
  if (typeof raw !== "string") return null;
  const term = raw.replace(/\s+/g, " ").trim();
  if (term.length < 2 || term.length > 200) return null;
  return {
    kind: "term",
    key: `term:${term.toLowerCase()}`,
    term,
    args: {
      mode: "search_posts",
      query: term,
      time: "week",
      max_items: JOB_MAX_ITEMS,
      with_comments: true,
      max_comments_per_post: MAX_COMMENTS_PER_POST,
    },
  };
}

export function parseStoredJobs(raw: unknown, planned: number): SweepJob[] {
  if (!Array.isArray(raw)) return [];
  const cap = Math.max(0, Math.floor(Number.isFinite(planned) ? planned : 0));
  const out: SweepJob[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= cap) break;
    const j = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const job = j?.kind === "subreddit" ? subredditJob(j.subreddit) : j?.kind === "term" ? termJob(j.term) : null;
    if (!job || seen.has(job.key)) continue;
    seen.add(job.key);
    out.push(job);
  }
  return out;
}

export const RESERVED_TERM_JOBS = 4;

export function buildSweepJobs(ws: RedditWorkspace, maxJobs: number): SweepJob[] {
  const subs: SweepJob[] = [];
  const termJobs: SweepJob[] = [];
  const seen = new Set<string>();
  const push = (list: SweepJob[], job: SweepJob) => {
    if (seen.has(job.key)) return;
    seen.add(job.key);
    list.push(job);
  };

  for (const c of ws.communities) {
    if (!c.selected || c.rules_verdict === "banned") continue;
    const job = subredditJob(c.name);
    if (job) push(subs, job);
  }

  const tracked = ws.keywords.filter((k) => k.status === "tracking");
  const terms = [
    ...tracked.filter((k) => k.type === "brand").map((k) => k.term),
    ...ws.competitors.filter((c) => c.status === "tracking").map((c) => c.name),
    ...tracked.filter((k) => k.type !== "brand").map((k) => k.term),
  ];
  for (const raw of terms) {
    const job = termJob(raw);
    if (job) push(termJobs, job);
  }

  const cap = Math.max(0, Math.floor(Number.isFinite(maxJobs) ? maxJobs : 0));
  const subRoom = Math.max(0, cap - Math.min(termJobs.length, RESERVED_TERM_JOBS));
  return [...subs.slice(0, subRoom), ...termJobs].slice(0, cap);
}

export { LLM_BATCH_EST_USD };
const EST_SCORE_BATCH = 15;
const EST_MAX_THREADS = 200;
const EST_MAX_COMMENTS = 300;

export function estimateScoreBatches(jobCount: number): number {
  const jobs = Math.max(0, Math.floor(jobCount));
  const threads = Math.min(jobs * JOB_MAX_ITEMS, EST_MAX_THREADS);
  const comments = Math.min(jobs * JOB_MAX_ITEMS * MAX_COMMENTS_PER_POST, EST_MAX_COMMENTS);
  return Math.ceil(threads / EST_SCORE_BATCH) + Math.ceil(comments / EST_SCORE_BATCH);
}

export function estimateSweepCost(jobCount: number, serpKeywordCount: number): number {
  const est =
    jobCount * APIFY_JOB_EST_USD +
    Math.min(serpKeywordCount, SERP_MAX_KEYWORDS) * SERP_CHECK_EST_USD +
    estimateScoreBatches(jobCount) * LLM_BATCH_EST_USD;
  return Math.round(est * 10000) / 10000;
}

export function minimalSweepEstimate(serpKeywordCount: number): number {
  return estimateSweepCost(1, serpKeywordCount);
}

export function fitSweepJobs(
  ws: RedditWorkspace,
  maxJobs: number,
  serpKeywordCount: number,
  remainingUsd: number | null,
): SweepJob[] {
  const jobs = buildSweepJobs(ws, maxJobs);
  if (remainingUsd === null) return jobs;
  const fits = (count: number) => Math.round(estimateSweepCost(count, serpKeywordCount) * 1e6) / 1e6 <= remainingUsd;
  for (let count = jobs.length; count > 0; count--) {
    if (fits(count)) return count === jobs.length ? jobs : buildSweepJobs(ws, count);
  }
  return [];
}

export async function tenantSpend7d(sb: SupabaseClient, tenantId: string, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("reddit_sweeps")
    .select("cost_usd, est_cost_usd")
    .eq("tenant_id", tenantId)
    .gt("started_at", since);
  if (error || !Array.isArray(data)) return null;
  let used = 0;
  for (const r of data as Array<{ cost_usd?: unknown; est_cost_usd?: unknown }>) {
    const v = Number(r.cost_usd ?? r.est_cost_usd ?? 0);
    if (Number.isFinite(v)) used += v;
  }
  return used;
}

export function trackedTermsOf(ws: RedditWorkspace, recordNames: readonly string[] = []): TrackedTerm[] {
  const out: TrackedTerm[] = [];
  const seen = new Set<string>();
  const add = (t: TrackedTerm) => {
    const term = t.term.replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (term.length < 2 || seen.has(key)) return;
    seen.add(key);
    out.push({ ...t, term });
  };
  const tracked = ws.keywords.filter((k) => k.status === "tracking");
  for (const k of tracked.filter((k) => k.type === "brand")) {
    add({ term: k.term, kind: "brand", keyword_id: k.id, competitor_id: null });
  }
  for (const c of ws.competitors.filter((c) => c.status === "tracking")) {
    add({ term: c.name, kind: "competitor", keyword_id: null, competitor_id: c.id });
  }
  const rowKeys = new Set(ws.competitors.map((c) => c.name.trim().toLowerCase()));
  for (const name of recordNames) {
    if (rowKeys.has(name.trim().toLowerCase())) continue;
    add({ term: name, kind: "competitor", keyword_id: null, competitor_id: null });
  }
  for (const k of tracked.filter((k) => k.type !== "brand")) {
    add({ term: k.term, kind: "keyword", keyword_id: k.id, competitor_id: null });
  }
  return out;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matchTerms(text: string, terms: TrackedTerm[]): TrackedTerm[] {
  if (!text) return [];
  return terms.filter((t) => {
    const body = t.term.split(/\s+/).filter(Boolean).map(escapeRegex).join("\\s+");
    if (!body) return false;
    return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu").test(text);
  });
}

export { canonicalRedditUrl, redditPostId };

function subredditOf(canonical: string): string {
  return canonical.match(/\/r\/([a-z0-9_]+)\//)?.[1] ?? "";
}

export function commentHash(postUrl: string, author: string | null, body: string): string {
  return createHash("sha256").update(`${postUrl}|${author ?? ""}|${body}`).digest("hex");
}

export function mapAdmission(data: unknown, error: unknown): OpenSweepResult {
  if (error || !data || typeof data !== "object") return { ok: false, reason: "admission_failed" };
  const v = data as { ok?: unknown; reason?: unknown; sweep_id?: unknown };
  if (v.ok === true) {
    return typeof v.sweep_id === "string" && v.sweep_id
      ? { ok: true, sweep_id: v.sweep_id }
      : { ok: false, reason: "admission_failed" };
  }
  const known: RefusalReason[] = ["already_running", "nothing_to_scan", "tenant_cap_reached", "fleet_cap_reached"];
  const reason = known.find((k) => k === v.reason) ?? "admission_failed";
  return { ok: false, reason };
}

export function sweepFinalStatus(c: {
  jobs_done: number;
  jobs_failed: number;
  step_failures: number;
  items_read?: number | null;
}): {
  status: "complete" | "partial" | "failed";
  error_code: string | null;
} {
  if (c.jobs_done === 0) return { status: "failed", error_code: c.jobs_failed > 0 ? "all_jobs_failed" : "no_jobs_run" };
  if (c.items_read === 0) return { status: "failed", error_code: "no_data_returned" };
  if (c.jobs_failed > 0 || c.step_failures > 0) {
    return { status: "partial", error_code: c.jobs_failed > 0 ? "some_jobs_failed" : "downstream_step_failed" };
  }
  return { status: "complete", error_code: null };
}

export type SweepEvent = { name: typeof REDDIT_SWEEP_EVENT; data: { sweep_id: string; tenant_id: string } };

export type SweepDeps = {
  db?: () => SupabaseClient;
  apify?: (tenantId: string, tool: string, args: unknown) => Promise<McpCallResult>;
  send?: (event: SweepEvent) => Promise<unknown>;
  getBool?: (key: "reddit_sweep_enabled" | "reddit_workspace_v2", tenantId?: string | null) => Promise<boolean>;
  getNumber?: (
    key: "reddit_sweep_tenant_cap_usd_7d" | "reddit_sweep_fleet_cap_usd_24h" | "reddit_sweep_max_jobs",
    tenantId?: string | null,
  ) => Promise<number>;
  apifyConfigured?: () => boolean;
  readWorkspace?: (sb: SupabaseClient, tenantId: string) => Promise<RedditWorkspace>;
  now?: () => Date;
};

async function defaultSend(event: SweepEvent): Promise<unknown> {
  const { inngest } = await import("@/../workers/client");
  return inngest.send(event);
}

function resolveDeps(deps: SweepDeps) {
  return {
    db: deps.db ?? serviceClient,
    apify: deps.apify ?? callApifyTool,
    send: deps.send ?? defaultSend,
    getBool: deps.getBool ?? getBoolSetting,
    getNumber: deps.getNumber ?? getNumberSetting,
    apifyConfigured: deps.apifyConfigured ?? (() => Boolean(process.env.APIFY_TOKEN)),
    readWorkspace: deps.readWorkspace ?? readRedditWorkspace,
    now: deps.now ?? (() => new Date()),
  };
}

export async function openRedditSweep(
  tenantId: string,
  opts: { trigger: "cron" | "manual" | "auto"; requestedBy?: string | null },
  deps: SweepDeps = {},
): Promise<OpenSweepResult> {
  const d = resolveDeps(deps);
  try {
    if (!(await d.getBool("reddit_workspace_v2", tenantId))) return { ok: false, reason: "disabled" };
    if (!(await d.getBool("reddit_sweep_enabled", tenantId))) return { ok: false, reason: "disabled" };
    if (!d.apifyConfigured()) return { ok: false, reason: "not_configured" };

    const sb = d.db();
    const ws = await d.readWorkspace(sb, tenantId);
    const maxJobs = await d.getNumber("reddit_sweep_max_jobs", tenantId);
    if (buildSweepJobs(ws, maxJobs).length === 0) return { ok: false, reason: "nothing_to_scan" };
    const serpKeywords = ws.keywords.filter((k) => k.status === "tracking" && k.type !== "brand").length;
    const tenantCap = await d.getNumber("reddit_sweep_tenant_cap_usd_7d", tenantId);
    const used = await tenantSpend7d(sb, tenantId, d.now()).catch(() => null);
    const remaining = used === null ? null : Math.round((Math.max(tenantCap, 0) - used) * 10000) / 10000;
    const jobs = fitSweepJobs(ws, maxJobs, serpKeywords, remaining);
    if (jobs.length === 0) return { ok: false, reason: "tenant_cap_reached" };

    const { data, error } = await sb.rpc("reddit_open_sweep", {
      p_tenant_id: tenantId,
      p_trigger: opts.trigger,
      p_requested_by: opts.requestedBy ?? null,
      p_jobs: jobs,
      p_jobs_planned: jobs.length,
      p_est_cost_usd: estimateSweepCost(jobs.length, serpKeywords),
      p_tenant_cap_usd_7d: tenantCap,
      p_fleet_cap_usd_24h: await d.getNumber("reddit_sweep_fleet_cap_usd_24h"),
    });
    const verdict = mapAdmission(data, error);
    if (!verdict.ok) return verdict;

    try {
      await d.send({ name: REDDIT_SWEEP_EVENT, data: { sweep_id: verdict.sweep_id, tenant_id: tenantId } });
    } catch {
      await sb
        .from("reddit_sweeps")
        .update({ status: "failed", error_code: "enqueue_failed", finished_at: d.now().toISOString(), cost_usd: 0 })
        .eq("tenant_id", tenantId)
        .eq("id", verdict.sweep_id)
        .eq("status", "running");
      return { ok: false, reason: "enqueue_failed" };
    }
    return verdict;
  } catch {
    return { ok: false, reason: "admission_failed" };
  }
}

export async function resolveRedditSweep(
  sweepId: string,
  deps: SweepDeps = {},
): Promise<{ tenant_id: string; status: string } | null> {
  const d = resolveDeps(deps);
  const { data, error } = await d.db().from("reddit_sweeps").select("tenant_id, status").eq("id", sweepId).maybeSingle();
  const row = data as { tenant_id?: string; status?: string } | null;
  if (error || !row?.tenant_id || !row.status) return null;
  return { tenant_id: row.tenant_id, status: row.status };
}

export async function loadSweepJobs(tenantId: string, sweepId: string, deps: SweepDeps = {}): Promise<SweepJob[]> {
  const d = resolveDeps(deps);
  const { data, error } = await d
    .db()
    .from("reddit_sweeps")
    .select("jobs, jobs_planned")
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .maybeSingle();
  if (error) throw new Error(`sweep jobs read failed: ${error.message}`);
  const row = data as { jobs?: unknown; jobs_planned?: unknown } | null;
  if (!row) return [];
  return parseStoredJobs(row.jobs, Number(row.jobs_planned ?? 0));
}

export async function touchSweep(
  tenantId: string,
  sweepId: string,
  deps: SweepDeps = {},
): Promise<{ jobs_done: number } | null> {
  const d = resolveDeps(deps);
  const { data, error } = await d
    .db()
    .from("reddit_sweeps")
    .update({ heartbeat_at: d.now().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .eq("status", "running")
    .select("status, jobs_done")
    .maybeSingle();
  if (error) throw new Error(`sweep heartbeat failed: ${error.message}`);
  const row = data as { status?: string; jobs_done?: number } | null;
  if (!row || row.status !== "running") return null;
  return { jobs_done: Number(row.jobs_done ?? 0) };
}

type ApifyPost = {
  title?: unknown;
  url?: unknown;
  community?: unknown;
  author?: unknown;
  score?: unknown;
  comments?: unknown;
  subscribers?: unknown;
  age_hours?: unknown;
  locked?: unknown;
  removed_by?: unknown;
  body?: unknown;
};
type ApifyComment = { author?: unknown; score?: unknown; community?: unknown; post_url?: unknown; body?: unknown };

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const x = n(v);
  return x === null ? null : Math.round(x);
};

export type SweepJobResult = {
  ok: boolean;
  posts: number;
  comments: number;
  mentions: number;
  error?: string;
  counter_error?: string;
};

export async function runSweepJob(
  tenantId: string,
  sweepId: string,
  job: SweepJob,
  deps: SweepDeps = {},
): Promise<SweepJobResult> {
  const d = resolveDeps(deps);
  const sb = d.db();
  const result: SweepJobResult = { ok: false, posts: 0, comments: 0, mentions: 0 };
  try {
    const { data: sweep, error: sweepErr } = await sb
      .from("reddit_sweeps")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("id", sweepId)
      .maybeSingle();
    if (sweepErr) throw new Error(`sweep read failed: ${sweepErr.message}`);
    if (!sweep || (sweep as { status: string }).status !== "running") {
      return { ...result, error: "sweep_not_running" };
    }

    const res = await withVendorContext({ tenant_id: tenantId, source: "reddit_sweep" }, () =>
      d.apify(tenantId, "scrape_reddit", job.args),
    );
    let rawPosts: ApifyPost[] = [];
    let rawComments: ApifyComment[] = [];
    if (!res.ok) {
      const code = parseErrorCode(res.content);
      if (code !== "tool_no_data") throw new Error(`apify: ${code}`);
    } else {
      const parsed = JSON.parse(res.content) as { posts?: unknown; comments?: unknown };
      rawPosts = Array.isArray(parsed.posts) ? (parsed.posts as ApifyPost[]) : [];
      rawComments = Array.isArray(parsed.comments) ? (parsed.comments as ApifyComment[]) : [];
    }

    const ws = await d.readWorkspace(sb, tenantId);
    const recordRivals = await getCompanyFacts(tenantId)
      .then((f) => f.competitors)
      .catch(() => [] as string[]);
    const terms = trackedTermsOf(ws, recordRivals);
    const now = d.now();
    const nowIso = now.toISOString();

    type ThreadRow = Record<string, unknown> & { url: string; subreddit: string; posted_at: string | null };
    const threads = new Map<string, { row: ThreadRow; matched: TrackedTerm[] }>();
    for (const p of rawPosts) {
      const url = canonicalRedditUrl(s(p.url), s(p.community) ?? (job.kind === "subreddit" ? job.subreddit : null));
      const pid = redditPostId(url);
      const title = s(p.title);
      if (!url || !pid || !title || threads.has(pid)) continue;
      const age = n(p.age_hours);
      const rawBody = s(p.body) ?? "";
      const body = isGoneMarker(rawBody) ? "" : rawBody;
      const matched = matchTerms(`${title}\n${body}`, terms);
      threads.set(pid, {
        matched,
        row: {
          tenant_id: tenantId,
          url,
          subreddit: subredditOf(url),
          title: title.slice(0, 1000),
          author: s(p.author),
          body_excerpt: body ? body.slice(0, 1200) : null,
          score: int(p.score),
          comment_count: int(p.comments),
          posted_at: age === null ? null : new Date(now.getTime() - age * 3_600_000).toISOString(),
          locked: typeof p.locked === "boolean" ? p.locked : null,
          removed: isRemovedPost(p),
          subscribers: int(p.subscribers),
          matched_terms: matched.map((t) => t.term),
          last_seen_at: nowIso,
          last_sweep_id: sweepId,
        },
      });
    }

    type SeenThread = { id: string; url: string; posted_at: string | null; subreddit: string; sentiment: string | null };
    const threadIdByPostId = new Map<string, SeenThread>();
    if (threads.size > 0) {
      const { data, error } = await sb
        .from("reddit_threads")
        .upsert([...threads.values()].map((t) => t.row), { onConflict: "tenant_id,url" })
        .select("id, url, sentiment");
      if (error) throw new Error(`thread upsert failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; url: string; sentiment?: string | null }>) {
        const pid = redditPostId(r.url);
        const t = pid ? threads.get(pid) : undefined;
        if (t && pid) {
          threadIdByPostId.set(pid, {
            id: r.id,
            url: r.url,
            posted_at: t.row.posted_at,
            subreddit: t.row.subreddit,
            sentiment: r.sentiment ?? null,
          });
        }
      }
    }

    type CommentRow = Record<string, unknown> & { content_hash: string; thread_id: string };
    const comments = new Map<string, { row: CommentRow; matched: TrackedTerm[]; thread: { id: string; posted_at: string | null; subreddit: string } }>();
    for (const c of rawComments) {
      const pid = redditPostId(s(c.post_url));
      const thread = pid ? threadIdByPostId.get(pid) : undefined;
      const body = s(c.body) ?? "";
      if (!thread || !body || isGoneMarker(body)) continue;
      const author = s(c.author);
      const hash = commentHash(thread.url, author, body);
      if (comments.has(hash)) continue;
      const matched = matchTerms(body, terms);
      comments.set(hash, {
        matched,
        thread,
        row: {
          tenant_id: tenantId,
          thread_id: thread.id,
          content_hash: hash,
          author,
          body_excerpt: body.slice(0, 800),
          score: int(c.score),
          matched_terms: matched.map((t) => t.term),
          last_sweep_id: sweepId,
        },
      });
    }
    const commentByHash = new Map<string, { id: string; sentiment: string | null }>();
    if (comments.size > 0) {
      const { data, error } = await sb
        .from("reddit_comments")
        .upsert([...comments.values()].map((c) => c.row), { onConflict: "tenant_id,content_hash" })
        .select("id, content_hash, sentiment");
      if (error) throw new Error(`comment upsert failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; content_hash: string; sentiment?: string | null }>) {
        commentByHash.set(r.content_hash, { id: r.id, sentiment: r.sentiment ?? null });
      }
    }

    const mentions: Array<Record<string, unknown>> = [];
    const mention = (
      t: TrackedTerm,
      thread: { id: string; posted_at: string | null; subreddit: string },
      commentId: string | null,
      sentiment: string | null,
    ) => ({
      tenant_id: tenantId,
      thread_id: thread.id,
      comment_id: commentId,
      term: t.term,
      kind: t.kind,
      keyword_id: t.keyword_id,
      competitor_id: t.competitor_id,
      subreddit: thread.subreddit,
      observed_at: commentId ? nowIso : (thread.posted_at ?? nowIso),
      ...(sentiment ? { sentiment } : {}),
    });
    for (const [pid, t] of threads) {
      const thread = threadIdByPostId.get(pid);
      if (thread) for (const m of t.matched) mentions.push(mention(m, thread, null, thread.sentiment));
    }
    for (const [hash, c] of comments) {
      const seen = commentByHash.get(hash);
      if (seen) for (const m of c.matched) mentions.push(mention(m, c.thread, seen.id, seen.sentiment));
    }
    result.mentions = await insertMentions(sb, tenantId, mentions);

    if (job.kind === "subreddit") {
      await recordCommunitySize(sb, tenantId, job.subreddit.toLowerCase(), rawPosts, nowIso);
    }

    result.ok = true;
    result.posts = threads.size;
    result.comments = comments.size;
  } catch (e) {
    result.error = ((e as Error)?.message ?? String(e)).slice(0, 200);
  }

  try {
    await bumpCounters(sb, tenantId, sweepId, {
      jobs_done: result.ok ? 1 : 0,
      jobs_failed: result.ok ? 0 : 1,
      communities_scanned: result.ok && job.kind === "subreddit" ? 1 : 0,
    }, d.now().toISOString());
  } catch (e) {
    result.counter_error = ((e as Error)?.message ?? String(e)).slice(0, 200);
    console.error(`[reddit-sweep] counter bump failed for ${sweepId}: ${result.counter_error}`);
  }
  return result;
}

const isGoneMarker = (v: string | null): boolean => !!v && /^\s*\[(?:removed|deleted)\]\s*$/i.test(v);

export function isRemovedPost(p: { removed_by?: unknown; body?: unknown; title?: unknown }): boolean {
  if (s(p.removed_by) !== null) return true;
  if (isGoneMarker(s(p.body))) return true;
  const title = s(p.title);
  return !!title && /^\s*\[deleted by user\]\s*$/i.test(title);
}

function parseErrorCode(content: string): string {
  try {
    const e = JSON.parse(content) as { error?: unknown };
    return typeof e.error === "string" ? e.error : "apify_error";
  } catch {
    return "apify_error";
  }
}

async function insertMentions(sb: SupabaseClient, tenantId: string, rows: Array<Record<string, unknown>>): Promise<number> {
  if (rows.length === 0) return 0;
  const key = (r: { thread_id: unknown; comment_id: unknown; term: unknown }) =>
    `${r.thread_id}|${r.comment_id ?? ""}|${String(r.term).toLowerCase()}`;
  const threadIds = [...new Set(rows.map((r) => r.thread_id as string))];
  const { data: existing, error } = await sb
    .from("reddit_mentions")
    .select("thread_id, comment_id, term")
    .eq("tenant_id", tenantId)
    .in("thread_id", threadIds);
  if (error) throw new Error(`mention read failed: ${error.message}`);
  const have = new Set(((existing ?? []) as Array<{ thread_id: string; comment_id: string | null; term: string }>).map(key));
  const fresh: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const k = key(r as { thread_id: unknown; comment_id: unknown; term: unknown });
    if (have.has(k)) continue;
    have.add(k);
    fresh.push(r);
  }
  if (fresh.length === 0) return 0;
  const batch = await sb.from("reddit_mentions").insert(fresh);
  if (!batch.error) return fresh.length;
  if (batch.error.code !== "23505") throw new Error(`mention insert failed: ${batch.error.message}`);
  let inserted = 0;
  for (const r of fresh) {
    const one = await sb.from("reddit_mentions").insert(r);
    if (!one.error) inserted += 1;
    else if (one.error.code !== "23505") throw new Error(`mention insert failed: ${one.error.message}`);
  }
  return inserted;
}

export async function backfillTermMentions(
  sb: SupabaseClient,
  tenantId: string,
  term: TrackedTerm,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();
  const PAGE = 1000;

  type ThreadHit = { id: string; subreddit: string; posted_at: string | null; sentiment: string | null };
  const threads = new Map<string, ThreadHit>();
  const rows: Array<Record<string, unknown>> = [];
  const base = {
    tenant_id: tenantId,
    term: term.term,
    kind: term.kind,
    keyword_id: term.keyword_id,
    competitor_id: term.competitor_id,
  };

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("reddit_threads")
      .select("id, subreddit, title, body_excerpt, posted_at, sentiment")
      .eq("tenant_id", tenantId)
      .gte("last_seen_at", since)
      .order("last_seen_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`thread read failed: ${error.message}`);
    const page = (data ?? []) as Array<ThreadHit & { title: string; body_excerpt: string | null }>;
    for (const t of page) {
      threads.set(t.id, t);
      if (matchTerms(`${t.title}\n${t.body_excerpt ?? ""}`, [term]).length === 0) continue;
      rows.push({
        ...base,
        thread_id: t.id,
        comment_id: null,
        subreddit: t.subreddit,
        sentiment: t.sentiment,
        observed_at: t.posted_at ?? nowIso,
      });
    }
    if (page.length < PAGE) break;
  }
  if (threads.size === 0) return 0;

  const ids = [...threads.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb
      .from("reddit_comments")
      .select("id, thread_id, body_excerpt, sentiment, first_seen_at")
      .eq("tenant_id", tenantId)
      .in("thread_id", ids.slice(i, i + 200));
    if (error) throw new Error(`comment read failed: ${error.message}`);
    for (const c of (data ?? []) as Array<{
      id: string;
      thread_id: string;
      body_excerpt: string | null;
      sentiment: string | null;
      first_seen_at: string | null;
    }>) {
      if (!c.body_excerpt || matchTerms(c.body_excerpt, [term]).length === 0) continue;
      const t = threads.get(c.thread_id);
      if (!t) continue;
      rows.push({
        ...base,
        thread_id: t.id,
        comment_id: c.id,
        subreddit: t.subreddit,
        sentiment: c.sentiment,
        observed_at: c.first_seen_at ?? nowIso,
      });
    }
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) inserted += await insertMentions(sb, tenantId, rows.slice(i, i + 200));
  return inserted;
}

async function recordCommunitySize(
  sb: SupabaseClient,
  tenantId: string,
  subreddit: string,
  posts: ApifyPost[],
  nowIso: string,
): Promise<void> {
  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    name: subreddit,
    posts_per_day: posts.filter((p) => {
      const a = n(p.age_hours);
      return a !== null && a <= 24;
    }).length,
    posts_per_day_capped: posts.length >= JOB_MAX_ITEMS,
    updated_at: nowIso,
  };
  const subscribers = posts.map((p) => int(p.subscribers)).find((x) => x !== null);
  if (subscribers !== undefined) row.subscribers = subscribers;
  const { error } = await sb.from("reddit_community_stats").upsert(row, { onConflict: "tenant_id,name" });
  if (error) throw new Error(`community stats upsert failed: ${error.message}`);
}

type Counters = {
  jobs_done: number;
  jobs_failed: number;
  communities_scanned: number;
};

export async function countSweepItems(
  sb: SupabaseClient,
  tenantId: string,
  sweepId: string,
): Promise<{ posts_scanned: number; comments_scanned: number } | null> {
  const [t, c] = await Promise.all([
    sb.from("reddit_threads").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("last_sweep_id", sweepId),
    sb.from("reddit_comments").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("last_sweep_id", sweepId),
  ]);
  if (t.error || c.error || typeof t.count !== "number" || typeof c.count !== "number") return null;
  return { posts_scanned: t.count, comments_scanned: c.count };
}

async function bumpCounters(
  sb: SupabaseClient,
  tenantId: string,
  sweepId: string,
  add: Counters,
  nowIso: string,
): Promise<void> {
  const { data, error } = await sb
    .from("reddit_sweeps")
    .select("jobs_done, jobs_failed, communities_scanned")
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .maybeSingle();
  if (error) throw new Error(`sweep counter read failed: ${error.message}`);
  if (!data) return;
  const cur = data as Counters;
  const next: Record<string, number> = {};
  for (const k of Object.keys(add) as Array<keyof Counters>) next[k] = Number(cur[k] ?? 0) + add[k];
  const items = await countSweepItems(sb, tenantId, sweepId);
  if (items) Object.assign(next, items);
  const { error: writeErr } = await sb
    .from("reddit_sweeps")
    .update({ ...next, heartbeat_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .eq("status", "running");
  if (writeErr) throw new Error(`sweep counter write failed: ${writeErr.message}`);
}

export type DownstreamStep = { id: string; paid: boolean; run: (tenantId: string, sweepId: string) => Promise<unknown> };

export function downstreamSteps(
  deps: SweepDeps & {
    score?: typeof scoreSweep;
    communityStats?: typeof refreshCommunityStats;
    googleRank?: typeof rankThreadsOnGoogle;
    snapshot?: typeof writeMetricSnapshot;
  } = {},
): DownstreamStep[] {
  const db = deps.db ?? serviceClient;
  const score = deps.score ?? scoreSweep;
  const communityStats = deps.communityStats ?? refreshCommunityStats;
  const googleRank = deps.googleRank ?? rankThreadsOnGoogle;
  const snapshot = deps.snapshot ?? writeMetricSnapshot;
  return [
    { id: "score", paid: true, run: (t, s2) => score(t, s2) },
    { id: "community-stats", paid: false, run: (t) => communityStats(t) },
    { id: "google-rank", paid: true, run: (t, s2) => googleRank(t, s2) },
    { id: "snapshot", paid: false, run: (t) => snapshot(db(), t) },
  ];
}

export type DownstreamResult = {
  ok: boolean;
  cost_usd: number;
  error?: string;
  skipped?: "sweep_not_running" | "no_jobs_done";
};

const costOf = (v: unknown): number => {
  const c = v && typeof v === "object" ? (v as { cost_usd?: unknown }).cost_usd : undefined;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : 0;
};

export type WorkerTally = { jobs_done: number; jobs_failed: number };

export async function runDownstreamStep(
  step: DownstreamStep,
  tenantId: string,
  sweepId: string,
  deps: SweepDeps = {},
  ran?: WorkerTally,
): Promise<DownstreamResult> {
  try {
    const live = await touchSweep(tenantId, sweepId, deps);
    if (!live) return { ok: true, cost_usd: 0, skipped: "sweep_not_running" };
    if (step.paid && Math.max(live.jobs_done, ran?.jobs_done ?? 0) === 0) {
      return { ok: true, cost_usd: 0, skipped: "no_jobs_done" };
    }
    const out = await step.run(tenantId, sweepId);
    return { ok: true, cost_usd: costOf(out) };
  } catch (e) {
    return { ok: false, cost_usd: costOf(e), error: ((e as Error)?.message ?? String(e)).slice(0, 200) };
  }
}

export function sweepCost(
  status: "complete" | "partial" | "failed",
  row: { est_cost_usd: number; jobs_done: number; jobs_planned: number; jobs_failed?: number },
  reportedSpendUsd = 0,
): number {
  const spent = Number.isFinite(reportedSpendUsd) ? Math.max(0, reportedSpendUsd) : 0;
  const est = Number.isFinite(row.est_cost_usd) ? Math.max(0, row.est_cost_usd) : 0;
  const done = Number.isFinite(row.jobs_done) ? Math.max(0, row.jobs_done) : 0;
  const failed = Number.isFinite(row.jobs_failed ?? 0) ? Math.max(0, row.jobs_failed ?? 0) : 0;
  const planned = Math.max(0, Number.isFinite(row.jobs_planned) ? row.jobs_planned : 0);
  const attempted = Math.min(done + failed, planned);
  const apify = Math.min(est, attempted * APIFY_JOB_EST_USD);
  return Math.round((apify + spent) * 10000) / 10000;
}

export async function finalizeSweep(
  tenantId: string,
  sweepId: string,
  opts: { step_failures: number; spend_usd?: number; ran?: WorkerTally },
  deps: SweepDeps = {},
): Promise<{ status: string; posts_scanned?: number }> {
  const d = resolveDeps(deps);
  const sb = d.db();
  const { data, error } = await sb
    .from("reddit_sweeps")
    .select("status, jobs_planned, jobs_done, jobs_failed, est_cost_usd")
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .maybeSingle();
  if (error) throw new Error(`sweep read failed: ${error.message}`);
  const row = data as {
    status: string;
    jobs_planned: number;
    jobs_done: number;
    jobs_failed: number;
    est_cost_usd: number | string;
  } | null;
  if (!row) return { status: "missing" };
  if (row.status !== "running") return { status: row.status };
  const jobsDone = Math.max(Number(row.jobs_done ?? 0), opts.ran?.jobs_done ?? 0);
  const jobsFailed = Math.max(Number(row.jobs_failed ?? 0), opts.ran?.jobs_failed ?? 0);
  const items = await countSweepItems(sb, tenantId, sweepId).catch(() => null);
  const final = sweepFinalStatus({
    jobs_done: jobsDone,
    jobs_failed: jobsFailed,
    step_failures: opts.step_failures,
    items_read: items ? items.posts_scanned + items.comments_scanned : null,
  });
  const { error: writeErr } = await sb
    .from("reddit_sweeps")
    .update({
      status: final.status,
      error_code: final.error_code,
      finished_at: d.now().toISOString(),
      cost_usd: sweepCost(
        final.status,
        {
          est_cost_usd: Number(row.est_cost_usd ?? 0),
          jobs_done: jobsDone,
          jobs_planned: Number(row.jobs_planned ?? 0),
          jobs_failed: jobsFailed,
        },
        opts.spend_usd ?? 0,
      ),
      ...(items ?? {}),
    })
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .eq("status", "running");
  if (writeErr) throw new Error(`sweep finalize failed: ${writeErr.message}`);
  return items ? { status: final.status, posts_scanned: items.posts_scanned } : { status: final.status };
}

export async function failRedditSweep(tenantId: string, sweepId: string, code: string, deps: SweepDeps = {}): Promise<void> {
  const d = resolveDeps(deps);
  const sb = d.db();
  const { data } = await sb
    .from("reddit_sweeps")
    .select("jobs_planned, jobs_done, jobs_failed, est_cost_usd")
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .maybeSingle();
  const row = (data ?? {}) as { jobs_planned?: unknown; jobs_done?: unknown; jobs_failed?: unknown; est_cost_usd?: unknown };
  const planned = Math.max(0, Number(row.jobs_planned ?? 0) || 0);
  const ran = Math.min((Number(row.jobs_done ?? 0) || 0) + (Number(row.jobs_failed ?? 0) || 0), planned);
  const est = Math.max(0, Number(row.est_cost_usd ?? 0) || 0);
  const cost = Math.round((est * Math.max(0, ran) * 10000) / Math.max(planned, 1)) / 10000;
  await sb
    .from("reddit_sweeps")
    .update({ status: "failed", error_code: code.slice(0, 200), finished_at: d.now().toISOString(), cost_usd: cost })
    .eq("tenant_id", tenantId)
    .eq("id", sweepId)
    .eq("status", "running");
}

export async function listSweepableTenants(deps: SweepDeps = {}): Promise<string[]> {
  const sb = resolveDeps(deps).db();
  return listLiveRedditTenantIds(sb, TENANT_LIST_PAGE, TENANT_LIST_MAX_ROWS);
}

export const TENANT_LIST_PAGE = 1000;
const TENANT_LIST_MAX_ROWS = 100_000;
