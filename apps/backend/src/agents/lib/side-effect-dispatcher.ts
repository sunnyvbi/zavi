
import { hasRunFailureCode } from "@/services/agents/run-failure-code";
import type { ZodTypeAny } from "zod";
import { runGeneric } from "@/services/agents/generic-dispatcher";
import { serviceClient } from "@/services/supabase";
import type {
  AgentContext,
  DispatcherFn,
  DispatcherResult,
} from "@/services/agents/types";
import { suppressAnsweredNoAction } from "@/agents/lib/suppress-policy";
import { cleanNoActionReport, writeBackGatedEnvelope } from "@/agents/lib/publish-gates";
import { readCustomerFacingFields } from "@/services/agents/model-refusal-envelope";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { writesSuppressed } from "@/services/agents/generic-dispatcher";
import { topActionFilesSteps, topActionModeOf, topActionRetryPayload } from "@/services/channels/top-actions";
import { estimateCostUsd } from "@/services/anthropic";
import { logEvent } from "@/services/logging/logEvent";
import { DEFAULT_AGENT_MODEL } from "@/services/llm/models";
import {
  applyFitVerdict,
  FIT_VERDICT_KEEPERS,
  withoutChannelActionFields,
  type RecipeStepDecisionBody,
} from "@/agents/lib/channel-recipe-step";
import {
  previewActionTypes,
  recordChannelRunActions,
  switchedChannelForRun,
  type ChannelRedoTarget,
} from "@/services/channels/channel-actions";
import { paceSignupCards } from "@/services/channels/onboarding-pacing";

const CHANNEL_RECIPE_STEP_CLASS = "channel.recipe_step";

function readRedoAction(payload: unknown): ChannelRedoTarget | null {
  const r = readRedo(payload) as
    | (Record<string, unknown> & { redo_of_action_id?: unknown; note?: unknown })
    | null;
  const id = r && typeof r.redo_of_action_id === "string" ? r.redo_of_action_id : null;
  if (!id) return null;
  return {
    redo_of_action_id: id,
    origin_position: typeof r!.origin_position === "number" ? (r!.origin_position as number) : null,
    origin_of: typeof r!.origin_of === "number" ? (r!.origin_of as number) : null,
    note: typeof r!.note === "string" ? (r!.note as string) : null,
  };
}

function readRedo(payload: unknown): {
  redo_of_decision_id?: string | null;
  origin_run_id?: string | null;
  origin_position?: number | null;
  origin_of?: number | null;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const r = (payload as { redo?: unknown }).redo;
  return r && typeof r === "object" ? (r as Record<string, never>) : null;
}

export type CreateSideEffectDispatcherOpts = {
  slug: string;
  decisionClass: string;
  schema?: ZodTypeAny;
  shouldEmit?: (parsed: unknown, ctx: AgentContext, payload: unknown) => boolean;
  fanOut?: (parsed: unknown) => ReadonlyArray<unknown>;
  backfillImprovementAttempt?: boolean;
  transformBeforeCriticAndEmit?: (
    envelope: unknown,
    ctx: AgentContext,
    payload: unknown,
    result: DispatcherResult,
  ) => Promise<
    | { envelope: unknown }
    | { suppress: true; reason: string; output_text?: string; detail?: string }
  >;
};

const PR_META_KEYS = ["pr_url", "pr_repo", "pr_number", "pr_head_branch"] as const;

