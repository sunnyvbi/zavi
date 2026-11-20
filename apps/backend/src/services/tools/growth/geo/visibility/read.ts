
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import { dataForSeoConfigured } from "./dataforseo";
import { brandAliasesOf, findName, mentionSpans, type Span } from "./detect";
import { DEFAULT_GEO_COUNTRY, GEO_ENGINES, GEO_LOCALES, localeFor, type GeoEngine } from "./engines";
import {
  compareRates,
  computeVisibility,
  rateOf,
  type RateDelta,
  type ResponseForMetrics,
  type VisibilityMetrics,
} from "./metrics";
import { RESPONSE_METRIC_COLUMNS, SWEEP_COLUMNS, sweepForMetrics } from "./sweep";
import { loadBrandContext, setHash } from "./context";
import { listPrompts, starterIsStale } from "./prompts";

export const VISIBILITY_WINDOWS = [7, 30, 90] as const;
export type VisibilityWindow = (typeof VISIBILITY_WINDOWS)[number];

type SweepRow = Parameters<typeof sweepForMetrics>[0] & { status: string; country: string };

type DeltaOr<T extends string> = RateDelta | { unavailable: T };

export type VisibilityPanel = {
  state: "not_configured" | "no_prompts" | "never_run" | "no_data_in_window" | "ok";
  country: string;
  engine: GeoEngine | null;
  window_days: number;
  window: { from: string; to: string };
  metrics: VisibilityMetrics | null;
  deltas: {
    mention_rate: DeltaOr<"no_previous_window" | "prompt_set_changed">;
    citation_rate: DeltaOr<"no_previous_window" | "prompt_set_changed">;
    share_of_voice: DeltaOr<"no_previous_window" | "prompt_set_changed" | "rival_set_changed">;
  };
  running: { sweep_id: string; country: string; started_at: string; planned: number; collected: number } | null;
  history: Array<{
    sweep_id: string;
    finished_at: string | null;
    status: string;
    responses_collected: number;
    mention_rate: number | null;
    citation_rate: number | null;
    share_of_voice: number | null;
    rival_set_changed: boolean;
    prompt_set_changed: boolean;
  }>;
  config: {
    enabled: boolean;
    configured: boolean;
    brand: string | null;
    owned_domains: string[];
    rivals: string[];
    rival_set_hash: string;
    prompts_active: number;
    suggestions_pending: number;
    starter_stale: boolean;
    engines: { id: GeoEngine; label: string }[];
    repeats: number;
    countries: { country: string; label: string; tracked: boolean }[];
    run_limit_reached: boolean;
    runs_used: number;
    run_limit: number;
  };
};

const iso = (ms: number): string => new Date(ms).toISOString();

async function sweepsBetween(tenantId: string, country: string, fromMs: number, toMs: number): Promise<SweepRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("geo_prompt_sweeps")
    .select(SWEEP_COLUMNS)
    .eq("country", country)
    .in("status", ["complete", "partial"])
    .gte("finished_at", iso(fromMs))
    .lt("finished_at", iso(toMs))
    .order("started_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`geo sweeps read failed: ${error.message}`);
  return (data ?? []) as SweepRow[];
}

async function responsesFor(tenantId: string, sweepIds: string[]): Promise<ResponseForMetrics[]> {
  if (sweepIds.length === 0) return [];
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("geo_prompt_responses")
    .select(RESPONSE_METRIC_COLUMNS)
    .in("sweep_id", sweepIds)
    .limit(20_000);
  if (error) throw new Error(`geo responses read failed: ${error.message}`);
  return (data ?? []) as ResponseForMetrics[];
}

function oneHash(sweeps: SweepRow[], key: "prompt_set_hash" | "rival_set_hash"): string | null {
  const set = new Set(sweeps.map((s) => s[key]));
  return set.size === 1 ? [...set][0] : null;
}

