import { budgetMargin, readAdBudgetMonthView, type AdBudgetMonthView } from "./ad-budget";
import { isRunning, LIVE_ACCOUNT_MS, readLiveMonthProjection, type CampaignRow, type MonthProjection } from "./ad-budget-brake";
import { monthlyNeededForCap, raiseFromCard } from "@/services/growth/ad-budget-shortfall";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export type CounterHold = { platform: string; object_id: string | null; daily_delta_usd: number; status: string; created_at: string; paused: boolean };
export type ObjectChange = { platform: string; object_id: string; change_kind: "budget" | "status"; after_daily_usd: number | null; after_status: string | null; occurred_at: string };
export type LedgerRow = CampaignRow & { as_of: string };
export type AccountRead = { platform: string; account_id: string; as_of: string; status: string | null };

const cents = (n: number) => Math.round(n * 100);
const key = (p: string, o: string) => `${p}:${o}`;

export function overlayChanges<R extends LedgerRow>(rows: readonly R[], changes: readonly ObjectChange[]): R[] {
  const newest = new Map<string, Partial<Record<"budget" | "status", ObjectChange>>>();
  for (const c of changes) {
    const k = key(c.platform, c.object_id);
    const m = newest.get(k) ?? {};
    const prev = m[c.change_kind];
    if (!prev || Date.parse(c.occurred_at) > Date.parse(prev.occurred_at)) m[c.change_kind] = c;
    newest.set(k, m);
  }
  return rows.map((r) => {
    const m = newest.get(key(r.platform, r.object_id));
    if (!m) return r;
    const read = Date.parse(r.as_of);
    const b = m.budget && Date.parse(m.budget.occurred_at) > read && m.budget.after_daily_usd !== null ? Number(m.budget.after_daily_usd) : null;
    const s = m.status && Date.parse(m.status.occurred_at) > read && m.status.after_status ? m.status.after_status : null;
    return { ...r, ...(b !== null && Number.isFinite(b) && r.budget_kind === "daily" ? { budget_usd: b } : {}), ...(s ? { status: s } : {}) };
  });
}

export function pendingDailyUsd(holds: readonly CounterHold[], seen: ReadonlyMap<string, number>): number {
  let c = 0;
  for (const h of holds) {
    if (h.paused || !(h.daily_delta_usd > 0)) continue;
    if (h.status === "reserved") c += cents(h.daily_delta_usd);
    else if (h.status === "committed" && h.object_id) {
      const s = seen.get(key(h.platform, h.object_id));
      if (s === undefined || Date.parse(h.created_at) > s) c += cents(h.daily_delta_usd);
    }
  }
  return c / 100;
}

export function staleAccounts(reads: readonly AccountRead[], month_start: string, now: Date): Array<{ platform: string; account_id: string; as_of: string }> {
  const newest = new Map<string, { platform: string; account_id: string; as_of: string; at: number; running: boolean }>();
  for (const r of reads) {
    if (r.as_of < month_start) continue;
    const k = key(r.platform, r.account_id);
    const at = Date.parse(r.as_of);
    const cur = newest.get(k);
    if (!cur || at > cur.at) newest.set(k, { platform: r.platform, account_id: r.account_id, as_of: r.as_of, at, running: isRunning(r) });
    else if (at === cur.at && isRunning(r)) cur.running = true;
  }
  return [...newest.values()]
    .filter((r) => r.running && now.getTime() - r.at > LIVE_ACCOUNT_MS)
    .map(({ platform, account_id, as_of }) => ({ platform, account_id, as_of }));
}

export type MonthCount = { budget_id: string; month_start: string; monthly_usd: number; month_cap_usd: number; days_left: number; spent_usd: number; creator_usd: number; running_daily_usd: number; pending_daily_usd: number; projection_usd: number };

export function countMonth(budget_id: string, view: AdBudgetMonthView, p: MonthProjection, pendingDaily: number): MonthCount {
  return {
    budget_id, month_start: view.month_start, monthly_usd: view.monthly_usd, month_cap_usd: p.month_cap_usd, days_left: p.days_left,
    spent_usd: p.spent_usd, creator_usd: p.creator_usd, running_daily_usd: p.running_daily_usd, pending_daily_usd: pendingDaily,
    projection_usd: (cents(p.projected_usd) + cents(pendingDaily) * p.days_left) / 100,
  };
}

