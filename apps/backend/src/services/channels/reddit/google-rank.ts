import type { SupabaseClient } from "@supabase/supabase-js";
import { redditDb as serviceClient } from "@/services/channels/reddit/db";
import { dataForSeoConfigured, taskResultOf } from "@/services/tools/growth/geo/visibility/dataforseo";
import { reportIfOutOfCredit } from "@/services/tools/growth/geo/visibility/dataforseo-credit";
import { DEFAULT_GEO_COUNTRY, localeFor } from "@/services/tools/growth/geo/visibility/engines";
import { trackedKeywordTerms } from "./workspace";
import { recordDataForSeoTask, withVendorContext } from "@/services/vendors/usage";

export type GoogleRankResult = { queries: number; threads_ranked: number; cost_usd: number };

export const SERP_URL = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
export const SERP_DEPTH = 20;
export const MAX_RANK_QUERIES = 8;
export const SERP_TIMEOUT_MS = 60_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function redditPostId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
  const m = /^\/r\/[A-Za-z0-9_]+\/comments\/([A-Za-z0-9]{1,12})(?:\/|$)/.exec(u.pathname);
  return m ? m[1].toLowerCase() : null;
}

export type SerpHit = { post_id: string; rank: number; url: string };

export function parseSerpItems(result: Record<string, unknown>): SerpHit[] {
  const items = Array.isArray(result.items) ? result.items : [];
  const best = new Map<string, SerpHit>();
  for (const raw of items) {
    const it = asObj(raw);
    if (!it || it.type !== "organic") continue;
    const rank = it.rank_group;
    const url = it.url;
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1 || rank > 100) continue;
    if (typeof url !== "string") continue;
    const id = redditPostId(url);
    if (!id) continue;
    const prev = best.get(id);
    if (!prev || rank < prev.rank) best.set(id, { post_id: id, rank, url });
  }
  return [...best.values()];
}

export type SerpOrganic = { rank: number; url: string; domain: string };

const RANKED_TYPES = new Set(["organic", "featured_snippet"]);

export function parseOrganicItems(result: Record<string, unknown>): SerpOrganic[] {
  const items = Array.isArray(result.items) ? result.items : [];
  const out: SerpOrganic[] = [];
  for (const raw of items) {
    const it = asObj(raw);
    if (!it || typeof it.type !== "string" || !RANKED_TYPES.has(it.type)) continue;
    const rank = it.rank_group;
    const url = it.url;
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1 || rank > 100) continue;
    if (typeof url !== "string") continue;
    let domain: string;
    try {
      domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    out.push({ rank, url, domain });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

export type SerpAnswer =
  | { ok: true; hits: SerpHit[]; organic: SerpOrganic[]; cost_usd: number | null }
  | { ok: false; error_code: string; cost_usd: number | null };

const RETRYABLE_HTTP = (status: number) => status === 429 || status >= 500;
const RETRYABLE_TASK = new Set(["dataforseo_task_40101", "dataforseo_task_40106"]);

type SerpDeps = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  country?: string;
  depth?: number;
};

export function dataForSeoAuth(): string {
  return Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
}

export async function fetchSerp(keyword: string, deps: SerpDeps = {}): Promise<SerpAnswer> {
  const startedAt = Date.now();
  const answer = await fetchSerpOnce(keyword, deps);
  recordDataForSeoTask({ endpoint: "serp/google/organic", cost_usd: answer.cost_usd, ms: Date.now() - startedAt });
  if (!answer.ok) reportIfOutOfCredit(answer.error_code, "dataforseo.serp");
  return answer;
}

async function fetchSerpOnce(keyword: string, deps: SerpDeps): Promise<SerpAnswer> {
  if (!dataForSeoConfigured()) return { ok: false, error_code: "dataforseo_not_configured", cost_usd: null };
  const locale = localeFor(deps.country ?? DEFAULT_GEO_COUNTRY);
  if (!locale) return { ok: false, error_code: "no_locale", cost_usd: null };
  const doFetch: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const auth = dataForSeoAuth();
  const body = [
    { keyword, location_code: locale.location_code, language_code: locale.language_code, depth: deps.depth ?? SERP_DEPTH },
  ];

  let lastError = "dataforseo_network";
  let spent: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERP_TIMEOUT_MS);
    try {
      const res = await doFetch(SERP_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        lastError = `dataforseo_http_${res.status}`;
        if (RETRYABLE_HTTP(res.status)) continue;
        return { ok: false, error_code: lastError, cost_usd: spent };
      }
      const parsed = taskResultOf(await res.json());
      if (parsed.cost_usd !== null) spent = (spent ?? 0) + parsed.cost_usd;
      if ("error_code" in parsed) {
        lastError = parsed.error_code;
        if (RETRYABLE_TASK.has(parsed.error_code)) continue;
        return { ok: false, error_code: parsed.error_code, cost_usd: spent };
      }
      return {
        ok: true,
        hits: parseSerpItems(parsed.result),
        organic: parseOrganicItems(parsed.result),
        cost_usd: spent,
      };
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return { ok: false, error_code: "dataforseo_timeout", cost_usd: spent };
      return { ok: false, error_code: "dataforseo_network", cost_usd: spent };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error_code: lastError, cost_usd: spent };
}

export type RankThread = { id: string; url: string; matched_terms: string[] };

export type GoogleRankStore = {
  rankKeywords(tenantId: string, limit: number): Promise<string[]>;
  sweepThreads(tenantId: string, sweepId: string): Promise<RankThread[]>;
  threadsByPostIds(tenantId: string, postIds: string[]): Promise<RankThread[]>;
  setRank(tenantId: string, threadId: string, rank: number | null, query: string | null, checkedAt: string): Promise<void>;
};

