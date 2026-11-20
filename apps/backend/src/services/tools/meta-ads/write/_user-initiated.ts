
export type MatchConfidence = "exact" | "ambiguous";

export const MISPARSE_RATIO_LIMIT = 10;
export const MISPARSE_ABSOLUTE_LIMIT_USD = 10_000;

export const AUTHORIZED_EFFECTIVE_CAP = {
  enabled: true as const,
  max_daily_budget_usd: MISPARSE_ABSOLUTE_LIMIT_USD,
  max_pct_change_per_run: 50,
};

export function evaluateAgentUnsure(input: {
  match_confidence?: MatchConfidence;
  current_daily_budget_usd: number;
  proposed_daily_budget_usd: number;
}): { unsure: boolean; reason?: string } {
  if (input.match_confidence !== "exact") {
    return { unsure: true, reason: "ambiguous_match" };
  }
  if (input.proposed_daily_budget_usd > MISPARSE_ABSOLUTE_LIMIT_USD) {
    return { unsure: true, reason: "misparse_absolute" };
  }
  if (
    input.current_daily_budget_usd > 0 &&
    input.proposed_daily_budget_usd / input.current_daily_budget_usd >
      MISPARSE_RATIO_LIMIT
  ) {
    return { unsure: true, reason: "misparse_ratio" };
  }
  return { unsure: false };
}

export function minMergeCap(
  authorized: {
    enabled: true;
    max_daily_budget_usd: number;
    max_pct_change_per_run: number;
  },
  tenant: {
    enabled: boolean;
    max_daily_budget_usd: number | null;
    max_pct_change_per_run: number | null;
    max_daily_total_change_usd: number | null;
  } | null,
): {
  enabled: true;
  max_daily_budget_usd: number;
  max_pct_change_per_run: number;
  max_daily_total_change_usd: number | null;
} {
  if (tenant == null) {
    return {
      enabled: true,
      max_daily_budget_usd: authorized.max_daily_budget_usd,
      max_pct_change_per_run: authorized.max_pct_change_per_run,
      max_daily_total_change_usd: null,
    };
  }
  return {
    enabled: true,
    max_daily_budget_usd: minDefined(
      authorized.max_daily_budget_usd,
      tenant.max_daily_budget_usd,
    ),
    max_pct_change_per_run: minDefined(
      authorized.max_pct_change_per_run,
      tenant.max_pct_change_per_run,
    ),
    max_daily_total_change_usd: tenant.max_daily_total_change_usd,
  };
}

function minDefined(a: number, b: number | null): number {
  if (b == null) return a;
  return Math.min(a, b);
}
