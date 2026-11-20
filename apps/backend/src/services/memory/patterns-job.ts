
import { serviceClient } from "@/services/supabase";
import { callModel } from "@/services/llm/call-model";
import { DEFAULT_PROVIDER, MODELS } from "@/services/llm/models";
import { writeNote } from "./index";
import {
  PATTERNS_MIN_RUNS,
  PATTERNS_MAX_RUNS,
  PATTERNS_DEDUP_WINDOW_DAYS,
  PATTERNS_DAILY_COST_HARD_CAP_USD,
  SONNET_INPUT_PRICE_PER_M,
  SONNET_OUTPUT_PRICE_PER_M,
  buildPatternsPrompt,
  estimatePatternCostUsd,
  hashPatternTitle,
  maxRunsUnderCostCap,
  parsePatternArtifacts,
  type AgentRunSnippet,
} from "./patterns";

const SONNET_MODEL = MODELS.anthropic.sonnet;
const MAX_OUTPUT_TOKENS = 6000;

export type PatternsJobResult = {
  tenant_id: string;
  status: "ok" | "skip" | "error";
  reason: string | null;
  runs_considered: number;
  artifacts_emitted: number;
  artifacts_skipped_dup: number;
  cost_usd: number;
};

export async function runPatternsForTenant(tenant_id: string): Promise<PatternsJobResult> {
  const startedAt = new Date().toISOString();
  const sb = serviceClient();

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: priorRuns } = await sb
      .from("patterns_run_log")
      .select("cost_usd")
      .eq("tenant_id", tenant_id)
      .gte("started_at", since);
    const dayCost = ((priorRuns ?? []) as Array<{ cost_usd: number | null }>).reduce(
      (a, r) => a + Number(r.cost_usd ?? 0),
      0,
    );
    if (dayCost >= PATTERNS_DAILY_COST_HARD_CAP_USD) {
      const result: PatternsJobResult = {
        tenant_id,
        status: "skip",
        reason: "daily_cost_cap_exceeded",
        runs_considered: 0,
        artifacts_emitted: 0,
        artifacts_skipped_dup: 0,
        cost_usd: 0,
      };
      await logRun(startedAt, result, null);
      return result;
    }
  } catch {
  }

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: runRows, error: e1 } = await sb
    .from("agent_runs")
    .select("id, agent_slug, finished_at, output_text")
    .eq("tenant_id", tenant_id)
    .not("output_text", "is", null)
    .gte("finished_at", since30d)
    .order("finished_at", { ascending: false })
    .limit(PATTERNS_MAX_RUNS);

  if (e1) {
    const result: PatternsJobResult = {
      tenant_id,
      status: "error",
      reason: "agent_runs_query_failed",
      runs_considered: 0,
      artifacts_emitted: 0,
      artifacts_skipped_dup: 0,
      cost_usd: 0,
    };
    await logRun(startedAt, result, e1.message);
    return result;
  }

  const rawRuns = (runRows ?? []) as Array<{
    id: string;
    agent_slug: string;
    finished_at: string;
    output_text: string;
  }>;

  if (rawRuns.length < PATTERNS_MIN_RUNS) {
    const result: PatternsJobResult = {
      tenant_id,
      status: "skip",
      reason: "insufficient_runs",
      runs_considered: rawRuns.length,
      artifacts_emitted: 0,
      artifacts_skipped_dup: 0,
      cost_usd: 0,
    };
    await logRun(startedAt, result, null);
    return result;
  }

  const snippets: AgentRunSnippet[] = rawRuns.map((r) => ({
    run_id: r.id,
    agent_slug: r.agent_slug,
    finished_at: r.finished_at,
    output_text: r.output_text,
  }));

  const fitN = maxRunsUnderCostCap(snippets);
  const truncated = snippets.slice(0, Math.max(fitN, PATTERNS_MIN_RUNS));

  const prompt = buildPatternsPrompt(truncated);
  const estimated = estimatePatternCostUsd(prompt.length);

  let actualUsd = estimated;
  let responseText = "";
  try {
    const resp = await callModel({
      provider: DEFAULT_PROVIDER,
      model: SONNET_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
    const inputTok = resp.usage.input_tokens;
    const outputTok = resp.usage.output_tokens;
    actualUsd =
      Math.round(
        ((inputTok / 1_000_000) * SONNET_INPUT_PRICE_PER_M +
          (outputTok / 1_000_000) * SONNET_OUTPUT_PRICE_PER_M) *
          10000,
      ) / 10000;
    responseText = resp.text;
  } catch (err) {
    const result: PatternsJobResult = {
      tenant_id,
      status: "error",
      reason: "anthropic_call_failed",
      runs_considered: truncated.length,
      artifacts_emitted: 0,
      artifacts_skipped_dup: 0,
      cost_usd: 0,
    };
    await logRun(startedAt, result, (err as Error)?.message ?? String(err));
    return result;
  }

  const { artifacts } = parsePatternArtifacts(responseText);

  if (artifacts.length === 0) {
    const result: PatternsJobResult = {
      tenant_id,
      status: "ok",
      reason: "no_themes_found",
      runs_considered: truncated.length,
      artifacts_emitted: 0,
      artifacts_skipped_dup: 0,
      cost_usd: actualUsd,
    };
    await logRun(startedAt, result, null);
    return result;
  }

  const dedupSince = new Date(
    Date.now() - PATTERNS_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let emitted = 0;
  let skippedDup = 0;
  for (const artifact of artifacts) {
    const titleHash = hashPatternTitle(artifact.title);
    const hashTag = `hash:${titleHash}`;

    const { data: existing } = await sb
      .from("memory_note")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("note_type", "pattern")
      .contains("tags", [hashTag])
      .gte("created_at", dedupSince)
      .limit(1);

    if (existing && existing.length > 0) {
      skippedDup++;
      continue;
    }

    try {
      await writeNote(tenant_id, {
        title: artifact.title,
        body_markdown:
          artifact.body_markdown +
          `\n\n_Detected by patterns-nightly on ${startedAt}. Recurrence: ${artifact.theme_recurrence}. Evidence: ${artifact.evidence_run_ids.length} runs._`,
        source: "dream_cycle_merge",
        source_ref: `patterns:${tenant_id}:${startedAt}`,
        tags: ["auto-pattern", hashTag],
        note_type: "pattern",
      });
      emitted++;
    } catch (err) {
      console.warn(
        `[patterns-job] writeNote failed for tenant ${tenant_id}, title "${artifact.title}":`,
        (err as Error)?.message ?? err,
      );
    }
  }

  const result: PatternsJobResult = {
    tenant_id,
    status: "ok",
    reason: null,
    runs_considered: truncated.length,
    artifacts_emitted: emitted,
    artifacts_skipped_dup: skippedDup,
    cost_usd: actualUsd,
  };
  await logRun(startedAt, result, null);
  return result;
}

async function logRun(
  startedAt: string,
  result: PatternsJobResult,
  errorText: string | null,
): Promise<void> {
  try {
    await serviceClient().from("patterns_run_log").insert({
      tenant_id: result.tenant_id,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: result.status,
      reason: result.reason,
      runs_considered: result.runs_considered,
      artifacts_emitted: result.artifacts_emitted,
      artifacts_skipped_dup: result.artifacts_skipped_dup,
      cost_usd: result.cost_usd,
      error_text: errorText,
    });
  } catch (err) {
    console.warn(`[patterns-job] log insert failed for ${result.tenant_id}:`, (err as Error)?.message ?? err);
  }
}
