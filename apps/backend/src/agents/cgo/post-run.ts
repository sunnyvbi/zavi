
import type { PostProcessorFn } from "@/agents/index";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isPlanReviewEnabled, reviewAndRevisePlan } from "./plan-review";
import { strategyTimingObserver, timeStrategyStep } from "@/services/growth/strategy-timing";
import { guardCompanyFacts } from "./strategy";
import { applyFounderOverlay, readFounderOverlay } from "./founder-overlay";
import { isCgoHandoffAnswer } from "./handoff-answer";
import { writeNote } from "@/services/memory";
import { logEvent } from "@/services/logging/logEvent";
import { applyGrowthStrategy, strategyFingerprint } from "@/services/growth/apply-strategy";
import {
  OWN_GOALS_STAGE,
  applyGoalMoves,
  evidenceFromPayload,
  parseGoalMoves,
  reviewMetaFromPayload,
  reviewedRevsFromPayload,
  shownCardsFromPayload,
} from "@/services/growth/goal-owner";
import { resolveNamedEngineerRepo } from "@/services/agents/engineer-dispatch-repo";
import { getTenantPersonalization, saveTenantPersonalization } from "@/services/personalization/store";
import {
  CURRENT_STRATEGY_TAG,
  carryApplyState,
  readRunCreatedAt,
  readStrategyNote,
  startedBeforeReset,
} from "@/services/growth/strategy-note";
import {
  TOOL_LABELS,
  gapsFromUnusedTools,
  observedTools,
  guardBasisEvidence,
  parseStrategy,
  renderStrategy,
} from "./strategy";

export { CURRENT_STRATEGY_TAG };

export function spineOf(strategy: unknown): string | null {
  if (!strategy || typeof strategy !== "object") return null;
  const s = strategy as {
    north_star?: { metric?: unknown };
    constraint?: { statement?: unknown };
  };
  const metric = typeof s.north_star?.metric === "string" ? s.north_star.metric.trim() : "";
  const statement =
    typeof s.constraint?.statement === "string" ? s.constraint.statement.trim() : "";
  if (!metric || !statement) return null;
  return `${metric.toLowerCase()}::${statement.toLowerCase()}`;
}

function appliedFingerprintOf(strategy: Parameters<typeof strategyFingerprint>[0]): string | null {
  try {
    return strategyFingerprint(strategy);
  } catch {
    return null;
  }
}

export async function liveReviewMeta(tenant_id: string, payload: unknown) {
  const meta = reviewMetaFromPayload(payload);
  if (!meta.autopilot) return meta;
  const { getBoolSettingStrictResolved } = await import("@/services/settings");
  return { ...meta, autopilot: await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id) };
}

export const cgoPostProcess: PostProcessorFn = async (ctx, result, payload) => {
  if (ctx.shadow_mode || ctx.draft_mode) return;
  try {
    await cgoPostProcessRun(ctx, result, payload);
  } finally {
    await queueChatAskFromTurn(ctx, result);
  }
};

export async function queueChatAskFromTurn(
  ctx: Parameters<PostProcessorFn>[0],
  result: Parameters<PostProcessorFn>[1],
  deps: { queue?: typeof import("@/services/growth/chat-ask").queueChatAskReview } = {},
): Promise<void> {
  if (ctx.trigger !== "chat") return;
  try {
    const { readChatAskCalls, queueChatAskReview, chatAskNotQueuedLine } = await import("@/services/growth/chat-ask");
    const { request, unreadable } = readChatAskCalls(result.tool_calls);
    if (!request) {
      if (unreadable) {
        console.warn(JSON.stringify({ event: "cgo.chat_ask.answer_unreadable", tenant_id: ctx.tenant_id, run_id: ctx.runId }));
        appendReplyLine(result, chatAskNotQueuedLine("failed"));
      }
      return;
    }
    const r = await (deps.queue ?? queueChatAskReview)({
      tenant_id: ctx.tenant_id,
      run_id: ctx.runId,
      user_id: ctx.actor?.actor_user_id ?? null,
      request,
    });
    if (!r.queued) appendReplyLine(result, chatAskNotQueuedLine(r.why));
  } catch (e) {
    console.warn(`[cgo post-run] chat ask not queued (run_id=${ctx.runId}): ${(e as Error).message}`);
  }
}

function appendReplyLine(result: Parameters<PostProcessorFn>[1], line: string): void {
  result.output_text = `${(result.output_text ?? "").trimEnd()}\n\n${line}`.trimStart();
  const parsed = result.parsed as { rendered_markdown?: unknown } | null | undefined;
  if (parsed && typeof parsed === "object" && typeof parsed.rendered_markdown === "string") {
    parsed.rendered_markdown = `${parsed.rendered_markdown.trimEnd()}\n\n${line}`;
  }
}