export async function getVisibility(
  tenantId: string,
  q: { country?: string | null; engine?: GeoEngine | null; days?: number | null; range?: { since: string; until: string } | null },
): Promise<VisibilityPanel> {
  const db = tenantClient(asTenantId(tenantId));
  const rangeStart = q.range ? Date.parse(`${q.range.since}T00:00:00Z`) : null;
  const rangeEnd = q.range ? Math.min(Date.parse(`${q.range.until}T00:00:00Z`) + 86_400_000, Date.now()) : null;
  const days: number = rangeStart !== null && rangeEnd !== null ? Math.max(1, Math.ceil((rangeEnd - rangeStart) / 86_400_000)) : VISIBILITY_WINDOWS.find((d) => d === q.days) ?? 30;
  const engine = q.engine ?? null;

  const { data: countryRows, error: countryErr } = await db
    .from("geo_prompt_sweeps")
    .select("country, started_at")
    .order("started_at", { ascending: false })
    .limit(200);
  if (countryErr) throw new Error(`geo sweeps read failed: ${countryErr.message}`);
  const tracked = [...new Set(((countryRows ?? []) as Array<{ country: string }>).map((r) => r.country))];
  const country = localeFor(q.country)?.country ?? tracked[0] ?? DEFAULT_GEO_COUNTRY;

  const now = rangeEnd ?? Date.now();
  const span = rangeStart !== null ? now - rangeStart : days * 86_400_000;
  const [current, previous, ctx, prompts, runningRes, historyRes, enabled, repeats, doneCountRes, maxSweeps] = await Promise.all([
    sweepsBetween(tenantId, country, now - span, now + 1),
    sweepsBetween(tenantId, country, now - 2 * span, now - span),
    loadBrandContext(tenantId),
    listPrompts(tenantId),
    db
      .from("geo_prompt_sweeps")
      .select("id, country, started_at, responses_planned")
      .eq("status", "running")
      .limit(1),
    db
      .from("geo_prompt_sweeps")
      .select("id, finished_at, status, responses_collected, rival_set_hash, prompt_set_hash, metrics")
      .eq("country", country)
      .in("status", ["complete", "partial"])
      .order("finished_at", { ascending: false })
      .limit(20),
    getBoolSetting("geo_prompt_runner_enabled"),
    getNumberSetting("geo_prompt_repeats"),
    db
      .from("geo_prompt_sweeps")
      .select("id", { count: "exact", head: true })
      .in("status", ["complete", "partial"]),
    getNumberSetting("geo_prompt_max_sweeps_per_tenant"),
  ]);
  const runLimit = Math.max(0, Math.round(maxSweeps));
  if (doneCountRes.error) throw new Error(`geo sweep count failed: ${doneCountRes.error.message}`);
  const runsUsed = doneCountRes.count ?? 0;
  const runLimitReached = runsUsed >= runLimit;

  const [curRows, prevRows] = await Promise.all([
    responsesFor(tenantId, current.map((s) => s.id)),
    responsesFor(tenantId, previous.map((s) => s.id)),
  ]);
  const metrics = current.length > 0 ? computeVisibility({ sweeps: current.map(sweepForMetrics), responses: curRows, engine }) : null;
  const prevMetrics =
    previous.length > 0 ? computeVisibility({ sweeps: previous.map(sweepForMetrics), responses: prevRows, engine }) : null;

  const promptComparable =
    prevMetrics !== null && oneHash(current, "prompt_set_hash") !== null &&
    oneHash(current, "prompt_set_hash") === oneHash(previous, "prompt_set_hash");
  const rateDelta = (pick: (m: VisibilityMetrics) => ReturnType<typeof rateOf>): DeltaOr<"no_previous_window" | "prompt_set_changed"> => {
    if (!metrics || !prevMetrics) return { unavailable: "no_previous_window" };
    if (!promptComparable) return { unavailable: "prompt_set_changed" };
    return compareRates(pick(metrics), pick(prevMetrics)) ?? { unavailable: "no_previous_window" };
  };
  let sovDelta: VisibilityPanel["deltas"]["share_of_voice"];
  if (!metrics || !prevMetrics) sovDelta = { unavailable: "no_previous_window" };
  else if (!promptComparable) sovDelta = { unavailable: "prompt_set_changed" };
  else if (metrics.share_of_voice.rival_set_hash !== prevMetrics.share_of_voice.rival_set_hash) {
    sovDelta = { unavailable: "rival_set_changed" };
  } else {
    const s = metrics.share_of_voice;
    const p = prevMetrics.share_of_voice;
    sovDelta =
      compareRates(
        rateOf(s.brand_mentions, s.brand_mentions + s.rival_mentions),
        rateOf(p.brand_mentions, p.brand_mentions + p.rival_mentions),
      ) ?? { unavailable: "no_previous_window" };
  }

  const running = ((runningRes.data ?? []) as Array<{ id: string; country: string; started_at: string; responses_planned: number }>)[0];
  let runningOut: VisibilityPanel["running"] = null;
  if (running) {
    const { count } = await db
      .from("geo_prompt_responses")
      .select("id", { count: "exact", head: true })
      .eq("sweep_id", running.id);
    runningOut = {
      sweep_id: running.id,
      country: running.country,
      started_at: running.started_at,
      planned: running.responses_planned,
      collected: count ?? 0,
    };
  }

  type HistRow = {
    id: string;
    finished_at: string | null;
    status: string;
    responses_collected: number;
    rival_set_hash: string;
    prompt_set_hash: string;
    metrics: VisibilityMetrics | null;
  };
  const hist = ((historyRes.data ?? []) as HistRow[]).reverse();
  const history = hist.map((h, i) => ({
    sweep_id: h.id,
    finished_at: h.finished_at,
    status: h.status,
    responses_collected: h.responses_collected,
    mention_rate: h.metrics?.mention_rate.rate ?? null,
    citation_rate: h.metrics?.citation_rate.rate ?? null,
    share_of_voice: h.metrics?.share_of_voice.share ?? null,
    rival_set_changed: i > 0 && hist[i - 1].rival_set_hash !== h.rival_set_hash,
    prompt_set_changed: i > 0 && hist[i - 1].prompt_set_hash !== h.prompt_set_hash,
  }));

  const configured = dataForSeoConfigured();
  const state: VisibilityPanel["state"] = !configured
    ? "not_configured"
    : prompts.active.length === 0 && tracked.length === 0
      ? "no_prompts"
      : tracked.length === 0
        ? "never_run"
        : metrics === null
          ? "no_data_in_window"
          : "ok";

  return {
    state,
    country,
    engine,
    window_days: days,
    window: { from: iso(now - span), to: iso(now) },
    metrics,
    deltas: {
      mention_rate: rateDelta((m) => m.mention_rate),
      citation_rate: rateDelta((m) => m.citation_rate),
      share_of_voice: sovDelta,
    },
    running: runningOut,
    history,
    config: {
      enabled,
      configured,
      brand: ctx.brand,
      owned_domains: ctx.owned_domains,
      rivals: ctx.rivals,
      rival_set_hash: setHash(ctx.rivals),
      prompts_active: prompts.active.length,
      suggestions_pending: prompts.suggested.length,
      starter_stale: await starterIsStale(tenantId, prompts.active).catch(() => false),
      engines: GEO_ENGINES.map((e) => ({ id: e.id, label: e.label })),
      repeats,
      countries: GEO_LOCALES.map((l) => ({ country: l.country, label: l.label, tracked: tracked.includes(l.country) })),
      run_limit_reached: runLimitReached,
      runs_used: runsUsed,
      run_limit: runLimit,
    },
  };
}

