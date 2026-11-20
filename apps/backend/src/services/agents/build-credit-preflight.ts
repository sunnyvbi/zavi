
import { STAGE_AGENT } from "@/services/agents/autopilot-pipeline-contract";
import { tierCreditsFromBlob, isPaidTier } from "@/services/billing/tiers";
import {
  reserveEstimateFor,
  creditAllowanceFor,
  FREE_DAILY_CREDITS_SQL_FALLBACK,
  freeDailyCreditsFromBlob,
  creditsEnforcedFromBlob,
  creditsToUsd,
} from "@/services/agents/credits";

export class InsufficientCreditsForBuild extends Error {
  constructor(
    public readonly required_credits: number,
    public readonly remaining_credits: number,
    public readonly free_plan: boolean = false,
    public readonly scope: "build" | "change" = "build",
  ) {
    super(
      `not enough credits to ${scope === "change" ? "make this change" : "finish this build"}: it needs about ${required_credits.toLocaleString()} credits ` +
        `($${creditsToUsd(required_credits).toFixed(2)}) and this workspace has ${remaining_credits.toLocaleString()} left. ` +
        `Nothing was created — top up and start it again.`,
    );
    this.name = "InsufficientCreditsForBuild";
  }
}

export function estimateBuildReserveCredits(
  opts?: { includeRepoAnalysis?: boolean },
): number {
  const includeRepoAnalysis =
    opts?.includeRepoAnalysis ?? process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED === "1";
  let total = 0;
  for (const [stage, slug] of Object.entries(STAGE_AGENT)) {
    if (!slug) continue;
    if (stage === "qa") continue;
    if (stage === "repo_analysis" && !includeRepoAnalysis) continue;
    total += reserveEstimateFor(slug);
  }
  return total;
}

export const MEASURED_BUILD_P90_CREDITS = 6_500;

export function requiredBuildCredits(opts?: { includeRepoAnalysis?: boolean }): number {
  return Math.max(estimateBuildReserveCredits(opts), MEASURED_BUILD_P90_CREDITS);
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export type CreditPreflightDeps = {
  readBalance?: (tenant_id: string) => Promise<BalanceState | null>;
};

export type BalanceReadClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => { maybeSingle: <T = unknown>() => Promise<{ data: T | null; error: unknown }> };
    };
  };
};

export type BalanceState = { remaining: number; enforced: boolean; unlimited: boolean; free_plan?: boolean };

export function makeBalanceReader(
  sb: BalanceReadClient,
): (tenant_id: string) => Promise<BalanceState | null> {
  return async function readBalance(tenant_id: string): Promise<BalanceState | null> {
  const [cfg, tenant, balance, sub] = await Promise.all([
    sb.from("system_config").select("blob").eq("id", 1).maybeSingle(),
    sb
      .from("tenants")
      .select("credits_unlimited")
      .eq("id", tenant_id)
      .maybeSingle<{ credits_unlimited: boolean | null }>(),
    sb
      .from("tenant_credit_balances")
      .select("included_allowance, included_used, purchased_balance, reserved, period_end")
      .eq("tenant_id", tenant_id)
      .maybeSingle(),
    sb
      .from("tenant_subscriptions")
      .select("plan, status, tier, comp_expires_at")
      .eq("tenant_id", tenant_id)
      .maybeSingle<{ plan?: string; status?: string; tier?: string | null; comp_expires_at?: string | null }>(),
  ]);

  if (balance.error) return null;

  const blob = (cfg.data as { blob?: Record<string, unknown> } | null)?.blob ?? null;
  const enforced = creditsEnforcedFromBlob(
    blob as { credits_enforced?: boolean; credits_enforced_allowlist?: unknown } | null,
    tenant_id,
  );
  const unlimited = tenant.data?.credits_unlimited === true;

  const cb = balance.data as {
    included_allowance: number;
    included_used: number;
    purchased_balance: number;
    reserved: number;
    period_end: string;
  } | null;

  const today = todayUtcDate();
  const compAt = sub.data?.comp_expires_at ? new Date(sub.data.comp_expires_at).getTime() : null;
  const compActive = compAt !== null && compAt > Date.now();
  const compEnded = compAt !== null && !compActive;
  const unpaid = sub.data?.status === "canceled" || sub.data?.status === "incomplete";
  const canceled = (unpaid && !compActive) || compEnded;
  const rowIsCurrent = !!cb && cb.period_end > today && !canceled;
  const plan = canceled ? "free" : (sub.data?.plan ?? "free");
  const freeDailyGrant =
    freeDailyCreditsFromBlob(blob as { free_daily_credits?: unknown } | null) ?? FREE_DAILY_CREDITS_SQL_FALLBACK;
  const compTier = compActive && isPaidTier(sub.data?.tier) ? sub.data!.tier : null;
  const allowance = rowIsCurrent
    ? cb!.included_allowance
    : compTier
      ? tierCreditsFromBlob(blob as Parameters<typeof tierCreditsFromBlob>[0])[compTier]
      : plan === "free"
        ? freeDailyGrant
        : creditAllowanceFor(plan);
  const used = rowIsCurrent ? cb!.included_used : 0;
  const reserved = cb?.reserved ?? 0;
  const purchased = cb?.purchased_balance ?? 0;
  const remaining = Math.max(0, Math.max(0, allowance - used) + purchased - reserved);

  const paidTierLive =
    !compEnded &&
    isPaidTier(sub.data?.tier) &&
    ["active", "trialing", "past_due"].includes(sub.data?.status ?? "");
  const free_plan =
    !sub.error && plan === "free" && !compActive && !paidTierLive && purchased <= 0;

  return { remaining, enforced, unlimited, free_plan };
  };
}

export async function assertBuildCreditsAvailable(
  tenant_id: string,
  deps: CreditPreflightDeps = {},
): Promise<void> {
  return assertCreditsCover(tenant_id, requiredBuildCredits(), "build", deps);
}

export function requiredRefineCredits(): number {
  return reserveEstimateFor("engineer");
}

export async function assertRefineCreditsAvailable(
  tenant_id: string,
  deps: CreditPreflightDeps = {},
): Promise<void> {
  return assertCreditsCover(tenant_id, requiredRefineCredits(), "change", deps);
}

async function assertCreditsCover(
  tenant_id: string,
  required: number,
  scope: "build" | "change",
  deps: CreditPreflightDeps,
): Promise<void> {
  const read = deps.readBalance;
  if (!read) return;
  let state: BalanceState | null;
  try {
    state = await read(tenant_id);
  } catch {
    return;
  }
  if (!state) return;
  if (!state.enforced || state.unlimited) return;

  if (state.remaining < required) {
    throw new InsufficientCreditsForBuild(required, state.remaining, state.free_plan === true, scope);
  }
}
