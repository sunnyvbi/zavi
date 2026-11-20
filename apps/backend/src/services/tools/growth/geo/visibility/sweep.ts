
import { asTenantId, preTenantRpc, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getBoolSetting, getNumberSetting, getStringSetting } from "@/services/settings";
import { askEngine, dataForSeoConfigured, type EngineAnswer } from "./dataforseo";
import {
  answerPosition,
  brandAliasesOf,
  canonicalPageUrl,
  isOwned,
  mentionSpans,
  resolveCitation,
  rivalsMentioned,
  type ResolvedCitation,
} from "./detect";
import { DEFAULT_GEO_COUNTRY, GEO_ENGINES, engineDef, localeFor, type GeoEngine } from "./engines";
import { computeVisibility, type ResponseForMetrics, type SweepForMetrics, type SweepPrompt } from "./metrics";
import { listPrompts } from "./prompts";
import { loadBrandContext, setHash } from "./context";
import { withVendorContext } from "@/services/vendors/usage";

export type SweepRefusalReason =
  | "disabled"
  | "not_configured"
  | "unknown_country"
  | "brand_unknown"
  | "no_prompts"
  | "already_running"
  | "tenant_cap_reached"
  | "tenant_limit_reached"
  | "fleet_cap_reached"
  | "nothing_to_run"
  | "unavailable";

export type OpenSweepResult =
  | {
      ok: true;
      sweep_id: string;
      country: string;
      planned: number;
      used_7d: number;
      cap_7d: number;
      runner: "worker" | "in_process";
    }
  | { ok: false; reason: SweepRefusalReason; message: string; used_7d?: number; cap_7d?: number };

export const SWEEP_EVENT = "geo.prompt_sweep.requested" as const;

function isUndelivered(e: unknown): boolean {
  const code = (e as { code?: unknown; cause?: { code?: unknown } } | null)?.code
    ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String((e as Error | null)?.message ?? ""));
}

export type SweepDeps = {
  send: (event: { name: typeof SWEEP_EVENT; data: { sweep_id: string; tenant_id: string } }) => Promise<unknown>;
  runInProcess?: (tenantId: string, sweepId: string) => void;
};

export const SWEEP_GROUP_PARALLELISM = 4;

function logOpenFailure(tenantId: string, stage: string, detail: unknown): void {
  const msg = detail instanceof Error ? detail.message : typeof detail === "string" ? detail : JSON.stringify(detail);
  console.error(`[geo] sweep not started (tenant ${tenantId}, ${stage}): ${String(msg).slice(0, 300)}`);
}

const REFUSAL_COPY: Record<Exclude<SweepRefusalReason, "tenant_cap_reached">, string> = {
  disabled: "Prompt sweeps are paused right now. Your last results are still shown.",
  not_configured: "Prompt sweeps are not switched on for Zavi yet.",
  unknown_country: "That country is not tracked yet.",
  brand_unknown: "Add your company name in Settings first, so Zavi knows whose mentions to count.",
  no_prompts: "Add or accept at least one prompt before running a sweep.",
  already_running: "A sweep is already running. Results land when it finishes.",
  tenant_limit_reached:
    "This workspace has used all its GEO runs for now. Your saved results stay on the page.",
  fleet_cap_reached: "Sweeps are at today's limit across Zavi. Try again tomorrow.",
  nothing_to_run: "There is nothing to ask yet.",
  unavailable: "Zavi could not confirm the sweep's start. Check the GEO channel before retrying; a worker may already be running.",
};