const THREAD_COLS = "id, url, matched_terms";

function toThreads(rows: unknown): RankThread[] {
  return ((rows as Array<{ id: string; url: string; matched_terms: string[] | null }>) ?? []).map((r) => ({
    id: r.id,
    url: r.url,
    matched_terms: r.matched_terms ?? [],
  }));
}

export function supabaseRankStore(sb: SupabaseClient): GoogleRankStore {
  return {
    rankKeywords(tenantId, limit) {
      return trackedKeywordTerms(sb, tenantId, limit);
    },
    async sweepThreads(tenantId, sweepId) {
      const { data, error } = await sb
        .from("reddit_threads")
        .select(THREAD_COLS)
        .eq("tenant_id", tenantId)
        .eq("last_sweep_id", sweepId);
      if (error) throw new Error(`reddit google rank: threads read failed: ${error.message}`);
      return toThreads(data);
    },
    async threadsByPostIds(tenantId, postIds) {
      const safe = postIds.filter((id) => /^[a-z0-9]{1,12}$/.test(id));
      if (safe.length === 0) return [];
      const { data, error } = await sb
        .from("reddit_threads")
        .select(THREAD_COLS)
        .eq("tenant_id", tenantId)
        .or(safe.map((id) => `url.ilike.*/comments/${id}/*`).join(","));
      if (error) throw new Error(`reddit google rank: threads lookup failed: ${error.message}`);
      return toThreads(data);
    },
    async setRank(tenantId, threadId, rank, query, checkedAt) {
      const { error } = await sb
        .from("reddit_threads")
        .update({ google_rank: rank, google_query: query, google_checked_at: checkedAt })
        .eq("tenant_id", tenantId)
        .eq("id", threadId);
      if (error) throw new Error(`reddit google rank: write failed: ${error.message}`);
    },
  };
}

export type GoogleRankDeps = {
  store?: GoogleRankStore;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const lower = (s: string) => s.trim().toLowerCase();
const roundUsd = (n: number) => Math.round(n * 10_000) / 10_000;

export class GoogleRankError extends Error {
  constructor(
    message: string,
    readonly cost_usd: number,
  ) {
    super(message);
    this.name = "GoogleRankError";
  }
}

export async function rankThreadsOnGoogle(
  tenantId: string,
  sweepId: string,
  deps: GoogleRankDeps = {},
): Promise<GoogleRankResult> {
  return withVendorContext({ tenant_id: tenantId, source: "reddit_rank" }, () => rankThreadsOnGoogleInner(tenantId, sweepId, deps));
}

async function rankThreadsOnGoogleInner(
  tenantId: string,
  sweepId: string,
  deps: GoogleRankDeps,
): Promise<GoogleRankResult> {
  const zero: GoogleRankResult = { queries: 0, threads_ranked: 0, cost_usd: 0 };
  if (!dataForSeoConfigured()) return zero;
  const store = deps.store ?? supabaseRankStore(serviceClient());

  const keywords = [...new Map((await store.rankKeywords(tenantId, MAX_RANK_QUERIES)).map((k) => [lower(k), k])).values()]
    .filter((k) => k.trim() !== "")
    .slice(0, MAX_RANK_QUERIES);
  if (keywords.length === 0) return zero;
  let cost = 0;
  try {
    return await rankKeywords(tenantId, sweepId, keywords, store, deps, (c) => (cost += c));
  } catch (e) {
    if (e instanceof GoogleRankError) throw e;
    throw new GoogleRankError((e as Error)?.message ?? String(e), roundUsd(cost));
  }
}

async function rankKeywords(
  tenantId: string,
  sweepId: string,
  keywords: string[],
  store: GoogleRankStore,
  deps: GoogleRankDeps,
  addCost: (usd: number) => void,
): Promise<GoogleRankResult> {
  const candidates = await store.sweepThreads(tenantId, sweepId);

  const ranked = new Map<string, { rank: number; query: string }>();
  const checked = new Set<string>();
  let cost = 0;
  let queries = 0;

  for (const keyword of keywords) {
    const answer = await fetchSerp(keyword, { fetch: deps.fetch, sleep: deps.sleep });
    cost += answer.cost_usd ?? 0;
    addCost(answer.cost_usd ?? 0);
    if (!answer.ok) {
      console.warn(`[reddit] google rank SERP failed sweep=${sweepId} code=${answer.error_code}`);
      continue;
    }
    queries++;
    for (const t of candidates) {
      if (t.matched_terms.some((m) => lower(m) === lower(keyword))) checked.add(t.id);
    }
    if (answer.hits.length === 0) continue;
    const rankById = new Map(answer.hits.map((h) => [h.post_id, h.rank]));
    const threads = await store.threadsByPostIds(tenantId, [...rankById.keys()]);
    for (const t of threads) {
      const id = redditPostId(t.url);
      const rank = id ? rankById.get(id) : undefined;
      if (rank === undefined) continue;
      const prev = ranked.get(t.id);
      if (!prev || rank < prev.rank) ranked.set(t.id, { rank, query: keyword });
    }
  }

  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  for (const [threadId, r] of ranked) await store.setRank(tenantId, threadId, r.rank, r.query, checkedAt);
  for (const threadId of checked) {
    if (!ranked.has(threadId)) await store.setRank(tenantId, threadId, null, null, checkedAt);
  }

  return { queries, threads_ranked: ranked.size, cost_usd: roundUsd(cost) };
}