export type EvidenceResponse = {
  id: string;
  sweep_id: string;
  prompt_id: string;
  prompt_text: string | null;
  engine: GeoEngine;
  repeat_index: number;
  status: "ok" | "error";
  error_code: string | null;
  data_source: string | null;
  model: string | null;
  collected_at: string;
  answer_text: string | null;
  citations: unknown[];
  brand_mentioned: boolean;
  owned_cited: boolean;
  rivals_mentioned: string[];
  answer_position: string | null;
  brand_spans: Span[];
  rival_spans: Array<Span & { name: string }>;
};

export async function getEvidence(
  tenantId: string,
  q: { prompt_id: string; engine?: GeoEngine | null; country?: string | null; days?: number | null },
): Promise<{ responses: EvidenceResponse[]; truncated: boolean }> {
  const days: VisibilityWindow = VISIBILITY_WINDOWS.find((d) => d === q.days) ?? 30;
  const country = localeFor(q.country)?.country ?? DEFAULT_GEO_COUNTRY;
  const now = Date.now();
  const sweeps = await sweepsBetween(tenantId, country, now - days * 86_400_000, now + 1);
  if (sweeps.length === 0) return { responses: [], truncated: false };
  const byId = new Map(sweeps.map((s) => [s.id, s]));

  const LIMIT = 100;
  let query = tenantClient(asTenantId(tenantId))
    .from("geo_prompt_responses")
    .select(
      "id, sweep_id, prompt_id, engine, repeat_index, status, error_code, data_source, model, collected_at, answer_text, citations, brand_mentioned, owned_cited, rivals_mentioned, answer_position",
    )
    .in("sweep_id", [...byId.keys()])
    .eq("prompt_id", q.prompt_id);
  if (q.engine) query = query.eq("engine", q.engine);
  const { data, error } = await query.order("collected_at", { ascending: false }).limit(LIMIT + 1);
  if (error) throw new Error(`geo evidence read failed: ${error.message}`);

  const rows = (data ?? []) as Array<Omit<EvidenceResponse, "prompt_text" | "brand_spans" | "rival_spans">>;
  const responses = rows.slice(0, LIMIT).map((r): EvidenceResponse => {
    const sweep = byId.get(r.sweep_id)!;
    const text = r.answer_text ?? "";
    return {
      ...r,
      prompt_text: sweep.prompts.find((p) => p.id === r.prompt_id)?.text ?? null,
      brand_spans: text ? mentionSpans(text, brandAliasesOf(sweep.brand, sweep.owned_domains)) : [],
      rival_spans: text
        ? r.rivals_mentioned.flatMap((name) => findName(text, name).map((s) => ({ ...s, name })))
        : [],
    };
  });
  return { responses, truncated: rows.length > LIMIT };
}