export async function openSweep(
  tenantId: string,
  input: { country?: string | null; requestedBy: string },
  deps: SweepDeps,
): Promise<OpenSweepResult> {
  const refuse = (reason: Exclude<SweepRefusalReason, "tenant_cap_reached">): OpenSweepResult => ({
    ok: false,
    reason,
    message: REFUSAL_COPY[reason],
  });
  try {
    if (!(await getBoolSetting("geo_prompt_runner_enabled"))) return refuse("disabled");
    if (!dataForSeoConfigured()) return refuse("not_configured");
    const locale = localeFor(input.country ?? DEFAULT_GEO_COUNTRY);
    if (!locale) return refuse("unknown_country");

    const ctx = await loadBrandContext(tenantId);
    if (!ctx.brand) return refuse("brand_unknown");
    const { active } = await listPrompts(tenantId);
    if (active.length === 0) return refuse("no_prompts");

    const repeats = Math.min(5, Math.max(3, Math.round(await getNumberSetting("geo_prompt_repeats"))));
    const prompts: SweepPrompt[] = active.map((p) => ({ id: p.id, text: p.prompt_text, source: p.source }));
    const engines = GEO_ENGINES.map((e) => e.id);
    const est = prompts.length * repeats * GEO_ENGINES.reduce((n, e) => n + e.est_cost_usd, 0);

    const { data, error } = await tenantRpc(asTenantId(tenantId), "geo_open_prompt_sweep", {
      p_requested_by: input.requestedBy,
      p_country: locale.country,
      p_location_code: locale.location_code,
      p_language_code: locale.language_code,
      p_brand: ctx.brand,
      p_owned_domains: ctx.owned_domains,
      p_rivals: ctx.rivals,
      p_rival_set_hash: setHash(ctx.rivals),
      p_engines: engines,
      p_repeats: repeats,
      p_prompts: prompts,
      p_prompt_set_hash: setHash(prompts.map((p) => p.id)),
      p_est_cost_usd: Math.round(est * 10000) / 10000,
      p_tenant_cap_7d: await getNumberSetting("geo_prompt_tenant_cap_7d"),
      p_fleet_cap_usd_24h: await getNumberSetting("geo_prompt_fleet_cap_usd_24h"),
      p_max_sweeps_per_tenant: await getNumberSetting("geo_prompt_max_sweeps_per_tenant"),
    });
    if (error || !data || typeof data !== "object") {
      logOpenFailure(tenantId, "admission rpc", error ?? "no verdict");
      return refuse("unavailable");
    }
    const verdict = data as {
      ok: boolean;
      reason?: string;
      sweep_id?: string;
      planned?: number;
      used_7d?: number;
      cap_7d?: number;
    };
    if (!verdict.ok) {
      if (verdict.reason === "tenant_cap_reached") {
        return {
          ok: false,
          reason: "tenant_cap_reached",
          message: `This sweep would take this week's sampled responses past ${verdict.cap_7d}. It refreshes as older sweeps age out of the 7-day window.`,
          used_7d: verdict.used_7d,
          cap_7d: verdict.cap_7d,
        };
      }
      const known = ["already_running", "tenant_limit_reached", "fleet_cap_reached", "nothing_to_run"] as const;
      const reason = known.find((k) => k === verdict.reason) ?? "unavailable";
      if (reason === "unavailable") logOpenFailure(tenantId, "admission verdict", verdict.reason ?? "none");
      return refuse(reason);
    }

    const sweep_id = verdict.sweep_id as string;
    let runner: "worker" | "in_process" = "worker";
    try {
      await deps.send({ name: SWEEP_EVENT, data: { sweep_id, tenant_id: tenantId } });
    } catch (e) {
      if (!isUndelivered(e)) {
        logOpenFailure(tenantId, "worker event", e);
        return refuse("unavailable");
      }
      logOpenFailure(tenantId, "worker event (running in-process)", e);
      runner = "in_process";
      (deps.runInProcess ?? ((t, s) => void runSweepInProcess(t, s)))(tenantId, sweep_id);
    }
    return {
      ok: true,
      sweep_id,
      country: locale.country,
      planned: verdict.planned ?? 0,
      used_7d: verdict.used_7d ?? 0,
      cap_7d: verdict.cap_7d ?? 0,
      runner,
    };
  } catch (e) {
    logOpenFailure(tenantId, "unexpected", e);
    return refuse("unavailable");
  }
}

type SweepRow = {
  id: string;
  tenant_id: string;
  status: string;
  country: string;
  location_code: number;
  language_code: string;
  brand: string;
  owned_domains: string[];
  rivals: string[];
  rival_set_hash: string;
  engines: GeoEngine[];
  repeats: number;
  prompts: SweepPrompt[];
  prompt_set_hash: string;
  responses_planned: number;
  started_at: string;
  finished_at: string | null;
};

export const SWEEP_COLUMNS =
  "id, tenant_id, status, country, location_code, language_code, brand, owned_domains, rivals, rival_set_hash, engines, repeats, prompts, prompt_set_hash, responses_planned, started_at, finished_at";

export async function resolveSweep(sweepId: string): Promise<{ tenant_id: string; status: string } | null> {
  const { data, error } = await preTenantRpc("geo_resolve_prompt_sweep", { p_sweep_id: sweepId });
  const row = Array.isArray(data) ? (data[0] as { tenant_id?: string; status?: string } | undefined) : undefined;
  if (error || !row?.tenant_id || !row.status) return null;
  return { tenant_id: row.tenant_id, status: row.status };
}

