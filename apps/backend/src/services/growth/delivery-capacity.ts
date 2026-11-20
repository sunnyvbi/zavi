
export const LAUNCH_GRACE_HOURS = 24;
export const LAUNCH_GRACE_MS = LAUNCH_GRACE_HOURS * 3_600_000;
export const OBSERVED_DAYS = 3;

export function dailyBudgetCapacityUsd(
  budget_usd: number,
  i: { just_launched: boolean;  spend_observed_usd: number },
): number {
  if (!(budget_usd > 0)) return 0;
  if (i.just_launched) return budget_usd;
  const spent = Math.max(0, i.spend_observed_usd);
  if (spent <= 0) return 0;
  return Math.round(Math.min(budget_usd, spent / OBSERVED_DAYS) * 100) / 100;
}