export type Fit =
  | { kind: "fits"; count: MonthCount; with_usd: number }
  | { kind: "over"; count: MonthCount; with_usd: number; over_by_usd: number; raise_to_usd: number | null; daily_limit_usd: number | null; daily_limit_to_usd: number | null; gate_usd: number; set_aside_over: boolean }
  | { kind: "unreadable"; why: string };

export const roundUpToHundred = (n: number): number => Math.ceil(Number((n / 100).toFixed(6))) * 100;

export function fitDailyChange(count: MonthCount, view: AdBudgetMonthView, liveHeldDaily: number, deltaDaily: number): Fit {
  if (!(deltaDaily > 0)) return { kind: "fits", count, with_usd: count.projection_usd };
  const daily_limit_to_usd = view.daily_limit_usd != null && liveHeldDaily + deltaDaily > view.daily_limit_usd + 1e-9 ? Math.ceil(Number((liveHeldDaily + deltaDaily).toFixed(6))) : null;
  const with_usd = (cents(count.projection_usd) + cents(deltaDaily) * count.days_left) / 100;
  const monthFits = cents(with_usd) <= cents(count.month_cap_usd);
  const hold = Math.ceil(Number((Math.ceil(Number((deltaDaily * 100).toFixed(6))) / 100 * count.days_left * budgetMargin(view) * 100).toFixed(6))) / 100;
  const gate_usd = (cents(view.spent_usd) + cents(view.held_usd) + cents(view.creator_held_usd) + cents(view.creator_spent_usd) + cents(hold)) / 100;
  const gateFits = cents(gate_usd) <= cents(count.month_cap_usd);
  if (monthFits && gateFits && daily_limit_to_usd === null) return { kind: "fits", count, with_usd };
  let raise_to_usd: number | null = null;
  if (!monthFits || !gateFits) {
    const need = Math.max(monthFits ? 0 : with_usd, gateFits ? 0 : gate_usd);
    const monthly = monthlyNeededForCap(view, need);
    if (monthly === null) return { kind: "unreadable", why: "proration" };
    raise_to_usd = Math.max(roundUpToHundred(monthly), roundUpToHundred(view.monthly_usd + 1));
  }
  if (daily_limit_to_usd !== null && daily_limit_to_usd > (raise_to_usd ?? view.monthly_usd)) raise_to_usd = roundUpToHundred(daily_limit_to_usd);
  return { kind: "over", count, with_usd, over_by_usd: Math.max(0, (cents(with_usd) - cents(count.month_cap_usd)) / 100), raise_to_usd, daily_limit_usd: view.daily_limit_usd, daily_limit_to_usd, gate_usd, set_aside_over: monthFits && !gateFits };
}

const ROWS = 1000;

export type MonthRead = { token: string; count: MonthCount; view: AdBudgetMonthView; live_held_daily_usd: number };