export async function loadSweep(tenantId: string, sweepId: string): Promise<SweepRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("geo_prompt_sweeps")
    .select(SWEEP_COLUMNS)
    .eq("id", sweepId)
    .maybeSingle();
  if (error) throw new Error(`geo sweep read failed: ${error.message}`);
  return (data as SweepRow | null) ?? null;
}

export type SlotGroup = { prompt_id: string; engine: GeoEngine };

export function slotGroupsOf(sweep: Pick<SweepRow, "prompts" | "engines">): SlotGroup[] {
  return sweep.prompts.flatMap((p) => sweep.engines.map((engine) => ({ prompt_id: p.id, engine })));
}

export function responseRowOf(
  sweep: Pick<SweepRow, "id" | "brand" | "owned_domains" | "rivals">,
  slot: { prompt_id: string; engine: GeoEngine; repeat_index: number },
  answer: EngineAnswer,
): Record<string, unknown> {
  const base = {
    sweep_id: sweep.id,
    prompt_id: slot.prompt_id,
    engine: slot.engine,
    repeat_index: slot.repeat_index,
    data_source: answer.data_source,
    cost_usd: answer.cost_usd,
    collected_at: new Date().toISOString(),
  };
  if (!answer.ok) {
    return { ...base, status: "error", error_code: answer.error_code.slice(0, 200) };
  }
  const citations: ResolvedCitation[] = answer.citations.map((c) => {
    const r = resolveCitation(c);
    return { ...r, url: canonicalPageUrl(r.url) ?? r.url, title: r.title?.slice(0, 300) ?? null };
  });
  const aliases = brandAliasesOf(sweep.brand, sweep.owned_domains);
  const spans = mentionSpans(answer.text, aliases);
  const ownedCited = citations.some((c) => !c.infra && isOwned(c.domain, sweep.owned_domains));
  return {
    ...base,
    status: "ok",
    model: answer.model?.slice(0, 200) ?? null,
    answer_text: answer.text,
    citations,
    fan_out_queries: answer.fan_out_queries,
    brand_mentioned: spans.length > 0,
    owned_cited: ownedCited,
    rivals_mentioned: rivalsMentioned(answer.text, sweep.rivals, sweep.brand),
    answer_position: answerPosition(answer.text, spans, ownedCited),
  };
}

export type SlotDeps = { ask?: typeof askEngine };

export async function runSweepSlots(
  tenantId: string,
  sweepId: string,
  group: SlotGroup,
  deps: SlotDeps = {},
): Promise<{ asked: number; skipped: number }> {
  return withVendorContext({ tenant_id: tenantId, source: "geo_sweep" }, () => runSweepSlotsInner(tenantId, sweepId, group, deps));
}

async function runSweepSlotsInner(
  tenantId: string,
  sweepId: string,
  group: SlotGroup,
  deps: SlotDeps,
): Promise<{ asked: number; skipped: number }> {
  const ask = deps.ask ?? askEngine;
  const sweep = await loadSweep(tenantId, sweepId);
  if (!sweep || sweep.status !== "running") return { asked: 0, skipped: 0 };
  const prompt = sweep.prompts.find((p) => p.id === group.prompt_id);
  const engine = engineDef(group.engine);
  if (!prompt || !engine) return { asked: 0, skipped: 0 };

  const db = tenantClient(asTenantId(tenantId));
  const { data: existing, error } = await db
    .from("geo_prompt_responses")
    .select("repeat_index")
    .eq("sweep_id", sweepId)
    .eq("prompt_id", group.prompt_id)
    .eq("engine", group.engine);
  if (error) throw new Error(`geo response read failed: ${error.message}`);
  const done = new Set(((existing ?? []) as Array<{ repeat_index: number }>).map((r) => r.repeat_index));
  const todo = Array.from({ length: sweep.repeats }, (_, i) => i).filter((i) => !done.has(i));
  if (todo.length === 0) return { asked: 0, skipped: sweep.repeats };

  const [claude, perplexity] = await Promise.all([
    getStringSetting("geo_prompt_claude_model"),
    getStringSetting("geo_prompt_perplexity_model"),
  ]);
  const opts = {
    locationCode: sweep.location_code,
    languageCode: sweep.language_code,
    country: sweep.country,
    models: { claude: claude.trim() || "claude-sonnet-5", perplexity: perplexity.trim() || "sonar" },
  };

  const rows = await Promise.all(
    todo.map(async (repeat_index) =>
      responseRowOf(sweep, { prompt_id: group.prompt_id, engine: group.engine, repeat_index }, await ask(engine, prompt.text, opts)),
    ),
  );
  const { error: writeError } = await db
    .from("geo_prompt_responses")
    .upsert(rows, { onConflict: "tenant_id,sweep_id,prompt_id,engine,repeat_index", ignoreDuplicates: true });
  if (writeError) throw new Error(`geo response write failed: ${writeError.message}`);
  return { asked: todo.length, skipped: sweep.repeats - todo.length };
}

