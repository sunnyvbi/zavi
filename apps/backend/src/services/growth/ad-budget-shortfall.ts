
import { readAdBudgetMonthView, budgetMargin, type AdBudgetMonthView } from "@/services/decisions/ad-budget";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { updateAdSetBudgetBodySchema, updateCampaignBudgetBodySchema as metaCampaignBudgetBodySchema } from "@/services/tools/meta-ads/write/_decision-bodies";
import { updateCampaignBudgetBodySchema } from "@/services/tools/google-ads/write/_decision-bodies";
import { growthBudgetBody } from "@/services/connectors/chatgpt-ads/growth-actions";
import { normalizeCurrency } from "@/services/tools/meta-ads/write/_currency";

export type BudgetRaiseNeed =
  | { kind: "fits" }
  | { kind: "needs_raise"; budget_id: string; from_usd: number; to_usd: number; daily_limit_usd: number | null }
  | { kind: "not_a_raise" }
  | { kind: "no_budget" }
  | { kind: "unfixable"; why: "over_daily_limit" | "non_usd_account" }
  | { kind: "unreadable" };

type Raise = { platform: "meta" | "google" | "chatgpt"; object_id: string; new_daily_usd: number; current_daily_usd: number };
export type LiveHold = { platform: string; object_id: string | null; daily_delta_usd: number; pause_due: boolean };

const ceil2 = (n: number) => Math.ceil(Number((n * 100).toFixed(6))) / 100;
const floor2 = (n: number) => Math.floor(Number((n * 100).toFixed(6))) / 100;

export function raiseFromCard(exec_class: string | null | undefined, exec_payload: unknown): Raise | "not_a_raise" | "non_usd" | null {
  const cls = (exec_class ?? "").replace(/_review$/, "");
  if (cls === "chatgpt_ads.update_campaign_budget") {
    const p = growthBudgetBody.safeParse(exec_payload);
    if (!p.success) return null;
    if (p.data.daily_budget_usd <= p.data.expected_current_daily_budget_usd) return "not_a_raise";
    return { platform: "chatgpt", object_id: p.data.campaign_id, new_daily_usd: p.data.daily_budget_usd, current_daily_usd: p.data.expected_current_daily_budget_usd };
  }
  if (cls === "google_ads.update_campaign_budget") {
    const p = updateCampaignBudgetBodySchema.safeParse(exec_payload);
    if (!p.success) return null;
    if (p.data.daily_budget_usd <= p.data.expected_current_daily_budget_usd) return "not_a_raise";
    return { platform: "google", object_id: p.data.campaign_id, new_daily_usd: p.data.daily_budget_usd, current_daily_usd: p.data.expected_current_daily_budget_usd };
  }
  if (cls === "meta_ads.update_ad_set_budget") {
    const p = updateAdSetBudgetBodySchema.safeParse(exec_payload);
    if (!p.success) return null;
    if (p.data.daily_budget_usd <= p.data.expected_current_daily_budget_usd) return "not_a_raise";
    if (normalizeCurrency(p.data.currency) !== "USD") return "non_usd";
    return { platform: "meta", object_id: p.data.ad_set_id, new_daily_usd: p.data.daily_budget_usd, current_daily_usd: p.data.expected_current_daily_budget_usd };
  }
  if (cls === "meta_ads.update_campaign_budget") {
    const p = metaCampaignBudgetBodySchema.safeParse(exec_payload);
    if (!p.success) return null;
    if (p.data.daily_budget_usd <= p.data.expected_current_daily_budget_usd) return "not_a_raise";
    if (normalizeCurrency(p.data.currency) !== "USD") return "non_usd";
    return { platform: "meta", object_id: p.data.campaign_id, new_daily_usd: p.data.daily_budget_usd, current_daily_usd: p.data.expected_current_daily_budget_usd };
  }
  return "not_a_raise";
}

function firstMonthDays(view: AdBudgetMonthView): number | null {
  const day = Number(view.started_on.slice(8, 10));
  if (!Number.isInteger(day) || day < 1 || !view.days_in_month) return null;
  return view.days_in_month - day + 1;
}

export function monthlyNeededForCap(view: AdBudgetMonthView, needCap: number): number | null {
  if (needCap <= view.month_cap_usd + 1e-9) return view.monthly_usd;
  const prorated = view.month_cap_usd < view.monthly_usd - 0.005;
  if (!prorated) return Math.ceil(Number((view.monthly_usd + (needCap - view.month_cap_usd)).toFixed(6)));
  const days = firstMonthDays(view);
  if (!days) return null;
  const ratio = days / view.days_in_month;
  if (Math.abs(floor2(view.monthly_usd * ratio) - view.month_cap_usd) > 0.011) return null;
  let to = Math.ceil(needCap / ratio);
  while (floor2(to * ratio) < needCap - 1e-9) to += 1;
  return to;
}

