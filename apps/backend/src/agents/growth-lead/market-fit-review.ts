
import type { AgentContext } from "@/services/agents/types";
import type { DispatcherResult } from "@/services/agents/types";
import { logEvent } from "@/services/logging/logEvent";
import { resolveMarketFitVerdict } from "@/services/meta-ads/strategist-gate/resolve-verdict";
import { reviewStateDeps, findFinalCreateFor } from "@/services/meta-ads/strategist-gate/review-state";
import { parseMarketFitVerdict } from "@/services/meta-ads/strategist-gate/verdict-text";
import { FINAL_CREATE_CLASS } from "@/services/meta-ads/strategist-gate/constants";
import { emitFinalCreateIdempotent } from "@/services/meta-ads/strategist-gate/emit-idempotent";

export type MarketFitReviewPayload = {
  market_fit_review: { pending_decision_id: string };
};

export function isMarketFitReviewPayload(payload: unknown): payload is MarketFitReviewPayload {
  if (!payload || typeof payload !== "object") return false;
  const mfr = (payload as { market_fit_review?: unknown }).market_fit_review;
  return (
    !!mfr &&
    typeof mfr === "object" &&
    typeof (mfr as { pending_decision_id?: unknown }).pending_decision_id === "string" &&
    (mfr as { pending_decision_id: string }).pending_decision_id.length > 0
  );
}

export function reviewedPendingDecisionId(payload: unknown): string | null {
  return isMarketFitReviewPayload(payload)
    ? payload.market_fit_review.pending_decision_id
    : null;
}

function verdictSourceText(result: DispatcherResult): string {
  return [result.output_text, result.raw_response_text]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n");
}

export async function maybeResolveMarketFitReview(
  ctx: AgentContext,
  result: DispatcherResult,
  payload: unknown,
): Promise<boolean> {
  const pendingDecisionId = reviewedPendingDecisionId(payload);
  if (!pendingDecisionId) return false;

  const parsed = parseMarketFitVerdict(verdictSourceText(result));
  if (!parsed) {
    await logEvent({
      level: "warn",
      source: "growth-lead.market-fit-review",
      code: "verdict_unparseable",
      tenant_id: ctx.tenant_id,
      meta: { pending_decision_id: pendingDecisionId },
    });
    return true;
  }

  await resolveMarketFitVerdict(
    {
      pending_decision_id: pendingDecisionId,
      tenant_id: ctx.tenant_id,
      verdict: parsed.verdict,
      reason: parsed.reason,
      review_run_id: ctx.runId,
    },
    {
      ...reviewStateDeps,
      emitFinalCreate: async ({ body, tenant_id }) => {
        const { resolveCreateAdSetBid } = await import("@/services/tools/meta-ads/write/_ad-set-bid");
        type Draft = Parameters<typeof resolveCreateAdSetBid>[1];
        const withBid = (await resolveCreateAdSetBid(tenant_id, body as unknown as Draft)) as unknown as Record<string, unknown>;
        return emitFinalCreateIdempotent({
          rawEmit: (b) => ctx.emitDecision(FINAL_CREATE_CLASS, b),
          findExisting: findFinalCreateFor,
          body: withBid,
          tenant_id,
          pending_decision_id: pendingDecisionId,
        });
      },
      log: async (evt) =>
        logEvent({
          level: evt.level,
          source: "growth-lead.market-fit-review",
          code: evt.code,
          tenant_id: evt.tenant_id,
          meta: evt.meta,
        }),
    },
  );
  return true;
}