export async function readMonthCount(tenant_id: string, now: Date = new Date(), opts: { excludeIdemKey?: string } = {}): Promise<MonthRead | { unreadable: string } | null> {
  const t = await tenantRpc(asTenantId(tenant_id), "ad_month_token", {});
  if (t.error || typeof t.data !== "string") throw new Error(`ad month token read failed: ${t.error?.message ?? "no token"}`);
  const token: string = t.data;
  const view = await readAdBudgetMonthView(tenant_id);
  if (!view || view.status !== "active") return null;
  const db = tenantClient(asTenantId(tenant_id));
  const b = await db.from("ad_budgets").select("read_failed, actual_read_at").eq("tenant_id", tenant_id).eq("id", view.id).maybeSingle();
  if (b.error) throw new Error(`ad budget read failed: ${b.error.message}`);
  const row = b.data as { read_failed?: Record<string, unknown> | null; actual_read_at?: string | null } | null;
  if (!row?.actual_read_at) return { unreadable: "your ad accounts have not been read yet" };
  const failed = Object.keys(row.read_failed ?? {});
  if (failed.length) return { unreadable: `${failed.join(", ")} spend could not be read on the last check` };
  const a = await db.from("ad_campaigns").select("platform, account_id, as_of, status").eq("tenant_id", tenant_id).gte("as_of", view.month_start).limit(ROWS);
  if (a.error) throw new Error(`ad_campaigns read failed: ${a.error.message}`);
  if ((a.data ?? []).length >= ROWS) throw new Error("ad_campaigns read hit its row limit");
  const stale = staleAccounts((a.data ?? []) as AccountRead[], view.month_start, now);
  if (stale.length) return { unreadable: `${stale.map((s) => s.platform).join(", ")} was last read ${stale[0].as_of.slice(0, 10)}` };
  const ch = await db.from("ad_object_changes").select("platform, object_id, change_kind, after_daily_usd, after_status, occurred_at").eq("tenant_id", tenant_id).gte("occurred_at", new Date(now.getTime() - LIVE_ACCOUNT_MS).toISOString()).limit(ROWS);
  if (ch.error) throw new Error(`ad_object_changes read failed: ${ch.error.message}`);
  if ((ch.data ?? []).length >= ROWS) throw new Error("ad_object_changes read hit its row limit");
  const changes = (ch.data ?? []) as ObjectChange[];
  let rowsSeen: LedgerRow[] = [];
  const live = await readLiveMonthProjection(tenant_id, now, (rows) => ((rowsSeen = rows), overlayChanges(rows, changes)));
  if (!live) return null;
  const hs = await db.from("ad_budget_reservations").select("platform, object_id, daily_delta_usd, status, created_at, paused, idem_key").eq("tenant_id", tenant_id).eq("budget_id", view.id).in("status", ["reserved", "committed"]).limit(ROWS);
  if (hs.error) throw new Error(`ad budget holds read failed: ${hs.error.message}`);
  if ((hs.data ?? []).length >= ROWS) throw new Error("ad budget holds read hit its row limit");
  type HoldRow = Omit<CounterHold, "daily_delta_usd" | "paused"> & { daily_delta_usd: number | string; paused: boolean | null; idem_key?: string | null };
  const holds = ((hs.data ?? []) as HoldRow[])
    .filter((r) => opts.excludeIdemKey === undefined || r.idem_key !== opts.excludeIdemKey)
    .map(({ idem_key: _k, ...r }) => {
      const d = Number(r.daily_delta_usd);
      if (!Number.isFinite(d)) throw new Error("ad budget holds read returned an unreadable amount");
      return { ...r, daily_delta_usd: d, paused: r.paused === true };
    });
  const seen = new Map<string, number>();
  const bump = (k: string, at: string) => seen.set(k, Math.max(seen.get(k) ?? 0, Date.parse(at)));
  for (const r of rowsSeen) bump(key(r.platform, r.object_id), r.as_of);
  for (const c of changes) bump(key(c.platform, c.object_id), c.occurred_at);
  return { token, count: countMonth(view.id, view, live.projection, pendingDailyUsd(holds, seen)), view, live_held_daily_usd: holds.reduce((s, x) => s + x.daily_delta_usd, 0) };
}

export async function readCountedProjection(tenant_id: string, opts: { excludeIdemKey?: string } = {}): Promise<{ budget_id: string; projection: { projected_usd: number; month_cap_usd: number; days_left: number; over: boolean } } | null> {
  const r = await readMonthCount(tenant_id, new Date(), opts);
  if (!r) return null;
  if ("unreadable" in r) throw new Error(`ad month unreadable: ${r.unreadable}`);
  const c = r.count;
  return { budget_id: c.budget_id, projection: { projected_usd: c.projection_usd, month_cap_usd: c.month_cap_usd, days_left: c.days_left, over: cents(c.projection_usd) > cents(c.month_cap_usd) } };
}

export type RaiseOf = { platform: "meta" | "google"; object_id: string; delta_daily_usd: number };
export type ChangeFit = (Fit & { token?: string; raise?: RaiseOf; live_held_daily_usd?: number; view?: AdBudgetMonthView }) | { kind: "no_budget" } | { kind: "not_a_raise" };

export async function readRaiseFit(tenant_id: string, exec_class: string, body: unknown): Promise<ChangeFit> {
  const r = raiseFromCard(exec_class, body);
  if (r === null) return { kind: "unreadable", why: "card" };
  if (r === "not_a_raise" || r === "non_usd" || r.platform === "chatgpt") return { kind: "not_a_raise" };
  try {
    const m = await readMonthCount(tenant_id);
    if (!m) return { kind: "no_budget" };
    if ("unreadable" in m) return { kind: "unreadable", why: m.unreadable };
    const raise: RaiseOf = { platform: r.platform, object_id: r.object_id, delta_daily_usd: r.new_daily_usd - r.current_daily_usd };
    return { ...fitDailyChange(m.count, m.view, m.live_held_daily_usd, raise.delta_daily_usd), token: m.token, raise, live_held_daily_usd: m.live_held_daily_usd, view: m.view };
  } catch (e) {
    console.warn(`[ad-month-counter] unreadable for ${tenant_id}: ${(e as Error).message}`);
    return { kind: "unreadable", why: "read" };
  }
}
