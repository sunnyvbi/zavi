
export const STEP_PCT_CEILING = 0.3;
export const STEP_DOLLAR_FLOOR_USD = 10;

export function evaluateLearningPhaseStep(input: {
  current_daily_budget_usd: number;
  proposed_daily_budget_usd: number;
  delivering?: boolean;
  justifiedOversizedStep?: boolean;
  cgoBudgetBounds?: boolean;
}): { forceApproval: boolean; reason?: string; step_pct?: number } {
  const { current_daily_budget_usd, proposed_daily_budget_usd } = input;

  if (input.delivering !== true) return { forceApproval: false };

  const delta = proposed_daily_budget_usd - current_daily_budget_usd;
  if (delta <= 0) return { forceApproval: false };

  if (current_daily_budget_usd <= 0) return { forceApproval: false };

  const step_pct = delta / current_daily_budget_usd;

  const pctAllowed = step_pct <= STEP_PCT_CEILING;
  const floorAllowed = delta <= STEP_DOLLAR_FLOOR_USD;
  if (pctAllowed || floorAllowed) return { forceApproval: false, step_pct };

  if (input.justifiedOversizedStep === true) {
    return { forceApproval: false, step_pct };
  }
  if (input.cgoBudgetBounds === true) {
    return { forceApproval: false, reason: "cgo_budget_bounds_step", step_pct };
  }

  return { forceApproval: true, reason: "oversized_learning_phase_step", step_pct };
}

export async function cgoRunsAdsUnderBudget(tenant_id: string): Promise<boolean> {
  try {
    const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
    return (await cgoAdBudget(tenant_id)) !== null;
  } catch {
    return false;
  }
}