async function carryPrMetaIntoParsed(
  tenantId: string,
  runId: string,
  result: DispatcherResult,
): Promise<void> {
  if (!result.parsed || typeof result.parsed !== "object") return;
  try {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("parsed")
      .eq("id", runId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const stored = (data as { parsed?: Record<string, unknown> | null } | null)?.parsed;
    if (!stored || typeof stored !== "object") return;
    const target = result.parsed as Record<string, unknown>;
    for (const k of PR_META_KEYS) {
      if (stored[k] !== undefined && stored[k] !== null) target[k] = stored[k];
    }
  } catch (e) {
    console.warn(`[side-effect-dispatcher] pr meta carry-over failed for ${runId}: ${(e as Error).message}`);
  }
}

export type SideEffectDispatcherFn = DispatcherFn & {
  emitAfterRun: (ctx: AgentContext, result: DispatcherResult, payload?: unknown) => Promise<DispatcherResult>;
};

export function createSideEffectDispatcher(
  opts: CreateSideEffectDispatcherOpts,
): SideEffectDispatcherFn {
  const emitAfterRun = (ctx: AgentContext, result: DispatcherResult, payload?: unknown) =>
    emitSideEffects(opts, ctx, payload, result);
  const sideEffectDispatcher = async (ctx: AgentContext, payload?: unknown): Promise<DispatcherResult> =>
    emitAfterRun(ctx, await runTopActionRetry(ctx, payload, await runGeneric(ctx, payload)), payload);
  return Object.assign(sideEffectDispatcher, { emitAfterRun });
}

export async function runTopActionRetry(ctx: AgentContext, payload: unknown, first: DispatcherResult): Promise<DispatcherResult> {
  if (first.parse_error === "budget_cap" || first.stop_reason === "budget_exceeded") return first;
  const again = topActionRetryPayload(payload, first.tool_calls);
  if (!again) return first;
  let second: DispatcherResult;
  const priorBefore = ctx.priorPassSpendUsd;
  ctx.priorPassSpendUsd = (priorBefore ?? 0) + passCostUsd(ctx, first);
  try {
    second = await runGeneric(ctx, again);
  } catch (e) {
    ctx.priorPassSpendUsd = priorBefore;
    if (isRunStop(e)) throw e;
    console.warn(`[side-effect-dispatcher] top action second try failed, keeping the first: ${e instanceof Error ? e.message : String(e)}`);
    void logEvent({
      level: "error",
      source: "side-effect-dispatcher",
      code: "top_action.second_pass_failed",
      message: "top action second pass threw; its model spend is not in this run's cost_usd (the pass returned no usage)",
      tenant_id: ctx.tenant_id,
      run_id: ctx.runId,
      meta: { agent_slug: ctx.agent?.slug ?? null, stage: "top_action_retry", error_class: e instanceof Error ? e.constructor.name : typeof e },
    }).catch(() => undefined);
    return first;
  }
  ctx.priorPassSpendUsd = priorBefore;
  const a = first.usage;
  const b = second.usage;
  const usage: DispatcherResult["usage"] = {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
  if (a.cost_usd !== undefined || b.cost_usd !== undefined) usage.cost_usd = passCostUsd(ctx, first) + passCostUsd(ctx, second);
  const routing = second.routing ?? first.routing;
  const merged: DispatcherResult = { ...second, tool_calls: [...(first.tool_calls ?? []), ...(second.tool_calls ?? [])], usage };
  if (routing) {
    merged.routing = { ...routing, classifier_cost_usd: (first.routing?.classifier_cost_usd ?? 0) + (second.routing?.classifier_cost_usd ?? 0) };
  }
  return merged;
}

function isRunStop(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  return msg === "run_cancelled" || msg === "kill_switch";
}

function passCostUsd(ctx: AgentContext, pass: DispatcherResult): number {
  if (typeof pass.usage.cost_usd === "number") return pass.usage.cost_usd;
  const model = pass.routing?.model ?? ctx.agent?.metadata_praxis?.model ?? DEFAULT_AGENT_MODEL;
  return estimateCostUsd(model, {
    input_tokens: pass.usage.input_tokens,
    output_tokens: pass.usage.output_tokens,
    cache_creation_input_tokens: pass.usage.cache_creation_input_tokens,
    cache_read_input_tokens: pass.usage.cache_read_input_tokens,
  });
}

async function emitSideEffects(
  opts: CreateSideEffectDispatcherOpts,
  ctx: AgentContext,
  payload: unknown,
  result: DispatcherResult,
): Promise<DispatcherResult> {
  if (!result.parse_ok || result.parsed == null) {
    return result;
  }

  let envelope: unknown = result.parsed;
  const declared = readCustomerFacingFields(result.parsed);
  if (declared.customer_summary) result.customer_summary = declared.customer_summary;
  if (opts.schema) {
    const parsed = opts.schema.safeParse(result.parsed);
    if (!parsed.success) {
      console.warn(
        `[side-effect-dispatcher ${opts.slug}] schema revalidation failed — skipping emit: ${parsed.error.message}`,
      );
      return result;
    }
    envelope = parsed.data;
  }

  if (opts.decisionClass === CHANNEL_RECIPE_STEP_CLASS && !readRedo(payload)) {
    const fit = applyFitVerdict(envelope, FIT_VERDICT_KEEPERS[ctx.agent.slug]);
    if (fit.dropped > 0) {
      console.log(`[side-effect-dispatcher ${opts.slug}] fit not_here: dropped ${fit.dropped} step(s)`);
      envelope = fit.envelope;
      writeBackGatedEnvelope(result, envelope);
    }
  }

  if (opts.decisionClass === CHANNEL_RECIPE_STEP_CLASS && ctx.agent.slug === "linkedin_ads" && !readRedo(payload) && !writesSuppressed(ctx) && ctx.preview_dry !== true) {
    try {
      const { settleLinkedinRunLaunchCards } = await import("@/services/growth/linkedin-run-verdict");
      await settleLinkedinRunLaunchCards(ctx.tenant_id, ctx.runId, (envelope as { fit?: { verdict?: unknown; reason?: unknown } | null } | null)?.fit);
    } catch (e) {
      console.warn(`[side-effect-dispatcher ${opts.slug}] launch cards left for the founder: ${(e as Error).message}`);
    }
  }

  if (opts.shouldEmit && !opts.shouldEmit(envelope, ctx, payload)) {
    if (opts.decisionClass === CHANNEL_RECIPE_STEP_CLASS) cleanNoActionReport(result);
    return result;
  }

  if (opts.decisionClass === CHANNEL_RECIPE_STEP_CLASS && !topActionFilesSteps(payload)) return result;

  const keepCards =
    ctx.preview_dry === true && ctx.preview_keep_cards === true && ctx.shadow_mode !== true;

  if (ctx.preview_dry === true && !keepCards) {
    result.preview_action_types =
      opts.decisionClass === CHANNEL_RECIPE_STEP_CLASS && opts.fanOut
        ? previewActionTypes(ctx.agent.slug, opts.fanOut(envelope) as RecipeStepDecisionBody[])
        : [];
    return result;
  }

  if (opts.transformBeforeCriticAndEmit) {
    let transformed: Awaited<
      ReturnType<typeof opts.transformBeforeCriticAndEmit>
    >;
    try {
      transformed = await opts.transformBeforeCriticAndEmit(
        envelope,
        ctx,
        payload,
        result,
      );
    } catch (e) {
      if (hasRunFailureCode(e)) throw e;
      console.warn(
        `[side-effect-dispatcher ${opts.slug}] transform threw: ${(e as Error).message}`,
      );
      result.parse_error = result.parse_error
        ? `${result.parse_error}; transform_threw:${(e as Error).message.slice(0, 200)}`
        : `transform_threw:${(e as Error).message.slice(0, 200)}`;
      result.parse_ok = false;
      return result;
    }

    if ("suppress" in transformed) {
      result.parsed = null;
      result.parse_ok = suppressAnsweredNoAction(
        transformed.reason,
        transformed.output_text,
      );
      if (transformed.output_text) {
        result.output_text = transformed.output_text;
      }
      result.side_effect = {
        kind: "refused",
        reason: transformed.reason,
        ...(transformed.detail ? { detail: transformed.detail } : {}),
        ...(declared.reason_code ? { reason_code: declared.reason_code } : {}),
      };
      console.log(
        `[side-effect-dispatcher ${opts.slug}] decision suppressed: ${transformed.reason}`,
      );
      return result;
    }
    envelope = transformed.envelope;
    if (opts.decisionClass === CHANNEL_RECIPE_STEP_CLASS) {
      writeBackGatedEnvelope(result, envelope);
    }
  }

  let bodies = opts.fanOut ? opts.fanOut(envelope) : [envelope];

  if (opts.decisionClass === CHANNEL_RECIPE_STEP_CLASS) {
    const switched = await switchedChannelForRun(ctx.tenant_id, ctx.runId);
    if (switched) {
      if (!keepCards) {
        if (writesSuppressed(ctx)) return result;
      }
      const topAction = topActionModeOf(payload);
      const recorded = await recordChannelRunActions({
        tenantId: ctx.tenant_id,
        runId: ctx.runId,
        channelSlug: switched,
        envelope,
        bodies: bodies as RecipeStepDecisionBody[],
        redo: readRedoAction(payload),
        ...(ctx.trigger === "channel_recipe" && topAction?.valid && topAction.channel_slug === switched &&
          switched === "instagram_organic" && topAction.key === "rewrite_bio"
          ? { topAction: "rewrite_bio" as const } : {}),
        ...(ctx.trigger === "chat"
          ? { chat: { toolCardIds: (result.tool_calls ?? []).flatMap((t) => (t.status === "ok" ? t.returned_ids ?? [] : [])) } }
          : {}),
      });
      if (ctx.trigger === "channel_recipe" && recorded.inserted > 0) await paceSignupCards(ctx.tenant_id, ctx.runId);
      result.side_effect = {
        kind: "shipped",
        detail: recorded.ids.map((r) => r.id).join(","),
      };
      return result;
    }
    bodies = bodies.map((b) => withoutChannelActionFields(b));
  }

  if (keepCards) return result;

  const redo = readRedo(payload);
  if (redo && bodies.length > 0) {
    bodies = [
      {
        ...(bodies[0] as Record<string, unknown>),
        redo_of_decision_id: redo.redo_of_decision_id ?? null,
        origin_run_id: redo.origin_run_id ?? null,
        ...(typeof redo.origin_position === "number"
          ? { position: redo.origin_position }
          : {}),
        ...(typeof redo.origin_of === "number" ? { of: redo.origin_of } : {}),
      },
    ];
  }
  const emitted: string[] = [];
  const emittedWithBody: Array<{ id: string; body: unknown }> = [];
  for (const body of bodies) {
    try {
      const id = await ctx.emitDecision(opts.decisionClass, body);
      if (id) {
        emitted.push(id);
        emittedWithBody.push({ id, body });
      }
      console.log(
        `[side-effect-dispatcher ${opts.slug}] emitted decision ${id} class=${opts.decisionClass}`,
      );
    } catch (e) {
      console.warn(
        `[side-effect-dispatcher ${opts.slug}] emit_decision failed (class=${opts.decisionClass}): ${(e as Error).message}`,
      );
    }
  }

  if (emitted.length === 0) {
    if (bodies.length > 0) {
      throw new Error(
        `[side-effect-dispatcher ${opts.slug}] all ${bodies.length} emit(s) failed for class=${opts.decisionClass}`,
      );
    }
    return result;
  }

  if (redo?.redo_of_decision_id && emitted.length > 0) {
    try {
      const { error } = await tenantRpc(
        asTenantId(ctx.tenant_id),
        "archive_decision",
        { p_decision_id: redo.redo_of_decision_id },
      );
      if (error) {
        console.warn(
          `[side-effect-dispatcher ${opts.slug}] superseded archive failed for ${redo.redo_of_decision_id}: ${error.message}`,
        );
      }
    } catch (e) {
      console.warn(
        `[side-effect-dispatcher ${opts.slug}] superseded archive threw: ${(e as Error).message}`,
      );
    }
  }

  const decisionId: string | null = emitted[0] ?? null;
  result.side_effect = { kind: "shipped", detail: emitted.join(",") };

  let anyDispatched = false;
  for (const { id: emittedId, body: emittedBody } of emittedWithBody) {
    try {
      const { dispatchInteractiveDecision } = await import(
        "@/services/decisions/dispatch-interactive"
      );
      const dispatched = await dispatchInteractiveDecision({
        decision_id: emittedId,
        tenant_id: ctx.tenant_id,
        decision_class: opts.decisionClass,
        agent_run_id: ctx.runId,
        body: emittedBody,
      });
      if (dispatched?.dispatched) anyDispatched = true;
    } catch (e) {
      console.warn(
        `[side-effect-dispatcher ${opts.slug}] in-session dispatch threw for ${emittedId}: ${(e as Error).message}`,
      );
    }
  }

  if (anyDispatched) {
    await carryPrMetaIntoParsed(ctx.tenant_id, ctx.runId, result);
  }

  if (opts.backfillImprovementAttempt && decisionId) {
    try {
      const sb = serviceClient();
      const { error } = await sb
        .from("improvement_attempt")
        .update({ decision_id: decisionId })
        .eq("tenant_id", ctx.tenant_id)
        .eq("cto_run_id", ctx.runId)
        .is("decision_id", null);
      if (error) {
        console.warn(
          `[side-effect-dispatcher ${opts.slug}] improvement_attempt backfill failed: ${error.message}`,
        );
      }
    } catch (e) {
      console.warn(
        `[side-effect-dispatcher ${opts.slug}] improvement_attempt backfill threw: ${(e as Error).message}`,
      );
    }
  }

  return result;
}
