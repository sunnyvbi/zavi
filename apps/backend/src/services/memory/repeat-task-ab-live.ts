
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/services/supabase";
import {
  buildContext,
  runDispatch,
  type ClaimedAgentRun,
} from "@/services/agents/runner";
import { makeDraftCtx } from "@/services/agents/generic-dispatcher";
import { getDispatcher, loadAgentDefinition } from "@/services/agents/registry";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import type {
  AbDispatchResult,
  RepeatTaskAbDeps,
  RepeatTaskGoldenLite,
} from "./repeat-task-ab";
import { releaseRunFigures } from "@/services/agents/engine/figure-ledger";
import type { AbArm, AbArmResult } from "./repeat-task-ab-types";

const REAL_TENANTS: readonly string[] = [
  "73db45ff-457e-4541-bc8f-bdb625390204",
  "e0fe9ea8",
  "5f05d826-7793-45d1-88f9-c5c5bb3f0347",
];

export function isRepeatAbRealTenant(tenantId: string): boolean {
  return REAL_TENANTS.some((t) => tenantId === t || tenantId.startsWith(t));
}

export type RepeatTaskAbLiveWiring = {
  buildContext: (claim: ClaimedAgentRun, runId: string) => Promise<AgentContext>;
  runDispatch: (ctx: AgentContext, payload: unknown) => Promise<DispatcherResult>;
  makeDraftCtx: (ctx: AgentContext) => AgentContext;
  getDispatcher: (slug: string) => unknown;
  loadAgentDefinition: (
    slug: string,
    tenant_id?: string,
  ) => Promise<{ content_hash: string } | null>;
  sb: () => SupabaseClient;
  allowRealTenant?: boolean;
};

const defaultWiring: RepeatTaskAbLiveWiring = {
  buildContext,
  runDispatch,
  makeDraftCtx,
  getDispatcher,
  loadAgentDefinition,
  sb: serviceClient,
  allowRealTenant: false,
};

function armPayload(golden: RepeatTaskGoldenLite, arm: AbArm) {
  return {
    intent: golden.query,
    memory_mode: arm === "brain_off" ? ("off" as const) : undefined,
    origin: "repeat_task_ab" as const,
    golden_id: golden.id,
    arm,
  };
}

async function liveDispatch(
  golden: RepeatTaskGoldenLite,
  arm: AbArm,
  w: RepeatTaskAbLiveWiring,
): Promise<AbDispatchResult> {
  if (isRepeatAbRealTenant(golden.tenant_id) && !w.allowRealTenant) {
    throw new Error(
      `repeat-task A/B refuses real customer tenant ${golden.tenant_id}: ` +
        `pass allowRealTenant (CLI --i-know) only after confirming the draft_mode seal is deployed. ` +
        `Prefer a throwaway test tenant.`,
    );
  }

  if (w.getDispatcher(golden.agent_slug)) {
    throw new Error(
      `repeat-task A/B does not support bespoke-dispatcher agent '${golden.agent_slug}': ` +
        `draft_mode does not fully neutralize its side-effect path. Add explicit draft ` +
        `handling to its dispatcher before A/B-testing it.`,
    );
  }

  const def = await w.loadAgentDefinition(golden.agent_slug, golden.tenant_id);
  if (!def) {
    throw new Error(
      `repeat-task A/B: agent '${golden.agent_slug}' not found for tenant ${golden.tenant_id}`,
    );
  }

  const runId = randomUUID();
  const payload = armPayload(golden, arm);
  const sb = w.sb();

  const { error: insErr } = await sb.from("agent_runs").insert({
    id: runId,
    tenant_id: golden.tenant_id,
    agent_slug: golden.agent_slug,
    agent_definition_hash: def.content_hash,
    trigger: "a2a",
    status: "running",
    started_at: new Date().toISOString(),
    payload,
  });
  if (insErr) {
    throw new Error(`repeat-task A/B: agent_runs insert failed: ${insErr.message}`);
  }

  const claim: ClaimedAgentRun = {
    id: runId,
    tenant_id: golden.tenant_id,
    agent_slug: golden.agent_slug,
    trigger: "a2a",
    payload,
  };

  let result: DispatcherResult | undefined;
  let terminal = "dispatch_error";
  try {
    const ctx = await w.buildContext(claim, runId);
    const draftCtx = w.makeDraftCtx(ctx);
    result = await w.runDispatch(draftCtx, payload);
    terminal = result.parse_ok ? "success" : "parse_failed";
    return {
      output_text: result.output_text,
      parse_ok: result.parse_ok,
      prompt_snapshot: result.prompt_snapshot,
      usage: {
        input_tokens: result.usage?.input_tokens,
        output_tokens: result.usage?.output_tokens,
        cost_usd: result.usage?.cost_usd,
      },
    };
  } finally {
    releaseRunFigures(runId, null);
    const { error: upErr } = await sb
      .from("agent_runs")
      .update({
        status: terminal,
        finished_at: new Date().toISOString(),
        output_text: result?.output_text ?? null,
        cost_usd: result?.usage?.cost_usd ?? 0,
        cost_tokens:
          (result?.usage?.input_tokens ?? 0) + (result?.usage?.output_tokens ?? 0),
        parse_ok: result?.parse_ok ?? false,
      })
      .eq("id", runId)
      .eq("status", "running");
    if (upErr) {
      console.warn(
        `[repeat-task-ab] terminal update failed for run=${runId}: ${upErr.message}`,
      );
    }
  }
}

export function makeRepeatTaskAbLiveDeps(
  overrides: Partial<RepeatTaskAbLiveWiring> = {},
): RepeatTaskAbDeps {
  const w: RepeatTaskAbLiveWiring = { ...defaultWiring, ...overrides };
  return {
    dispatch: (golden, arm) => liveDispatch(golden, arm, w),
    writeMetric: async (row: AbArmResult) => {
      const { error } = await w.sb().from("repeat_task_ab_metrics").insert({
        tenant_id: row.tenant_id,
        agent_slug: row.agent_slug,
        golden_id: row.golden_id,
        eval_run_id: row.eval_run_id,
        arm: row.arm,
        correctness_score: row.correctness_score,
        model_cost_usd: row.model_cost_usd,
        retrieval_cost_usd: row.retrieval_cost_usd,
        judge_cost_usd: row.judge_cost_usd,
        walltime_ms: row.walltime_ms,
        terminal_status: row.terminal_status,
      });
      if (error) {
        throw new Error(`repeat_task_ab_metrics insert failed: ${error.message}`);
      }
    },
    newEvalRunId: () => randomUUID(),
    now: () => Date.now(),
  };
}
