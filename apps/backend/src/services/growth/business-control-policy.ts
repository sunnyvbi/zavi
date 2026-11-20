import { z } from "zod";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const BUSINESS_CONTROL_DEFAULTS = {
  enabled: false,
  metric: "cpa" as const,
  max_cpa_usd: 25,
  min_roas: 1,
  min_results: 10,
  min_spend_usd: 50,
  min_age_days: 7,
  exploration_percent: 10,
  step_percent: 20,
  reporting_delay_hours: 24,
  automatic_stops: false,
};

export const businessPolicySchema = z
  .object({
    enabled: z.boolean(),
    metric: z.enum(["cpa", "roas"]),
    max_cpa_usd: z.number().finite().positive().max(1_000_000),
    min_roas: z.number().finite().positive().max(1000),
    min_results: z.number().int().min(1).max(10_000),
    min_spend_usd: z.number().finite().positive().max(1_000_000),
    min_age_days: z.number().int().min(1).max(90),
    exploration_percent: z.number().finite().min(0).max(100),
    step_percent: z.number().int().min(1).max(100),
    reporting_delay_hours: z.number().int().min(1).max(72),
    automatic_stops: z.boolean(),
  })
  .strict();
export type BusinessPolicy = z.infer<typeof businessPolicySchema>;
export type SavedBusinessPolicy = BusinessPolicy & {
  revision: number;
  updated_at: string;
};

export async function readBusinessPolicy(
  tenantId: string,
): Promise<SavedBusinessPolicy | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("growth_business_policies")
    .select("policy, revision, updated_at")
    .maybeSingle<{ policy: unknown; revision: number; updated_at: string }>();
  if (error) throw new Error(`Business controls unavailable: ${error.message}`);
  if (!data) return null;
  return {
    ...businessPolicySchema.parse(data.policy),
    revision: data.revision,
    updated_at: data.updated_at,
  };
}

export type BusinessEvidence = {
  spend: number;
  results: number | null;
  revenue: number | null;
  age_days: number;
  fresh: boolean;
  tracking_ok: boolean;
  matches_goal: boolean;
  brand: boolean;
};
export type BusinessVerdict = {
  kind: "winner" | "loser" | "immature" | "unknown" | "protected";
  reason: string;
};

export function judgeBusinessResult(
  p: BusinessPolicy,
  e: BusinessEvidence,
): BusinessVerdict {
  if (e.brand)
    return {
      kind: "protected",
      reason: "Brand search keeps its existing budget.",
    };
  if (
    !e.fresh ||
    !e.tracking_ok ||
    !e.matches_goal ||
    !Number.isFinite(e.spend) ||
    e.spend < 0 ||
    e.results === null ||
    !Number.isFinite(e.results) ||
    e.results < 0 ||
    !Number.isFinite(e.age_days) ||
    (p.metric === "roas" &&
      (e.revenue === null || !Number.isFinite(e.revenue) || e.revenue < 0))
  ) {
    return {
      kind: "unknown",
      reason: "Fresh, goal-matched results and working tracking are required.",
    };
  }
  if (e.age_days < p.min_age_days || e.spend < p.min_spend_usd) {
    return {
      kind: "immature",
      reason: "The minimum age or spend has not been reached.",
    };
  }
  if (e.results === 0) {
    return e.spend >= Math.max(p.min_spend_usd, 2 * p.max_cpa_usd)
      ? {
          kind: "loser",
          reason: "No measured results after the no-result spend limit.",
        }
      : {
          kind: "immature",
          reason: "The no-result spend limit has not been reached.",
        };
  }
  if (e.results < p.min_results)
    return { kind: "immature", reason: "Too few results to judge efficiency." };
  const good =
    p.metric === "cpa"
      ? e.spend / e.results <= p.max_cpa_usd
      : e.revenue! / e.spend >= p.min_roas;
  return good
    ? {
        kind: "winner",
        reason: "Measured results meet the saved efficiency limit.",
      }
    : {
        kind: "loser",
        reason: "Measured results miss the saved efficiency limit.",
      };
}

export function recommendBusinessPolicy(evidence: BusinessEvidence[]): {
  policy: BusinessPolicy;
  explanation: string;
} {
  const eligible = evidence.filter(
    (e) =>
      e.fresh &&
      e.tracking_ok &&
      e.matches_goal &&
      !e.brand &&
      e.results !== null &&
      e.results >= BUSINESS_CONTROL_DEFAULTS.min_results &&
      e.spend >= 50,
  );
  const costs = eligible
    .map((e) => e.spend / e.results!)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const cpa = costs.length
    ? costs[Math.floor(costs.length / 2)]!
    : BUSINESS_CONTROL_DEFAULTS.max_cpa_usd;
  return {
    policy: {
      ...BUSINESS_CONTROL_DEFAULTS,
      max_cpa_usd: Math.min(
        1_000_000,
        Math.max(0.01, Math.round(cpa * 100) / 100),
      ),
    },
    explanation: costs.length
      ? "CPA starts at the median measured cost of eligible campaigns. This is a performance baseline, not a profitability estimate."
      : "Starter CPA is $25, paired with the existing $50 no-result evidence floor. ROAS 1 means revenue covers ad spend only, before product costs. Adjust these to your margins. Evidence: 7 days, 10 results and $50 spent; exploration: 10%; budget steps: 20%; reporting allowance: 24 hours.",
  };
}
