
import type { Plan } from "@/services/agents/entitlement";
import {
  creditAllowanceFor,
  freeDailyCreditsFromBlob,
  FREE_DAILY_CREDITS_SQL_FALLBACK,
} from "@/services/agents/credits";
import { isPaidTier, isTier, tierCreditsFromBlob, type Tier } from "./tiers";
import { creditMonthWindow, paidWindowToday } from "./period";

export type BalanceSubRow = {
  plan: Plan | null;
  status: string | null;
  tier: string | null;
  current_period_end: string | null;
  comp_expires_at: string | null;
};

export type BalanceRow = {
  period_start: string;
  period_end: string;
  included_allowance: number;
  included_used: number;
  purchased_balance: number;
  reserved: number;
  daily_allowance: number | null;
  daily_used: number | null;
  daily_period_end: string | null;
};

export type BalanceConfigBlob = { free_daily_credits?: unknown; tier_credits?: unknown } | null | undefined;

export type CreditBalanceView = {
  plan: Plan;
  tier: Tier;
  period_start: string;
  period_end: string;
  allowance: number;
  used: number;
  reserved: number;
  purchased: number;
  daily_allowance: number;
  daily_used: number;
  included_remaining: number;
  daily_remaining: number;
  effective_available: number;
  credits_total: number;
  credits_used: number;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function creditBalanceView(
  sub: BalanceSubRow | null,
  bal: BalanceRow | null,
  blob: BalanceConfigBlob,
  now: Date = new Date(),
): CreditBalanceView {
  const compEnded = !!sub?.comp_expires_at && new Date(sub.comp_expires_at).getTime() <= now.getTime();
  const compTier = sub?.comp_expires_at && !compEnded && isPaidTier(sub.tier) ? sub.tier : null;
  const plan: Plan = compTier ? "team" : sub?.status === "incomplete" ? "free" : (sub?.plan ?? "free");
  const rawTier = compEnded ? null : sub?.tier;
  const tier: Tier = isTier(rawTier) ? rawTier : "free";

  const today = isoDay(now);
  const windowToday = plan === "free" ? today : paidWindowToday(sub?.current_period_end, now);
  const month =
    plan === "free"
      ? { start: today, end: isoDay(new Date(Date.parse(today) + 86_400_000)) }
      : creditMonthWindow(sub?.current_period_end ?? null, windowToday);
  const rowIsCurrent = !!bal && bal.period_end > windowToday;

  const paidTier =
    !compTier && sub?.status && ["active", "trialing", "past_due"].includes(sub.status) && isPaidTier(tier)
      ? tier
      : null;
  const planFallback = compTier
    ? tierCreditsFromBlob(blob)[compTier]
    : paidTier
      ? tierCreditsFromBlob(blob)[paidTier]
      : plan === "free"
      ? (freeDailyCreditsFromBlob(blob) ?? FREE_DAILY_CREDITS_SQL_FALLBACK)
      : creditAllowanceFor(plan);
  const allowance = rowIsCurrent ? bal!.included_allowance : planFallback;
  const used = rowIsCurrent ? bal!.included_used : 0;
  const reserved = bal?.reserved ?? 0;
  const purchased = bal?.purchased_balance ?? 0;

  const dailyIsCurrent = !!bal?.daily_period_end && bal.daily_period_end > today;
  const dailyAllowance = dailyIsCurrent ? (bal!.daily_allowance ?? 0) : 0;
  const dailyUsed = dailyIsCurrent ? (bal!.daily_used ?? 0) : 0;

  const includedRemaining = Math.max(0, allowance - used);
  const dailyRemaining = Math.max(0, dailyAllowance - dailyUsed);

  return {
    plan,
    tier,
    period_start: rowIsCurrent ? bal!.period_start : month.start,
    period_end: rowIsCurrent ? bal!.period_end : month.end,
    allowance,
    used,
    reserved,
    purchased,
    daily_allowance: dailyAllowance,
    daily_used: dailyUsed,
    included_remaining: includedRemaining,
    daily_remaining: dailyRemaining,
    effective_available: includedRemaining + dailyRemaining + purchased - reserved,
    credits_total: Math.max(0, allowance) + Math.max(0, dailyAllowance) + Math.max(0, purchased),
    credits_used: Math.max(0, used) + Math.max(0, dailyUsed),
  };
}
