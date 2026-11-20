import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redditChannelClient } from "@/services/tenant-client";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type DbError = { code?: string; message: string };
type Result = { data: unknown; error: DbError | null; count?: number | null };

export function redditLocalStoreEnabled(): boolean {
  if (process.env.REDDIT_LOCAL_STORE !== "1") return false;
  if (process.env.NODE_ENV === "production") {
    throw new Error("REDDIT_LOCAL_STORE is dev-only and must not be set in production");
  }
  return true;
}

const STORE_FILE =
  process.env.REDDIT_LOCAL_STORE_FILE ?? path.resolve(process.cwd(), ".reddit-local-store.json");

let cache: Store | null = null;
function load(): Store {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as Store;
  } catch {
    cache = {};
  }
  return cache;
}
function save(): void {
  fs.writeFileSync(STORE_FILE, JSON.stringify(cache ?? {}, null, 1));
}
function rows(table: string): Row[] {
  const s = load();
  return (s[table] ??= []);
}

const now = () => new Date().toISOString();
const lowerTrim = (v: unknown) => String(v ?? "").trim().toLowerCase();

const DEFAULTS: Record<string, () => Row> = {
  channel_settings: () => ({ id: randomUUID(), item_type: null, status: null, position: null, note: null, detail: null, updated_at: now(), updated_by: null }),
  reddit_keywords: () => ({ id: randomUUID(), type: "problem", origin: "custom", status: "tracking", why: null, created_by: null, created_at: now(), updated_at: now() }),
  reddit_competitors: () => ({ id: randomUUID(), domain: null, origin: "custom", status: "tracking", why: null, created_by: null, created_at: now(), updated_at: now() }),
  reddit_communities: () => ({ id: randomUUID(), selected: true, rules_verdict: null, rules_verdict_at: null, rules_verdict_by: null, created_by: null, created_at: now(), updated_at: now() }),
  reddit_sweeps: () => ({ id: randomUUID(), status: "running", requested_by: null, jobs: [], heartbeat_at: now(), jobs_planned: 0, jobs_done: 0, jobs_failed: 0, posts_scanned: 0, comments_scanned: 0, communities_scanned: 0, est_cost_usd: 0, cost_usd: null, error_code: null, started_at: now(), finished_at: null }),
  reddit_threads: () => ({ id: randomUUID(), author: null, body_excerpt: null, score: null, comment_count: null, posted_at: null, locked: null, removed: false, subscribers: null, matched_terms: [], first_seen_at: now(), last_seen_at: now(), last_sweep_id: null, post_relevance: null, relevance_why: null, is_question: null, asks_for_tools: null, brands_named: [], names_you: null, sentiment: null, scored_at: null, score_hash: null, google_rank: null, google_query: null, google_checked_at: null, draft_text: null, draft_state: null, draft_updated_at: null }),
  reddit_comments: () => ({ id: randomUUID(), author: null, body_excerpt: null, score: null, matched_terms: [], first_seen_at: now(), last_sweep_id: null, comment_relevance: null, is_question: null, sentiment: null, scored_at: null, score_hash: null }),
  reddit_mentions: () => ({ id: randomUUID(), comment_id: null, keyword_id: null, competitor_id: null, sentiment: null, created_at: now() }),
  reddit_community_stats: () => ({ relevance: null, relevance_why: null, subscribers: null, posts_per_day: null, posts_per_day_capped: false, threads_seen_7d: 0, relevant_threads_7d: 0, updated_at: now() }),
  reddit_metric_snapshots: () => ({ brand_mentions_7d: 0, reply_opportunities: 0, posts_scanned: 0, posts_relevant: 0, comments_scanned: 0, comments_relevant: 0, subreddits_tracked: 0, top_subreddit: null, top_subreddit_relevance: null, created_at: now() }),
};

const UNIQUE: Record<string, Array<(r: Row) => string | null>> = {
  channel_settings: [(r) => `${r.tenant_id}|${r.channel_slug}|${r.field_id}|${String(r.item ?? "")}`],
  reddit_keywords: [(r) => `${r.tenant_id}|${lowerTrim(r.term)}`],
  reddit_competitors: [(r) => `${r.tenant_id}|${lowerTrim(r.name)}`],
  reddit_communities: [(r) => `${r.tenant_id}|${lowerTrim(r.name)}`],
  reddit_sweeps: [(r) => (r.status === "running" ? `${r.tenant_id}|running` : null)],
  reddit_threads: [(r) => `${r.tenant_id}|${r.url}`],
  reddit_comments: [(r) => `${r.tenant_id}|${r.content_hash}`],
  reddit_mentions: [(r) => `${r.tenant_id}|${r.thread_id}|${r.comment_id ?? "-"}|${lowerTrim(r.term)}`],
  reddit_community_stats: [(r) => `${r.tenant_id}|${r.name}`],
  reddit_metric_snapshots: [(r) => `${r.tenant_id}|${r.day}`],
};

