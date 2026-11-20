import { getConfirmedBookingConfig } from "@/services/growth/booking-metrics/config";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const MONEY_WINDOW_DAYS = 30;
export const ROLLUP_MAX_AGE_MS = 13 * 3_600_000;
const BATCH_SLACK_MS = 3_600_000;

export type BookingValueRead =
  | { available: true; usd: number; net_of_refunds: boolean; window_days: number; from: string; to: string; timezone: string }
  | {
      available: false;
      reason:
        | "no_confirmed_mapping"
        | "no_revenue_field"
        | "non_usd"
        | "refunds_not_modelled"
        | "rollup_stale"
        | "rollup_predates_mapping"
        | "rollup_missing_days"
        | "read_failed";
    };

export function minusDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) - n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function dayIn(tz: string, d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export type RollupRow = { day: string; revenue_native: number | null; refreshed_at: string; currency?: string | null };

export function sumBookingValue(
  rows: readonly RollupRow[],
  from: string,
  to: string,
  now: Date,
  confirmedAt: string | null = null,
): { usd: number } | { stale: true } | { predates_mapping: true } | { missing_days: true } {
  const latest = rows.reduce((m, r) => Math.max(m, Date.parse(r.refreshed_at) || 0), 0);
  if (!latest || now.getTime() - latest > ROLLUP_MAX_AGE_MS) return { stale: true };
  const confirmed = confirmedAt ? Date.parse(confirmedAt) : NaN;
  if (Number.isFinite(confirmed) && latest < confirmed) return { predates_mapping: true };
  const batch = rows.filter((r) => (Date.parse(r.refreshed_at) || 0) >= latest - BATCH_SLACK_MS && r.day >= from && r.day <= to);
  if (batch.some((r) => r.currency != null && r.currency.toUpperCase() !== "USD")) return { predates_mapping: true };
  const days = new Set(batch.map((r) => r.day));
  for (let d = from; d <= to; d = minusDays(d, -1)) if (!days.has(d)) return { missing_days: true };
  const usd = batch.reduce((sum, r) => sum + (Number(r.revenue_native) || 0), 0);
  return { usd: Math.round(usd * 100) / 100 };
}

export async function readBookingValue30d(tenant_id: string, now: Date = new Date()): Promise<BookingValueRead> {
  const cfg = await getConfirmedBookingConfig(tenant_id);
  if (!cfg) return { available: false, reason: "no_confirmed_mapping" };
  if (!cfg.revenue_field) return { available: false, reason: "no_revenue_field" };
  if ((cfg.currency ?? "").toUpperCase() !== "USD") return { available: false, reason: "non_usd" };
  if (cfg.refund_basis === "refund_event_day") return { available: false, reason: "refunds_not_modelled" };
  const tz = cfg.reporting_timezone || "UTC";
  const to = dayIn(tz, now);
  const from = minusDays(to, MONEY_WINDOW_DAYS - 1);
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("booking_daily_rollup")
    .select("day, revenue_native, refreshed_at, currency")
    .gte("day", from)
    .lte("day", to)
    .limit(100);
  if (error) return { available: false, reason: "read_failed" };
  const sum = sumBookingValue((data ?? []) as RollupRow[], from, to, now, cfg.confirmed_at);
  if ("stale" in sum) return { available: false, reason: "rollup_stale" };
  if ("predates_mapping" in sum) return { available: false, reason: "rollup_predates_mapping" };
  if ("missing_days" in sum) return { available: false, reason: "rollup_missing_days" };
  return {
    available: true,
    usd: sum.usd,
    net_of_refunds: cfg.refund_basis === "booking_created_net" && !!cfg.refund_field,
    window_days: MONEY_WINDOW_DAYS,
    from,
    to,
    timezone: tz,
  };
}
