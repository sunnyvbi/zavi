
export const CAP_REASONS = [
  "no_cap_configured",
  "cap_disabled",
  "over_absolute_ceiling",
  "over_pct_change",
  "over_daily_aggregate",
] as const;
export type CapReason = (typeof CAP_REASONS)[number];
export const OVER_LIMIT_CAP_REASONS: ReadonlySet<string> = new Set<CapReason>([
  "over_absolute_ceiling",
  "over_pct_change",
  "over_daily_aggregate",
]);

export type Cap = {
  enabled: boolean;
  max_daily_budget_usd: number | null;
  max_pct_change_per_run: number | null;
  max_daily_total_change_usd: number | null;
};

export function capCountedChangeUsd(proposed_daily_budget_usd: number, current_daily_budget_usd: number): number {
  return Math.max(proposed_daily_budget_usd - current_daily_budget_usd, 0);
}

export function evaluateBudgetCap(input: {
  proposed_daily_budget_usd: number;
  current_daily_budget_usd: number;
  today_total_change_usd: number;
  cap: Cap | null;
}): { within: boolean; reason?: CapReason } {
  const { proposed_daily_budget_usd, current_daily_budget_usd, today_total_change_usd, cap } = input;

  if (cap == null) return { within: false, reason: "no_cap_configured" };
  if (!cap.enabled) return { within: false, reason: "cap_disabled" };

  const delta = capCountedChangeUsd(proposed_daily_budget_usd, current_daily_budget_usd);
  if (delta === 0) return { within: true };

  if (cap.max_daily_budget_usd != null && proposed_daily_budget_usd > cap.max_daily_budget_usd) {
    return { within: false, reason: "over_absolute_ceiling" };
  }

  if (cap.max_pct_change_per_run != null && current_daily_budget_usd > 0) {
    const pct = delta / current_daily_budget_usd;
    if (pct > cap.max_pct_change_per_run) {
      return { within: false, reason: "over_pct_change" };
    }
  }

  if (
    cap.max_daily_total_change_usd != null &&
    today_total_change_usd + delta > cap.max_daily_total_change_usd
  ) {
    return { within: false, reason: "over_daily_aggregate" };
  }

  return { within: true };
}