function violates(table: string, candidate: Row, ignore?: Row): boolean {
  for (const keyOf of UNIQUE[table] ?? []) {
    const k = keyOf(candidate);
    if (k === null) continue;
    if (rows(table).some((r) => r !== ignore && keyOf(r) === k)) return true;
  }
  return false;
}

const dupError = (table: string): DbError => ({
  code: "23505",
  message: `duplicate key value violates unique constraint on ${table}`,
});

type Filter = (r: Row) => boolean;

export const MAX_ROWS = 1000;

function likeToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${esc}$`, "i");
}
const cmp = (a: unknown, b: unknown) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
};

class LocalQuery implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: Filter[] = [];
  private cols: string[] | null = null;
  private returning = false;
  private countMode = false;
  private head = false;
  private orders: Array<{ col: string; asc: boolean }> = [];
  private lim: number | null = null;
  private off = 0;
  private one: "single" | "maybe" | null = null;
  private payload: Row[] = [];
  private patch: Row = {};
  private onConflict: string[] | null = null;
  private ignoreDuplicates = false;

  constructor(private table: string) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.cols = !cols || cols.trim() === "*" ? null : cols.split(",").map((c) => c.trim()).filter(Boolean);
      this.countMode = !!opts?.count;
      this.head = !!opts?.head;
    } else {
      this.returning = true;
      this.cols = !cols || cols.trim() === "*" ? null : cols.split(",").map((c) => c.trim()).filter(Boolean);
    }
    return this;
  }
  insert(v: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = Array.isArray(v) ? v : [v];
    this.onConflict = o?.onConflict ? o.onConflict.split(",").map((c) => c.trim()) : null;
    this.ignoreDuplicates = !!o?.ignoreDuplicates;
    return this;
  }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  delete() { this.op = "delete"; return this; }

  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: unknown) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && cmp(r[c], v) > 0); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && cmp(r[c], v) >= 0); return this; }
  lt(c: string, v: unknown) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && cmp(r[c], v) < 0); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && cmp(r[c], v) <= 0); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  ilike(c: string, p: string) { const re = likeToRegex(p); this.filters.push((r) => re.test(String(r[c] ?? ""))); return this; }
  or(expr: string) {
    const terms = expr.split(",").map((t) => {
      const [col, op, ...rest] = t.split(".");
      const val = rest.join(".");
      if (op === "ilike") { const re = likeToRegex(val); return (r: Row) => re.test(String(r[col] ?? "")); }
      if (op === "eq") return (r: Row) => String(r[col]) === val;
      if (op === "is" && val === "null") return (r: Row) => r[col] === null || r[col] === undefined;
      if (op === "neq") return (r: Row) => r[col] !== null && r[col] !== undefined && String(r[col]) !== val;
      throw new Error(`reddit local store: unsupported or() term ${t}`);
    });
    this.filters.push((r) => terms.some((f) => f(r)));
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) { this.orders.push({ col, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(from: number, to: number) { this.off = Math.max(0, from); this.lim = Math.max(0, to - from + 1); return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }

  private pick(r: Row): Row {
    if (!this.cols) return { ...r };
    const out: Row = {};
    for (const c of this.cols) out[c] = r[c] ?? null;
    return out;
  }

  private finish(list: Row[], count?: number | null): Result {
    if (this.one) {
      if (list.length === 0) {
        return this.one === "maybe"
          ? { data: null, error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows returned" } };
      }
      if (list.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
      return { data: list[0], error: null };
    }
    return { data: list, error: null, ...(count !== undefined ? { count } : {}) };
  }

  private run(): Result {
    const table = rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));

    if (this.op === "select") {
      let list = table.filter(match);
      for (const o of [...this.orders].reverse()) {
        list = [...list].sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
      }
      const count = this.countMode ? list.length : undefined;
      list = list.slice(this.off, this.lim !== null ? this.off + this.lim : undefined).slice(0, MAX_ROWS);
      if (this.head) return { data: null, error: null, count: count ?? null };
      return this.finish(list.map((r) => this.pick(r)), count);
    }

    if (this.op === "insert") {
      const made: Row[] = [];
      for (const p of this.payload) {
        const r = { ...(DEFAULTS[this.table]?.() ?? {}), ...p };
        if (violates(this.table, r) || made.some((m) => (UNIQUE[this.table] ?? []).some((k) => k(m) !== null && k(m) === k(r)))) {
          return { data: null, error: dupError(this.table) };
        }
        made.push(r);
      }
      table.push(...made);
      save();
      return this.returning ? this.finish(made.map((r) => this.pick(r))) : { data: null, error: null };
    }

    if (this.op === "upsert") {
      const out: Row[] = [];
      for (const p of this.payload) {
        const keyCols = this.onConflict;
        const existing = keyCols
          ? table.find((r) => keyCols.every((c) => r[c] === p[c]))
          : undefined;
        if (existing) {
          if (!this.ignoreDuplicates) Object.assign(existing, p);
          out.push(existing);
        } else {
          const r = { ...(DEFAULTS[this.table]?.() ?? {}), ...p };
          if (violates(this.table, r)) return { data: null, error: dupError(this.table) };
          table.push(r);
          out.push(r);
        }
      }
      save();
      return this.returning ? this.finish(out.map((r) => this.pick(r))) : { data: null, error: null };
    }

    if (this.op === "update") {
      const hit = table.filter(match);
      for (const r of hit) {
        const next = { ...r, ...this.patch };
        if (violates(this.table, next, r)) return { data: null, error: dupError(this.table) };
      }
      for (const r of hit) Object.assign(r, this.patch);
      save();
      return this.returning ? this.finish(hit.map((r) => this.pick(r))) : { data: null, error: null };
    }

    const gone = table.filter(match);
    load()[this.table] = table.filter((r) => !match(r));
    if (this.table === "reddit_threads" && gone.length) {
      const ids = new Set(gone.map((r) => r.id));
      load().reddit_comments = rows("reddit_comments").filter((c) => !ids.has(c.thread_id));
      load().reddit_mentions = rows("reddit_mentions").filter((m) => !ids.has(m.thread_id));
    }
    if (this.table === "channel_settings" && gone.length) {
      const idsFor = (field: string) =>
        new Set(gone.filter((r) => r.field_id === field).map((r) => r.id));
      const byCol: Array<[string, Set<unknown>]> = [
        ["keyword_id", idsFor("keywords")],
        ["competitor_id", idsFor("competitors")],
      ];
      for (const m of rows("reddit_mentions")) {
        for (const [col, ids] of byCol) if (ids.has(m[col])) m[col] = null;
      }
    }
    save();
    return this.returning ? this.finish(gone.map((r) => this.pick(r))) : { data: null, error: null };
  }

  then<A = Result, B = never>(
    onok?: ((v: Result) => A | PromiseLike<A>) | null,
    onerr?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    let result: Result;
    try {
      result = this.run();
    } catch (e) {
      result = { data: null, error: { message: (e as Error).message } };
    }
    return Promise.resolve(result).then(onok, onerr);
  }
}

function openSweepRpc(a: Row): Result {
  const sweeps = rows("reddit_sweeps");
  const t = a.p_tenant_id;
  const hourAgo = Date.now() - 3_600_000;
  for (const s of sweeps) {
    if (s.tenant_id === t && s.status === "running" && Date.parse(String(s.heartbeat_at ?? s.started_at)) < hourAgo) {
      const done = Math.min(Number(s.jobs_done) + Number(s.jobs_failed), Number(s.jobs_planned));
      Object.assign(s, {
        status: "failed",
        error_code: "stale_running",
        finished_at: now(),
        cost_usd: Math.round((Number(s.est_cost_usd) * done * 10_000) / Math.max(Number(s.jobs_planned), 1)) / 10_000,
      });
    }
  }
  const spent = (s: Row) => Number(s.cost_usd ?? s.est_cost_usd ?? 0);
  if (sweeps.some((s) => s.tenant_id === t && s.status === "running")) return { data: { ok: false, reason: "already_running" }, error: null };
  if (!(Number(a.p_jobs_planned) > 0)) return { data: { ok: false, reason: "nothing_to_scan" }, error: null };
  const est = Number(a.p_est_cost_usd ?? 0);
  const weekAgo = Date.now() - 7 * 86_400_000;
  const used = sweeps.filter((s) => s.tenant_id === t && Date.parse(String(s.started_at)) > weekAgo).reduce((n, s) => n + spent(s), 0);
  const cap = Math.max(Number(a.p_tenant_cap_usd_7d ?? 0), 0);
  if (used + est > cap) return { data: { ok: false, reason: "tenant_cap_reached", used_usd_7d: used, cap_usd_7d: cap }, error: null };
  const dayAgo = Date.now() - 86_400_000;
  const fleet = sweeps.filter((s) => Date.parse(String(s.started_at)) > dayAgo).reduce((n, s) => n + spent(s), 0);
  if (fleet + est > Math.max(Number(a.p_fleet_cap_usd_24h ?? 0), 0)) return { data: { ok: false, reason: "fleet_cap_reached" }, error: null };
  const row: Row = {
    ...DEFAULTS.reddit_sweeps(),
    tenant_id: t,
    trigger: a.p_trigger,
    requested_by: a.p_requested_by ?? null,
    jobs: a.p_jobs ?? [],
    jobs_planned: Number(a.p_jobs_planned),
    est_cost_usd: est,
  };
  sweeps.push(row);
  save();
  return { data: { ok: true, sweep_id: row.id }, error: null };
}

export function withRedditLocal(real: SupabaseClient): SupabaseClient {
  if (!redditLocalStoreEnabled()) return real;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) =>
          table.startsWith("reddit_") || table === "channel_settings"
            ? new LocalQuery(table)
            : target.from(table);
      }
      if (prop === "rpc") {
        return (fn: string, args: Row) =>
          fn === "reddit_open_sweep"
            ? Promise.resolve(openSweepRpc(args ?? {}))
            : target.rpc(fn, args);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SupabaseClient;
}

export function redditDb(): SupabaseClient {
  return withRedditLocal(redditChannelClient("reddit channel tables; every query filters tenant_id"));
}
