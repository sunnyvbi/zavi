import type { ChangeFit } from "@/services/decisions/ad-month-counter";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export type BudgetChoiceView =
  | { kind: "fits" }
  | { kind: "over"; month_label: string; projection_usd: number; monthly_usd: number;  month_cap_usd: number; over_by_usd: number; raise_to_usd: number | null; daily_limit_usd: number | null; daily_limit_to_usd: number | null; set_aside_over?: boolean; find_money?: FindMoneyState | null; find_money_why?: "set_aside" | "spent" | "not_enough" | "no_candidates" | "non_usd" | null }
  | { kind: "unreadable"; why: string };
export type FindMoneyState = "available" | "none" | "unreadable";
export type ChoiceAsk = { raise_budget_to_usd?: number; raise_daily_limit_to_usd?: number };
export type ChoiceCode = "budget_unreadable" | "budget_choice_in_zavi" | "budget_choice_required" | "budget_raise_changed" | "budget_raise_failed" | "decision_closed" | "card_changed";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const monthOf = (month_start: string) => new Date(`${month_start}T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

export function budgetChoiceView(fit: ChangeFit): BudgetChoiceView | null {
  if (fit.kind === "no_budget" || fit.kind === "not_a_raise") return null;
  if (fit.kind === "fits") return { kind: "fits" };
  if (fit.kind === "unreadable") return { kind: "unreadable", why: fit.why };
  return {
    kind: "over",
    month_label: monthOf(fit.count.month_start),
    projection_usd: Math.round(fit.with_usd),
    monthly_usd: fit.count.monthly_usd,
    month_cap_usd: fit.count.month_cap_usd,
    over_by_usd: Math.round(fit.over_by_usd),
    raise_to_usd: fit.raise_to_usd,
    daily_limit_usd: fit.daily_limit_usd,
    daily_limit_to_usd: fit.daily_limit_to_usd,
    ...(fit.set_aside_over ? { set_aside_over: true } : {}),
  };
}

export function capWords(v: { month_label: string; monthly_usd: number; month_cap_usd?: number | null }): string {
  const cap = typeof v.month_cap_usd === "number" && Number.isFinite(v.month_cap_usd) ? v.month_cap_usd : v.monthly_usd;
  return cap < v.monthly_usd ? `your ${usd(cap)} ${v.month_label} budget` : `your ${usd(v.monthly_usd)} budget`;
}

export function blockWords(v: Extract<BudgetChoiceView, { kind: "over" }>): string {
  return [
    v.raise_to_usd === null
      ? null
      : v.set_aside_over
        ? `With what is already set aside for your running ads in ${v.month_label}, this goes past ${capWords(v)}.`
        : `${v.month_label} is projected at about ${usd(v.projection_usd)}, over ${capWords(v)}.`,
    v.daily_limit_to_usd !== null && v.daily_limit_usd !== null ? `This goes over your ${usd(v.daily_limit_usd)} daily ad limit.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function budgetChoiceRefusal(view: BudgetChoiceView | null, surface: "web" | "other", ask: ChoiceAsk): { code: ChoiceCode; detail: string } | null {
  if (!view || view.kind === "fits") return null;
  if (view.kind === "unreadable") return { code: "budget_unreadable", detail: `Zavi can't check your ad budget right now (${view.why}), so nothing was approved. Try again later.` };
  const words = blockWords(view);
  if (surface !== "web") return { code: "budget_choice_in_zavi", detail: `${words} Open it in Zavi to choose.` };
  const needM = view.raise_to_usd !== null;
  const needD = view.daily_limit_to_usd !== null;
  if ((needM && ask.raise_budget_to_usd === undefined) || (needD && ask.raise_daily_limit_to_usd === undefined)) return { code: "budget_choice_required", detail: words };
  const grew = [
    needM && view.raise_to_usd! > ask.raise_budget_to_usd! ? `a ${usd(view.raise_to_usd!)} monthly budget` : null,
    needD && view.daily_limit_to_usd! > ask.raise_daily_limit_to_usd! ? `a ${usd(view.daily_limit_to_usd!)} daily limit` : null,
  ].filter(Boolean);
  return grew.length ? { code: "budget_raise_changed", detail: `The numbers moved: this now needs ${grew.join(" and ")}. Check it and approve again.` } : null;
}

const RPC_WORDS: Record<string, (a: Record<string, unknown>) => string> = {
  limits_below_used: (a) => `That budget would be below the ${usd(Number(a.used_usd ?? 0))} already spent or set aside this month, so nothing was approved.`,
  limits_daily_below_live: (a) => `Your running ads already hold ${usd(Number(a.live_daily_usd ?? 0))} a day, more than that daily limit, so nothing was approved.`,
  limits_not_found: () => "There is no active ad budget to raise, so nothing was approved.",
  daily_above_monthly: () => "The daily limit cannot be above the monthly budget, so nothing was approved.",
  object_busy: () => "Another change to this ad is still being applied. Try again in a minute; nothing was approved.",
};

export type RaiseApprove =
  | { kind: "approved"; changed: boolean }
  | { kind: "refused"; code: ChoiceCode; detail: string; view: BudgetChoiceView | null }
  | { kind: "passthrough" };

export async function approveRaiseWithBudget(
  a: { tenant_id: string; decision_id: string; actor_user_id: string; decision_class: string; body: unknown; surface: "web" | "other"; ask: ChoiceAsk },
  deps: { readFit?: (t: string, c: string, b: unknown) => Promise<ChangeFit> } = {},
): Promise<RaiseApprove> {
  const readFit = deps.readFit ?? (async (t, c, b) => (await import("@/services/decisions/ad-month-counter")).readRaiseFit(t, c, b));
  for (let attempt = 0; attempt < 3; attempt++) {
    const fit = await readFit(a.tenant_id, a.decision_class, a.body);
    if (fit.kind === "no_budget" || fit.kind === "not_a_raise") return { kind: "passthrough" };
    const view = budgetChoiceView(fit);
    const refusal = budgetChoiceRefusal(view, a.surface, a.ask);
    if (refusal) return { kind: "refused", ...refusal, view };
    if (fit.kind === "unreadable" || !fit.raise || !fit.token) return { kind: "refused", code: "budget_unreadable", detail: "Zavi can't check your ad budget right now, so nothing was approved.", view };
    const over = fit.kind === "over" ? fit : null;
    const { data, error } = await tenantRpc(asTenantId(a.tenant_id), "approve_ad_raise_with_budget", {
      p_decision_id: a.decision_id,
      p_actor_user_id: a.actor_user_id,
      p_token: fit.token,
      p_expected_object_id: fit.raise.object_id,
      p_expected_daily_delta_usd: fit.raise.delta_daily_usd,
      p_monthly_to: over && over.raise_to_usd !== null ? (a.ask.raise_budget_to_usd ?? null) : null,
      p_daily_limit_to: over && over.daily_limit_to_usd !== null ? (a.ask.raise_daily_limit_to_usd ?? null) : null,
    });
    if (error) {
      const m = error.message ?? "";
      const detail = /pro plan/i.test(m)
        ? "Raising the ad budget needs the Pro plan, so nothing was approved."
        : /not_member|owner or admin|42501/i.test(m)
          ? "Only an owner or admin can approve this, so nothing was approved."
          : "Zavi could not approve this just now. Nothing was changed. Try again.";
      return { kind: "refused", code: "budget_raise_failed", detail, view };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.status === "approved") return { kind: "approved", changed: r.changed === true };
    if (r.status === "stale" || r.status === "over_daily_limit" || r.status === "over_month") continue;
    if (r.status === "no_budget" || r.status === "not_a_raise") return { kind: "passthrough" };
    if (r.status === "changed") return { kind: "refused", code: "card_changed", detail: "This card changed. Reload it and review again; nothing was approved.", view };
    if (r.status === "decision_closed") return { kind: "refused", code: "decision_closed", detail: "This card was already decided.", view };
    const words = RPC_WORDS[String(r.status)];
    return { kind: "refused", code: "budget_raise_failed", detail: words ? words(r) : "Zavi could not approve this just now. Nothing was changed.", view };
  }
  return { kind: "refused", code: "budget_unreadable", detail: "Your ad budget kept changing while Zavi checked it. Try again in a minute; nothing was approved.", view: null };
}

export async function budgetChoiceNote(tenant_id: string, decision: { id: string; decision_class: string | null; body: unknown }): Promise<string | null> {
  const cls = decision.decision_class ?? "";
  if (!/^(meta_ads|google_ads)\./.test(cls)) return null;
  const CANT_CHECK = "Zavi can't check your ad budget right now. Open it in Zavi.";
  const { adBudgetChoiceState } = await import("@/services/decisions/ad-budget-choice-flag");
  const state = await adBudgetChoiceState();
  if (state === "off") return null;
  if (state === "unreadable") return CANT_CHECK;
  try {
    const moveNote = (n: number) => `This is one of ${n} changes in a move. Approve the move in Zavi.`;
    const { moveView } = await import("@/services/growth/move-card");
    const move = await moveView(tenant_id, decision.id, decision.body);
    if (move && move.lines.length >= 2) return moveNote(move.lines.length);
    const { legSide, moveGroupOf, readMoveGroup } = await import("@/services/growth/move-group");
    const group = moveGroupOf(decision.body);
    if (group) {
      const legs = await readMoveGroup(tenant_id, group);
      if (legs.length >= 2) return moveNote(legs.length);
    }
    if (legSide(cls, decision.body) !== "adds") return null;
    const { readRaiseFit } = await import("@/services/decisions/ad-month-counter");
    const view = budgetChoiceView(await readRaiseFit(tenant_id, cls, decision.body));
    if (view?.kind === "over") return `${blockWords(view)} Choose in Zavi.`;
    if (view?.kind === "unreadable") return CANT_CHECK;
    return null;
  } catch (e) {
    console.warn(`[budget-choice] Slack note unreadable for ${tenant_id}: ${(e as Error).message}`);
    return CANT_CHECK;
  }
}
