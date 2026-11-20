
import { STRATEGIST_AGENT_SLUG } from "./constants";
import { upsertReviewRow, setReviewRunId } from "./review-state";
import { pendingStrategistBodySchema } from "./pending-body";

function buildReviewIntent(args: {
  pending_decision_id: string;
  campaign_id: string;
  name: string;
  daily_budget_usd: number;
  optimization_goal: string;
  promoted_event?: string;
}): string {
  return [
    "MARKET-FIT REVIEW — a performance-marketer wants to CREATE a new Meta ad set.",
    "Judge market fit BEFORE the operator sees it: is this a served market? is there both-sided (supply AND demand) liquidity in this geo? is it optimizing toward a cold, zero-history event?",
    "",
    `New ad set: "${args.name}" under campaign ${args.campaign_id}, $${args.daily_budget_usd}/day, optimization_goal=${args.optimization_goal}${args.promoted_event ? `, promoted_event=${args.promoted_event}` : ""}.`,
    "",
    "End your answer with EXACTLY one verdict line, then a reason line:",
    "MarketFitVerdict: APPROVE   (the market is served + liquid enough to spend)",
    "  — or —",
    "MarketFitVerdict: BOUNCE    (not a served market / no liquidity / cold event — do NOT surface to the operator)",
    "Reason: <one line, <=500 chars>",
  ].join("\n");
}

export async function enqueueStrategistReview(args: {
  pending_decision_id: string;
  tenant_id: string;
  pending_body: unknown;
}): Promise<{ run_id: string | null }> {
  await upsertReviewRow({
    pending_decision_id: args.pending_decision_id,
    tenant_id: args.tenant_id,
  });

  const parsed = pendingStrategistBodySchema.safeParse(args.pending_body);
  const create = parsed.success ? parsed.data.create_ad_set : null;
  const promoted_event = parsed.success ? parsed.data.promoted_event : undefined;

  const intent = create
    ? buildReviewIntent({
        pending_decision_id: args.pending_decision_id,
        campaign_id: create.campaign_id,
        name: create.name,
        daily_budget_usd: create.daily_budget_usd,
        optimization_goal: create.optimization_goal,
        promoted_event,
      })
    : `MARKET-FIT REVIEW for a parked create-ad-set proposal (${args.pending_decision_id}). Reply with MarketFitVerdict: APPROVE|BOUNCE + Reason:.`;

  let run_id: string | null = null;
  try {
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    const res = await enqueueAgentRun({
      agent_slug: STRATEGIST_AGENT_SLUG,
      tenant_id: args.tenant_id,
      trigger: "a2a",
      payload: {
        intent,
        market_fit_review: {
          pending_decision_id: args.pending_decision_id,
        },
        dispatched_by: "performance-marketer",
        source_decision_id: args.pending_decision_id,
      },
    });
    run_id = res.run_id;
  } catch (e) {
    console.warn(
      `[strategist-gate] enqueueStrategistReview: growth-lead enqueue failed for ${args.pending_decision_id}: ${(e as Error).message}`,
    );
    return { run_id: null };
  }

  if (run_id) {
    await setReviewRunId({
      pending_decision_id: args.pending_decision_id,
      tenant_id: args.tenant_id,
      review_run_id: run_id,
    });
  }
  return { run_id };
}
