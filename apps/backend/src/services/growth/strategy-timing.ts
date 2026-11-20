import { capturePlanStage } from "@/services/analytics/posthog";
import { logEvent } from "@/services/logging/logEvent";
import type { ReviewTiming } from "@/agents/cgo/plan-review";

type DeliveryStage = "artifact_save" | "apply" | "personalization" | "goal_attention" | "first_run" | "delivery_check";
type Timing = ReviewTiming | { stage: DeliveryStage; ms: number; outcome: "ok" | "error"; iteration?: number };

function reviewBarMetrics(event: Timing): Record<string, number> {
  const metrics: Record<string, number> = {};
  if (event.stage !== "review_scored") return metrics;
  for (const bar of ["constraint", "target", "actions", "effects", "grounding"] as const) {
    const score = event.scores?.[bar];
    const count = event.issueCounts?.[bar];
    if (typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10)
      metrics[`review_${bar}_score`] = score;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      metrics[`review_${bar}_issues`] = count;
  }
  return metrics;
}

function attemptMetrics(event: Timing): Record<string, number> {
  if (event.stage !== "revision_attempt" && event.stage !== "critic_fallback_attempt") return {};
  const t = event.attemptTiming;
  if (!t) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of [
    ["retry_count", t.attempt], ["prompt_chars", t.promptChars], ["provider_api_ms", t.apiMs],
    ["input_tokens", t.inputTokens], ["output_tokens", t.outputTokens],
    ["cache_read_tokens", t.cacheReadTokens], ["cache_write_tokens", t.cacheWriteTokens],
  ] as const) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

export function strategyTimingObserver(tenant: string, run: string): (event: Timing) => void {
  return event => {
    void logEvent({
      level: "info", source: "cgo.strategy", code: "strategy_stage_timing", tenant_id: tenant, run_id: run,
      meta: {
        ...reviewBarMetrics(event),
        ...attemptMetrics(event),
        agent_slug: "cgo", stage: event.stage, ms: event.ms, outcome: event.outcome,
        step_index: event.iteration ?? 0,
        ...("issues" in event && event.issues !== undefined ? { count: event.issues } : {}),
        ...("score" in event && event.score !== undefined ? { review_score: event.score } : {}),
        ...("unsupported" in event && event.unsupported !== undefined ? { review_unsupported: event.unsupported } : {}),
        ...("httpStatus" in event && event.httpStatus !== undefined ? { http_status: event.httpStatus } : {}),
      },
    }).catch(() => {  });
    if (event.stage !== "review_scored" && event.stage !== "revision_attempt" && event.stage !== "critic_fallback_attempt") capturePlanStage(tenant, run, event.stage, event.ms, { outcome: event.outcome, step_index: event.iteration ?? 0 });
  };
}

export async function timeStrategyStep<T>(tenant: string, run: string, stage: DeliveryStage, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let outcome: "ok" | "error" = "ok";
  try { return await work(); }
  catch (e) { outcome = "error"; throw e; }
  finally { strategyTimingObserver(tenant, run)({ stage, ms: Math.max(0, Date.now() - started), outcome }); }
}
