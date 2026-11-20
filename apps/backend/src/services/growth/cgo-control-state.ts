import { readActiveAdBudget } from "@/services/decisions/ad-budget";
import { readChatgptFundingContext } from "@/services/channels/chatgpt-ads/funding-context";
import { readCountedProjection } from "@/services/decisions/ad-month-counter";

const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

async function paceLine(tenant_id: string): Promise<string> {
  try {
    const p = (await readCountedProjection(tenant_id))?.projection;
    if (!p) return "unknown (no projection for this month).";
    const cents = (v: number) => Math.round(v * 100) / 100;
    return `${money(p.projected_usd)} projected this month at full running budgets plus approved changes not live yet, ${p.over ? `${money(cents(p.projected_usd - p.month_cap_usd))} over` : `${money(cents(p.month_cap_usd - p.projected_usd))} under`} the ${money(p.month_cap_usd)} cap.${p.over ? " While over, Autopilot adds no spend." : ""} Budget room figures come only from here or growth__ad_budget_room.`;
  } catch (e) {
    console.warn(`[cgo-control-state] month projection unreadable for ${tenant_id}: ${(e as Error).message}`);
    return "unknown (the projection could not be read).";
  }
}

export async function buildCgoControlStateBlock(tenant_id: string): Promise<string | null> {
  try {
    const { getBoolSettingStrictResolved } = await import("@/services/settings");
    const [autopilot, budget, chatgpt] = await Promise.all([
      getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id),
      readActiveAdBudget(tenant_id),
      readChatgptFundingContext(tenant_id),
    ]);
    const pace = budget ? await paceLine(tenant_id) : null;
    const budgetLine = budget
      ? `${money(budget.monthly_usd)} a month, active. This month: ${money(budget.spent_usd)} spent and ${money(budget.held_usd)} held on ads, ` +
        `${money(budget.creator_spent_usd)} spent and ${money(budget.creator_held_usd)} held on creators, ${money(budget.left_usd)} left of the ${money(budget.month_cap_usd)} cap` +
        `${budget.actual_read_at ? ` (ad spend as of ${budget.actual_read_at})` : " (ad spend not yet read this month)"}.`
      : "none active.";
    return (
      `\n\n## Your live control state (read at the start of this run — answer from verified fields; unavailable facts remain unknown)\n` +
      `- Autopilot: ${autopilot ? "ON — you may approve supported ad operations unattended, within the budget and the unattended policy." : "OFF — every ad change waits for the founder's approval."}\n` +
      `- Monthly ad budget: ${budgetLine}\n` +
      (pace ? `- Month pace: ${pace}\n` : "") +
      `- ChatGPT Ads: supported through the channel specialist and common approval rail. Delivered spend counts in the Growth budget; its prepaid wallet is a separate payment balance. ` +
      (chatgpt.status === "read"
        ? `${money(chatgpt.balance_cents / 100)} balance, ${money(chatgpt.reserved_cents / 100)} reserved, ${money(chatgpt.available_cents / 100)} available for additional reservations (wallet read ${chatgpt.read_at}). Auto-refill ${chatgpt.auto_refill_enabled ? "enabled by separate consent" : "off"}. `
        : "Wallet unreadable; do not infer zero funds. ") +
      `Automatic creation/launch requires explicit ChatGPT paid delegation, global Autopilot and an active Growth budget. Legacy research autorun or funding alone is not paid consent. Low unreserved balance does not prove existing campaigns lack funding; activation checks each campaign's remaining coverage.\n` +
      `- These two are separate: a budget can exist with Autopilot off (nothing runs unattended), and held money is reserved capacity, not delivered spend.`
    );
  } catch (e) {
    console.warn(`[cgo-control-state] unreadable for ${tenant_id}; block omitted: ${(e as Error).message}`);
    return null;
  }
}