export function computeBudgetRaiseNeed(raise: Raise, view: AdBudgetMonthView, holds: readonly LiveHold[]): BudgetRaiseNeed {
  const margin = budgetMargin(view);
  const delta = Math.max(ceil2((raise.new_daily_usd - raise.current_daily_usd) * (raise.platform === "chatgpt" ? 2 : 1)), 0);
  if (delta === 0) return { kind: "fits" };
  if (view.daily_limit_usd != null) {
    const liveDaily = holds.reduce((s, h) => s + h.daily_delta_usd, 0);
    if (liveDaily + delta > view.daily_limit_usd + 1e-9) return { kind: "unfixable", why: "over_daily_limit" };
  }
  const amount = ceil2(delta * view.days_left * margin);
  const room = view.month_cap_usd - view.spent_usd - view.held_usd - view.creator_held_usd - view.creator_spent_usd;
  const shortfall = amount - room;
  if (shortfall <= 1e-9) return { kind: "fits" };

  const to = monthlyNeededForCap(view, view.month_cap_usd + shortfall);
  if (to === null || !Number.isFinite(to) || to <= view.monthly_usd) return { kind: "unreadable" };
  return { kind: "needs_raise", budget_id: view.id, from_usd: view.monthly_usd, to_usd: to, daily_limit_usd: view.daily_limit_usd };
}

export type BudgetRaiseDeps = {
  readView?: typeof readAdBudgetMonthView;
  readHolds?: (tenant_id: string, budget_id: string) => Promise<LiveHold[]>;
};

async function readLiveHolds(tenant_id: string, budget_id: string): Promise<LiveHold[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_budget_reservations")
    .select("platform, object_id, daily_delta_usd, pause_due")
    .eq("tenant_id", tenant_id)
    .eq("budget_id", budget_id)
    .in("status", ["reserved", "committed"])
    .limit(2000);
  if (error) throw new Error(`ad budget holds read failed: ${error.message}`);
  return ((data ?? []) as Array<{ platform: string; object_id: string | null; daily_delta_usd: number | string; pause_due: boolean | null }>).map((r) => {
    const d = Number(r.daily_delta_usd);
    if (!Number.isFinite(d)) throw new Error("ad budget holds read returned an unreadable amount");
    return { platform: r.platform, object_id: r.object_id, daily_delta_usd: d, pause_due: r.pause_due === true };
  });
}

export async function budgetRaiseNeed(
  tenant_id: string,
  card: { exec_class: string | null | undefined; exec_payload: unknown },
  deps: BudgetRaiseDeps = {},
): Promise<BudgetRaiseNeed> {
  const raise = raiseFromCard(card.exec_class, card.exec_payload);
  if (raise === null) return { kind: "unreadable" };
  if (raise === "not_a_raise") return { kind: "not_a_raise" };
  try {
    const view = await (deps.readView ?? readAdBudgetMonthView)(tenant_id);
    if (!view || view.status !== "active") return { kind: "no_budget" };
    if (raise === "non_usd") return { kind: "unfixable", why: "non_usd_account" };
    const holds = await (deps.readHolds ?? readLiveHolds)(tenant_id, view.id);
    return computeBudgetRaiseNeed(raise, view, holds);
  } catch (e) {
    console.warn(`[ad-budget-shortfall] unreadable for ${tenant_id}: ${(e as Error).message}`);
    return { kind: "unreadable" };
  }
}

const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export { budgetRaiseSentence } from "./cgo-note-items";

export const monthlyBudgetNow = (to_usd: number) => `Your monthly ad budget is now ${money(to_usd)}`;

export async function annotateBudgetNeeds(
  tenant_id: string,
  items: Array<{ section: string; action_id?: string; approved?: boolean; budget_from_usd?: number; budget_to_usd?: number; card_change?: string }>,
  deps: BudgetRaiseDeps & { readCards?: (tenant_id: string, ids: string[]) => Promise<Array<{ id: string; exec_class: string | null; exec_payload: unknown }>> } = {},
): Promise<void> {
  const waiting = items.filter((i) => i.section === "needs_you" && i.action_id && !i.approved);
  if (waiting.length === 0) return;
  try {
    const { cardChangeSentence } = await import("./card-change");
    const ids = [...new Set(waiting.map((i) => i.action_id!))];
    const cards = await (deps.readCards ?? readPendingCards)(tenant_id, ids);
    for (const card of cards) {
      const mine = waiting.filter((i) => i.action_id === card.id);
      const sentence = cardChangeSentence(card.exec_class, card.exec_payload);
      for (const i of mine) {
        if (sentence) i.card_change = sentence;
        else delete i.card_change;
      }
      if (raiseFromCard(card.exec_class, card.exec_payload) === "not_a_raise") continue;
      if (mine.every((i) => i.budget_to_usd !== undefined)) continue;
      const need = await budgetRaiseNeed(tenant_id, card, deps);
      if (need.kind !== "needs_raise") continue;
      for (const i of mine) {
        if (i.budget_to_usd !== undefined) continue;
        i.budget_from_usd = need.from_usd;
        i.budget_to_usd = need.to_usd;
      }
    }
    const live = new Set(cards.map((c) => c.id));
    for (const i of waiting) if (!live.has(i.action_id!)) delete i.card_change;
  } catch (e) {
    console.warn(`[ad-budget-shortfall] note card lines skipped for ${tenant_id}: ${(e as Error).message}`);
  }
}

async function readPendingCards(tenant_id: string, ids: string[]) {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, exec_class, exec_payload")
    .eq("tenant_id", tenant_id)
    .eq("status", "pending")
    .in("id", ids.slice(0, 50));
  if (error) throw new Error(`cards read failed: ${error.message}`);
  return (data ?? []) as Array<{ id: string; exec_class: string | null; exec_payload: unknown }>;
}