export async function getSweepStatus(
  tenantId: string,
  sweepId: string,
): Promise<{
  sweep_id: string;
  status: string;
  country: string;
  planned: number;
  collected: number;
  failed: number;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
} | null> {
  const db = tenantClient(asTenantId(tenantId));
  const { data, error } = await db
    .from("geo_prompt_sweeps")
    .select("id, status, country, responses_planned, responses_collected, responses_failed, started_at, finished_at, error_code")
    .eq("id", sweepId)
    .maybeSingle();
  if (error) throw new Error(`geo sweep read failed: ${error.message}`);
  if (!data) return null;
  const s = data as {
    id: string;
    status: string;
    country: string;
    responses_planned: number;
    responses_collected: number;
    responses_failed: number;
    started_at: string;
    finished_at: string | null;
    error_code: string | null;
  };
  let collected = s.responses_collected;
  let failed = s.responses_failed;
  if (s.status === "running") {
    const [ok, err] = await Promise.all([
      db.from("geo_prompt_responses").select("id", { count: "exact", head: true }).eq("sweep_id", sweepId).eq("status", "ok"),
      db.from("geo_prompt_responses").select("id", { count: "exact", head: true }).eq("sweep_id", sweepId).eq("status", "error"),
    ]);
    collected = ok.count ?? 0;
    failed = err.count ?? 0;
  }
  return {
    sweep_id: s.id,
    status: s.status,
    country: s.country,
    planned: s.responses_planned,
    collected,
    failed,
    started_at: s.started_at,
    finished_at: s.finished_at,
    error_code: s.error_code,
  };
}