const cgoPostProcessRun: PostProcessorFn = async (ctx, result, payload) => {

  if (isCgoHandoffAnswer("cgo", ctx.trigger, payload)) return;

  if ((payload as { stage?: unknown } | undefined)?.stage === OWN_GOALS_STAGE) {
    const text = (result as { raw_response_text?: unknown }).raw_response_text ?? result.output_text ?? "";
    const parsed = parseGoalMoves(typeof text === "string" ? text : "");
    if (!parsed.ok) {
      console.warn(`[cgo post-run] goal review not applied (run_id=${ctx.runId}): ${parsed.reason}`);
      const why = `goal review not applied: ${parsed.reason}`;
      const prior = result.parse_error;
      result.parse_error = (!prior || prior.startsWith("no <") ? why : `${prior}; ${why}`).slice(0, 500);
      return;
    }
    const { flushPendingCgoNotes } = await import("@/services/growth/cgo-note-notifications");
    await flushPendingCgoNotes(ctx.tenant_id).catch((e) => console.warn(`[cgo post-run] pending notifications: ${(e as Error).message}`));
    const anomalyWake = (payload as { reason?: unknown } | undefined)?.reason === "metric_anomaly";
    const applied = await applyGoalMoves(ctx.tenant_id, ctx.runId, parsed.value, {
      emitDecision: ctx.emitDecision,
      resolveRepo: resolveNamedEngineerRepo,
      reviewedRevs: reviewedRevsFromPayload(payload),
      shownCards: shownCardsFromPayload(payload),
      replyPayload: payload,
      evidence: evidenceFromPayload(payload) ?? null,
      meta: await liveReviewMeta(ctx.tenant_id, payload),
      notify: !anomalyWake,
    });
    result.parse_ok = true;
    result.parse_error = undefined;
    console.info(`[cgo post-run] goal review applied (run_id=${ctx.runId}): ${JSON.stringify(applied)}`);
    if (applied.note_notify && applied.note_id && !anomalyWake) {
      try {
        const { inngest } = await import("@/../workers/client");
        await inngest.send({
          id: `cgo-note-email:${ctx.runId}`,
          name: "cgo/note.email",
          data: { run_id: ctx.runId, tenant_id: ctx.tenant_id },
        });
        const { error } = await tenantClient(asTenantId(ctx.tenant_id)).from("cgo_notes").update({ queued_at: new Date().toISOString() }).eq("tenant_id", ctx.tenant_id).eq("id", applied.note_id);
        if (error) throw new Error(`note queue mark failed: ${error.message}`);
      } catch (e) {
        console.warn(`[cgo post-run] note email event failed (run_id=${ctx.runId}): ${(e as Error).message}`);
      }
    }
    return;
  }

  const { cgoReplyMarker, founderReplyFromRun } = await import("@/services/growth/cgo-reply");
  if (cgoReplyMarker(payload)) {
    const reply = await founderReplyFromRun({ tenant_id: ctx.tenant_id, run_id: ctx.runId, trigger: ctx.trigger, payload });
    if (reply) {
      if (reply.via === "email") {
        const { suggestRuleFromEmailReply } = await import("@/services/rules/suggest");
        await suggestRuleFromEmailReply({ tenantId: ctx.tenant_id, runId: ctx.runId, payload, ownText: reply.text });
      }
      try {
        const { markFounderReplied } = await import("@/services/growth/cgo-questions");
        await markFounderReplied(ctx.tenant_id, new Date());
      } catch (e) {
        console.warn(`[cgo post-run] marking the founder's reply failed (run_id=${ctx.runId}): ${(e as Error).message}`);
      }
      try {
        const { enqueueGoalOwnerRun } = await import("@/services/growth/goal-owner");
        const r = await enqueueGoalOwnerRun({ tenant_id: ctx.tenant_id, reason: "founder_reply", founder_reply: reply });
        console.info(`[cgo post-run] founder reply (run_id=${ctx.runId}): ${JSON.stringify(r)}`);
        if (!r.enqueued && r.skipped === "no_active_goals") {
          const { applyFounderReplyWithoutReview } = await import("@/services/growth/founder-reply-approve");
          await applyFounderReplyWithoutReview(ctx.tenant_id, ctx.runId);
        }
      } catch (e) {
        console.warn(`[cgo post-run] founder reply review failed to start (run_id=${ctx.runId}): ${(e as Error).message}`);
      }
    }
    return;
  }

  const source =
    (result as { raw_response_text?: unknown }).raw_response_text ?? result.output_text ?? "";
  const parsed = parseStrategy(typeof source === "string" ? source : "");
  if (!parsed.ok) {
    if ((payload as { stage?: unknown } | undefined)?.stage === "draft_strategy") {
      result.parse_ok = false;
      result.parse_error = "strategy_missing";
    }
    console.info(
      `[cgo post-run] no strategy persisted (run_id=${ctx.runId}): ${parsed.reason}`,
    );
    return;
  }
  if (parsed.repaired) {
    await logEvent({
      level: "info",
      source: "cgo",
      code: "cgo.strategy_repaired",
      message: "strategy block parsed after repair",
      tenant_id: ctx.tenant_id,
      run_id: ctx.runId,
    });
  }

  const initialDraft = (payload as { stage?: unknown } | undefined)?.stage === "draft_strategy";
  if (initialDraft) {
    result.parse_ok = false;
    result.parse_error = "strategy_delivery_failed";
    const { advanceStrategyDelivery } = await import("@/services/growth/strategy-delivery");
    const receipt = await timeStrategyStep(ctx.tenant_id, ctx.runId, "delivery_check", () => advanceStrategyDelivery(ctx.tenant_id, ctx.runId, "checking"));
    if (receipt.phase === "superseded") { result.parse_error = "strategy_superseded"; return; }
    if (receipt.phase === "applied") { result.parse_ok = true; result.parse_error = undefined; return; }
  }
  const overlay = await readFounderOverlay(ctx.tenant_id, payload);
  let strategy = applyFounderOverlay(parsed.strategy, overlay);
  if (isPlanReviewEnabled()) {
    const review = await reviewAndRevisePlan({
      strategy,
      tools: result.tool_calls,
      payload: (payload ?? undefined) as Record<string, unknown> | undefined,
      onTiming: strategyTimingObserver(ctx.tenant_id, ctx.runId),
      overlay,
    });
    strategy = applyFounderOverlay(review.strategy, overlay);
    console.info(
      `[cgo post-run] plan review (run_id=${ctx.runId}): stopped=${review.stopped} scores=${review.passes
        .map((p) => p.overall.toFixed(1))
        .join(">")}`,
    );
  }

  {
    const company_facts = guardCompanyFacts(
      strategy.company_facts,
      (payload as { research?: unknown } | undefined)?.research,
    );
    const { company_facts: _dropped, ...rest } = strategy;
    strategy = company_facts ? { ...rest, company_facts } : rest;
  }

  const ranTools = observedTools(
    result.tool_calls as ReadonlyArray<{ name?: unknown; status?: unknown }> | undefined,
  );
  const availableTools = Object.keys(TOOL_LABELS);
  const evidence = [
    ...guardBasisEvidence(strategy.basis_evidence, { tools: ranTools }),
    ...gapsFromUnusedTools(availableTools, { tools: ranTools }),
  ];

  if (initialDraft) {
    const { deliverStrategy } = await import("@/services/growth/strategy-delivery");
    const receipt = await deliverStrategy(ctx.tenant_id, ctx.runId, { ...strategy, basis_evidence: evidence });
    result.parse_ok = receipt.phase === "applied";
    result.parse_error = result.parse_ok ? undefined : "strategy_superseded";
    return;
  }

  const existing = await readStrategyNote(ctx.tenant_id);
  const existingId = existing?.id ?? null;
  const priorMeta = existing?.metadata ?? {};

  if (priorMeta.reset_at !== undefined) {
    const runCreatedAt = await readRunCreatedAt(ctx.tenant_id, ctx.runId);
    if (!runCreatedAt) throw new Error("strategy_reset_check_failed");
    if (startedBeforeReset(runCreatedAt, priorMeta.reset_at)) {
      console.info(
        `[cgo post-run] run began before Start over; strategy discarded (run_id=${ctx.runId})`,
      );
      return;
    }
  }

  let written = false;
  try {
    await writeNote(ctx.tenant_id, {
      ...(existingId ? { id: existingId } : {}),
      note_type: "growth_strategy",
      title: `Growth strategy — ${strategy.north_star.metric}`,
      body_markdown: renderStrategy(strategy),
      source: "agent_run",
      source_ref: ctx.runId,
      tags: [CURRENT_STRATEGY_TAG, `confidence:${strategy.constraint.confidence}`],
      metadata: {
        ...carryApplyState(priorMeta),
        kind: "growth_strategy",
        accepted:
          priorMeta.accepted === true &&
          typeof priorMeta.applied_fingerprint === "string" &&
          priorMeta.applied_fingerprint === appliedFingerprintOf(strategy),
        strategy: { ...strategy, basis_evidence: evidence },
      },
    });
    written = true;
  } catch (e) {
    console.warn(
      `[cgo post-run] writeNote(growth strategy) failed (run_id=${ctx.runId}): ${
        (e as Error).message
      }`,
    );
  }

  if (strategy.brand_voice) {
    try {
      const current = await getTenantPersonalization(ctx.tenant_id);
      if (!current.brand_voice.trim()) {
        await saveTenantPersonalization(ctx.tenant_id, { brand_voice: strategy.brand_voice }, null);
      }
    } catch (e) {
      console.warn(`[cgo post-run] brand voice not saved (run_id=${ctx.runId}): ${(e as Error).message}`);
    }
  }

  try {
    const applied = await applyGrowthStrategy(ctx.tenant_id, { by: "agent", run_id: ctx.runId });
    if (!applied.applied && applied.skipped !== "no_strategy") {
      console.warn(
        `[cgo post-run] strategy not applied (run_id=${ctx.runId}, note_written=${written}): ${applied.problems.join("; ")}`,
      );
    }
  } catch (e) {
    console.warn(
      `[cgo post-run] apply failed (run_id=${ctx.runId}): ${(e as Error).message}`,
    );
  }
};
