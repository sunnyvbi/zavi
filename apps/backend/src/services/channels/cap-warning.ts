
import { DAYS_PER_MONTH, moneyAtStakeUsd } from "./money-at-stake";
import type { ChannelActionView } from "./channel-actions";

export type PaceProjection = { projected_usd: number; month_cap_usd: number; days_left: number };

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export function capWarningWords(p: PaceProjection, dailyUsd: number | null): string | null {
  const days = Math.max(0, Math.floor(p.days_left));
  const added = dailyUsd != null && Number.isFinite(dailyUsd) && dailyUsd > 0 ? dailyUsd * days : 0;
  const total = p.projected_usd + added;
  if (!(total > p.month_cap_usd)) return null;
  const over = total - p.month_cap_usd;
  return dailyUsd == null
    ? `You're already on track for ${money(total)} this month, ${money(over)} over your ${money(p.month_cap_usd)} cap, and this adds to it`
    : `This puts you on track for ${money(total)} this month, ${money(over)} over your ${money(p.month_cap_usd)} cap`;
}

type Row = { id: string; exec_class?: string | null; exec_payload?: unknown; body?: unknown };

export function totalBudgetUsd(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const v = (payload as { total_budget_usd?: unknown }).total_budget_usd;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function createDailyUsd(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const top = payload as Record<string, unknown>;
  if (typeof top.currency === "string" && top.currency.toUpperCase() !== "USD") return null;
  const found: number[] = [];
  const take = (o: Record<string, unknown>) => {
    const v = o.daily_budget_usd;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) found.push(v);
  };
  take(top);
  for (const v of Object.values(top)) if (v && typeof v === "object" && !Array.isArray(v)) take(v as Record<string, unknown>);
  return found.length ? Math.max(...found) : null;
}

export const CAP_UNCHECKED_WARNING = "Zavi can't check your ad budget right now, so this may go over your monthly budget.";

export async function withCapWarnings(
  tenant_id: string,
  views: ChannelActionView[],
  rows: readonly Row[],
): Promise<ChannelActionView[]> {
  try {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const { adDirection } = await import("@/services/growth/unattended-policy");
    const adds = new Map<string, number | null | { total: number }>();
    for (const v of views) {
      if (!v.executable || v.status !== "pending" || (v.exec_status != null && v.exec_status !== "failed")) continue;
      const r = byId.get(v.id);
      if (!r || typeof r.exec_class !== "string") continue;
      const dir = adDirection(r.exec_class, r.exec_payload);
      if (dir !== "up" && dir !== "create") continue;
      const m = moneyAtStakeUsd(r.exec_class, r.exec_payload, r.body);
      const daily = m ? m.monthly_usd / DAYS_PER_MONTH : dir === "create" ? createDailyUsd(r.exec_payload) : null;
      const total = daily == null ? totalBudgetUsd(r.exec_payload) : null;
      adds.set(v.id, total != null ? { total } : daily);
    }
    if (adds.size === 0) return views;
    let p: PaceProjection | undefined;
    try {
      const { readCountedProjection } = await import("@/services/decisions/ad-month-counter");
      p = (await readCountedProjection(tenant_id))?.projection;
    } catch (e) {
      console.warn(`[cap-warning] month unreadable for ${tenant_id}: ${(e as Error).message}`);
      return views.map((v) => (adds.has(v.id) ? { ...v, cap_warning: CAP_UNCHECKED_WARNING } : v));
    }
    if (!p) return views;
    const pace = p;
    return views.map((v) => {
      if (!adds.has(v.id)) return v;
      const add = adds.get(v.id) ?? null;
      const w = capWarningWords(pace, add != null && typeof add === "object" ? add.total / Math.max(1, Math.floor(pace.days_left)) : add);
      return w ? { ...v, cap_warning: w } : v;
    });
  } catch (e) {
    console.warn(`[cap-warning] not served for ${tenant_id}: ${(e as Error).message}`);
    return views;
  }
}
