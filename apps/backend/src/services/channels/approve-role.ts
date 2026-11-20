
import { channelApproveNeedsAdmin } from "./approve-needs-admin";
import { DAYS_PER_MONTH, moneyAtStakeUsd } from "./money-at-stake";
import { createDailyUsd, totalBudgetUsd } from "./cap-warning";

export { channelActionAdminOnly, channelActionRaisesSpend } from "./approve-needs-admin";

export function channelActionNeedsAdmin(execClass: string | null | undefined, payload: unknown, channelSlug: string | null | undefined): boolean {
  const ec = execClass ?? "";
  if (!ec) return false;
  if (channelSlug === "chatgpt_ads" && !ec.startsWith("chatgpt_ads.")) return true;
  return channelApproveNeedsAdmin(ec, payload);
}

export type ApproveMoney = { daily_usd: number; monthly_usd: number } | { total_usd: number };

export function approveMoney(execClass: string | null | undefined, payload: unknown, cardBody: unknown): ApproveMoney | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  const m = moneyAtStakeUsd(execClass, payload, cardBody);
  if (m) return { daily_usd: round(m.monthly_usd / DAYS_PER_MONTH), monthly_usd: round(m.monthly_usd) };
  const daily = createDailyUsd(payload);
  if (daily != null) return { daily_usd: round(daily), monthly_usd: round(daily * DAYS_PER_MONTH) };
  const total = totalBudgetUsd(payload);
  return total != null ? { total_usd: round(total) } : null;
}