export const RESPONSE_METRIC_COLUMNS =
  "sweep_id, prompt_id, engine, status, brand_mentioned, owned_cited, rivals_mentioned, answer_position, citations";

export function sweepForMetrics(s: SweepRow): SweepForMetrics {
  return {
    id: s.id,
    started_at: s.started_at,
    finished_at: s.finished_at,
    engines: s.engines,
    repeats: s.repeats,
    prompts: s.prompts,
    prompt_set_hash: s.prompt_set_hash,
    rivals: s.rivals,
    rival_set_hash: s.rival_set_hash,
    owned_domains: s.owned_domains,
  };
}

export async function finalizeSweep(
  tenantId: string,
  sweepId: string,
): Promise<{ status: string; collected: number; failed: number }> {
  const sweep = await loadSweep(tenantId, sweepId);
  if (!sweep) return { status: "missing", collected: 0, failed: 0 };
  const db = tenantClient(asTenantId(tenantId));
  const { data, error } = await db
    .from("geo_prompt_responses")
    .select(`${RESPONSE_METRIC_COLUMNS}, cost_usd`)
    .eq("sweep_id", sweepId);
  if (error) throw new Error(`geo responses read failed: ${error.message}`);
  const rows = (data ?? []) as Array<ResponseForMetrics & { cost_usd: number | null }>;
  const collected = rows.filter((r) => r.status === "ok").length;
  const failed = rows.length - collected;
  const cost = rows.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0);
  const status = collected === 0 ? "failed" : collected < sweep.responses_planned ? "partial" : "complete";
  const metrics = computeVisibility({ sweeps: [sweepForMetrics(sweep)], responses: rows });

  const { error: writeError } = await db
    .from("geo_prompt_sweeps")
    .update({
      status,
      responses_collected: collected,
      responses_failed: failed,
      cost_usd: Math.round(cost * 10000) / 10000,
      metrics,
      error_code: collected === 0 ? "no_responses" : null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", sweepId)
    .eq("status", "running");
  if (writeError) throw new Error(`geo sweep finalize failed: ${writeError.message}`);
  return { status, collected, failed };
}

export async function runSweepInProcess(
  tenantId: string,
  sweepId: string,
  deps: SlotDeps = {},
): Promise<{ status: string; collected: number; failed: number }> {
  try {
    const sweep = await loadSweep(tenantId, sweepId);
    if (!sweep || sweep.status !== "running") return { status: "skipped", collected: 0, failed: 0 };
    const groups = slotGroupsOf(sweep);
    for (let i = 0; i < groups.length; i += SWEEP_GROUP_PARALLELISM) {
      const batch = groups.slice(i, i + SWEEP_GROUP_PARALLELISM);
      const results = await Promise.allSettled(batch.map((g) => runSweepSlots(tenantId, sweepId, g, deps)));
      for (const r of results) {
        if (r.status === "rejected") logOpenFailure(tenantId, "in-process slot", r.reason);
      }
    }
    return await finalizeSweep(tenantId, sweepId);
  } catch (e) {
    logOpenFailure(tenantId, "in-process run", e);
    try {
      await failSweep(tenantId, sweepId, "in_process_failed");
    } catch {
    }
    return { status: "failed", collected: 0, failed: 0 };
  }
}

export async function failSweep(tenantId: string, sweepId: string, code: string): Promise<void> {
  await tenantClient(asTenantId(tenantId))
    .from("geo_prompt_sweeps")
    .update({ status: "failed", error_code: code.slice(0, 200), finished_at: new Date().toISOString() })
    .eq("id", sweepId)
    .eq("status", "running");
}
