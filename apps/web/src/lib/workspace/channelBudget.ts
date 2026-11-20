export const CHANNEL_BUDGET_EXHAUSTED =
  "You have used your channel budget for the last 30 days. It frees up as older runs pass the 30-day mark.";

export const CHANNEL_OUT_OF_CREDITS =
  "You're out of credits, so this channel can't run. Add credits on the pricing page and try again.";

export const CHANNEL_PLAN_UPGRADE =
  "Your plan doesn't include this channel. Upgrade your plan in Settings, under Billing, to run it.";

export function channelRunRefusalMessage(status: number | null, code: string | null): string {
  if (code === "plan_upgrade_required") return CHANNEL_PLAN_UPGRADE;
  if (status === 402 && code === "insufficient_credits") return CHANNEL_OUT_OF_CREDITS;
  if (status === 402) return CHANNEL_BUDGET_EXHAUSTED;
  if (status !== null && status >= 500) return "Zavi couldn't start this one. We've been told about it.";
  return "Couldn't start that. Try again in a moment.";
}
