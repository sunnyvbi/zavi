
import { cgoAdBudget } from "./cgo-ads";
import {
  readAdBudgetMonthView,
  releaseIdleAdHolds,
  shrinkUnderdeliveringAdHolds,
  type HoldUpkeep,
} from "@/services/decisions/ad-budget";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { LAUNCH_GRACE_MS, OBSERVED_DAYS, dailyBudgetCapacityUsd } from "./delivery-capacity";
import { accountTodays, shiftDate, knownAccountZone, dateInZone } from "./account-zone";

export type SpendPace = {
  daily_target_usd: number;
  required_cumulative_usd: number;
  actual_month_usd: number;
  delivery_debt_usd: number;
  days_left: number;
  data_fresh: boolean;
};

const DAY_MS = 86_400_000;
export const SPEND_DATA_FRESH_MS = 3 * 3_600_000;
export const DELIVERY_DEBT_SHARE = 0.15;

const round2 = (n: number) => Math.round(n * 100) / 100;
const fin = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayMs(s: string | null | undefined): number {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN;
  return Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
}

export function computeSpendPace(i: {
  monthly_usd: number;
  spent_month_usd: number;
  left_usd: number;
  month_start: string;
  started_on: string | null;
  now: Date;
  actual_read_at: string | null;
}): SpendPace {
  const now = i.now.getTime();
  const today = utcMidnight(i.now);
  const monthFirst = Date.UTC(i.now.getUTCFullYear(), i.now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(i.now.getUTCFullYear(), i.now.getUTCMonth() + 1, 1);
  const daysInMonth = Math.round((nextMonth - monthFirst) / DAY_MS);
  const days_left = Math.round((nextMonth - today) / DAY_MS);

  const left = Math.max(0, fin(i.left_usd));
  const daily_target_usd = round2(left / days_left);

  const ms = dayMs(i.month_start);
  const so = dayMs(i.started_on);
  const start = Math.max(monthFirst, Number.isFinite(ms) ? ms : monthFirst, Number.isFinite(so) ? so : monthFirst);
  const read = i.actual_read_at ? Date.parse(i.actual_read_at) : NaN;
  const asOf = Number.isFinite(read) && read <= now ? read : now;
  const elapsedDays = Math.min(Math.max(0, (asOf - start) / DAY_MS), Math.max(0, (nextMonth - start) / DAY_MS));
  const required_cumulative_usd = round2((Math.max(0, fin(i.monthly_usd)) / daysInMonth) * elapsedDays);

  const actual_month_usd = round2(Math.max(0, fin(i.spent_month_usd)));
  const delivery_debt_usd = round2(Math.max(0, required_cumulative_usd - actual_month_usd));
  const data_fresh = Number.isFinite(read) && now - read <= SPEND_DATA_FRESH_MS && read - now <= 5 * 60_000;
  return { daily_target_usd, required_cumulative_usd, actual_month_usd, delivery_debt_usd, days_left, data_fresh };
}

export function deliveryDebtHigh(p: SpendPace | null | undefined): boolean {
  if (!p || !(p.daily_target_usd > 0)) return false;
  return p.delivery_debt_usd > DELIVERY_DEBT_SHARE * p.daily_target_usd;
}

export async function loadSpendPace(tenant_id: string, now: Date = new Date()): Promise<SpendPace | null> {
  try {
    if (!(await cgoAdBudget(tenant_id, now))) return null;
    const v = await readAdBudgetMonthView(tenant_id);
    if (!v || v.status !== "active") return null;
    const unspent = v.month_cap_usd - v.spent_usd - v.creator_held_usd - v.creator_spent_usd;
    return computeSpendPace({
      monthly_usd: v.monthly_usd,
      spent_month_usd: v.spent_usd,
      left_usd: unspent,
      month_start: v.month_start,
      started_on: v.started_on || null,
      now,
      actual_read_at: v.actual_read_at ?? null,
    });
  } catch (e) {
    console.warn(`[spend-pace] pace unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
}

export type ForecastObject = {
  account_id?: string;
  platform: string;
  object_id: string;
  status: string | null;
  budget_kind: string;
  budget_usd: number | null;
  as_of?: string | null;
};
export type ForecastSpend = {
  account_id?: string | null;
  platform: string;
  object_id: string;
  spend_date: string;
  amount_usd: number;
  provisional?: boolean | null;
  recorded_at?: string | null;
};
export type ForecastHold = { platform: string; object_id: string | null; created_at: string };

const ON_STATUSES = new Set(["ACTIVE", "ENABLED"]);
const FORECAST_PLATFORMS = ["meta", "google", "reddit", "linkedin"];

export function forecastDailySpend(i: {
  objects: readonly ForecastObject[];
  spend: readonly ForecastSpend[];
  holds: readonly ForecastHold[];
  now: Date;
  today?: Partial<Record<string, string>>;
}): { forecast_daily_usd: number; actual_today_usd: number } {
  const utcToday = new Date(utcMidnight(i.now)).toISOString().slice(0, 10);
  const todayOf = (object: ForecastObject) => i.today?.[`${object.platform}:${object.account_id}`] ?? i.today?.[object.platform] ?? utcToday;
  const trailingOf = (object: ForecastObject) => {
    const t = todayOf(object);
    return Array.from({ length: OBSERVED_DAYS }, (_, k) => shiftDate(t, k - OBSERVED_DAYS));
  };
  const byDay = new Map<string, number>();
  for (const s of i.spend) {
    const k = `${s.platform}:${s.object_id}:${String(s.spend_date).slice(0, 10)}`;
    byDay.set(k, Math.max(byDay.get(k) ?? 0, Math.max(0, fin(Number(s.amount_usd)))));
  }
  const recent = new Set(
    i.holds
      .filter((h) => h.object_id && i.now.getTime() - Date.parse(h.created_at) <= LAUNCH_GRACE_MS)
      .map((h) => `${h.platform}:${h.object_id}`),
  );
  let forecast = 0;
  let actualToday = 0;
  const seen = new Set<string>();
  for (const o of i.objects) {
    const key = `${o.platform}:${o.object_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actualToday += byDay.get(`${key}:${todayOf(o)}`) ?? 0;
    if (!ON_STATUSES.has(String(o.status ?? "").toUpperCase())) continue;
    const observed = trailingOf(o).reduce((a, d) => a + (byDay.get(`${key}:${d}`) ?? 0), 0);
    const budget = o.budget_kind === "daily" && o.budget_usd != null && Number(o.budget_usd) > 0 ? Number(o.budget_usd) : null;
    if (budget !== null) {
      forecast += dailyBudgetCapacityUsd(budget, { just_launched: recent.has(key), spend_observed_usd: observed });
    } else {
      forecast += observed / OBSERVED_DAYS;
    }
  }
  return { forecast_daily_usd: round2(forecast), actual_today_usd: round2(actualToday) };
}

export function ledgerAccountTodays(objects: readonly ForecastObject[], spend: readonly ForecastSpend[], now: Date): Record<string, string> {
  const utc = new Date(utcMidnight(now)).toISOString().slice(0, 10);
  const earliest = shiftDate(utc, -1);
  const latest = shiftDate(utc, 1);
  const lastRead = new Map<string, number>();
  for (const o of objects) {
    const at = Date.parse(String(o.as_of));
    const key = `${o.platform}:${o.account_id}`;
    if (Number.isFinite(at)) lastRead.set(key, Math.max(lastRead.get(key) ?? 0, at));
  }
  const days = new Map<string, { open: string; newest: string }>();
  for (const s of spend) {
    if (!s.account_id) continue;
    const key = `${s.platform}:${s.account_id}`;
    const day = String(s.spend_date).slice(0, 10);
    const seen = days.get(key) ?? { open: "", newest: "" };
    if (day > seen.newest) seen.newest = day;
    const isCurrent = !(Date.parse(String(s.recorded_at)) < (lastRead.get(key) ?? 0));
    if (s.provisional === true && isCurrent && day > seen.open) seen.open = day;
    days.set(key, seen);
  }
  const out: Record<string, string> = {};
  for (const [key, { open, newest }] of days) {
    const today = open || shiftDate(newest, 1);
    if (today >= earliest && today <= latest) out[key] = today;
  }
  return out;
}

export async function loadLiveForecast(tenant_id: string, now: Date = new Date(), opts: { fetchZones?: boolean } = {}): Promise<{ forecast_daily_usd: number; actual_today_usd: number }> {
  const svc = tenantClient(asTenantId(tenant_id));
  const since = new Date(utcMidnight(now) - (OBSERVED_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const [objects, spend, holds, today] = await Promise.all([
    svc
      .from("ad_campaigns")
      .select("platform, account_id, object_id, status, budget_kind, budget_usd, as_of")
      .eq("tenant_id", tenant_id)
      .in("platform", FORECAST_PLATFORMS)
      .limit(2000),
    svc
      .from("ad_spend_daily")
      .select("platform, account_id, object_id, spend_date, amount_usd, provisional, recorded_at")
      .eq("tenant_id", tenant_id)
      .in("platform", FORECAST_PLATFORMS)
      .gte("spend_date", since)
      .limit(10000),
    svc
      .from("ad_budget_reservations")
      .select("platform, object_id, created_at")
      .eq("tenant_id", tenant_id)
      .in("status", ["reserved", "committed"])
      .gte("created_at", new Date(now.getTime() - LAUNCH_GRACE_MS).toISOString())
      .limit(500),
    accountTodays(tenant_id, ["meta", "google"], now, { fetch: opts.fetchZones ?? true }),
  ]);
  for (const r of [objects, spend, holds]) if (r.error) throw new Error(`spend-pace: ledger read failed: ${r.error.message}`);
  const accountDates: Record<string, string> = { ...today };
  for (const row of (objects.data ?? []) as ForecastObject[]) if (row.platform === "reddit") {
    if (!row.account_id) throw new Error("Reddit forecast has no account ID.");
    let zone = knownAccountZone(tenant_id, "reddit", row.account_id, now);
    if (!zone) {
      if (opts.fetchZones === false) continue;
      const { ownedAccount } = await import("@/services/connectors/reddit-ads/adapter");
      const { details } = await ownedAccount(tenant_id, row.account_id);
      if (typeof details.time_zone_id !== "string") throw new Error("Reddit timezone is unknown; forecast held.");
      zone = details.time_zone_id;
    }
    accountDates[`reddit:${row.account_id}`] = dateInZone(now, zone);
  }
  if (opts.fetchZones === false) {
    const fromLedger = ledgerAccountTodays((objects.data ?? []) as ForecastObject[], (spend.data ?? []) as ForecastSpend[], now);
    for (const [key, day] of Object.entries(fromLedger)) {
      if (key.startsWith("linkedin:")) continue;
      if (!accountDates[key] && !accountDates[key.split(":")[0]]) accountDates[key] = day;
    }
  }
  return forecastDailySpend({
    objects: (objects.data ?? []) as ForecastObject[],
    spend: (spend.data ?? []) as ForecastSpend[],
    holds: (holds.data ?? []) as ForecastHold[],
    now,
    today: accountDates,
  });
}

export async function maintainCgoAdHolds(
  tenant_id: string,
  now: Date = new Date(),
): Promise<{ status: "skipped" } | { status: "done"; released: HoldUpkeep; shrunk: HoldUpkeep }> {
  if (!(await cgoAdBudget(tenant_id, now))) return { status: "skipped" };
  const released = await releaseIdleAdHolds(tenant_id);
  const shrunk = await shrinkUnderdeliveringAdHolds(tenant_id);
  return { status: "done", released, shrunk };
}
