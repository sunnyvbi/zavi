
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { fetchOperatorBookingsDaily } from "@/services/growth/booking-metrics/daily";
import type { BookingMetricConfig } from "@/services/growth/booking-metrics/config";

const DEFAULT_WINDOW_DAYS = 35;

export function withZeroDays(
  rows: ReadonlyArray<{ date: string; bookings: number; revenue_native: number | null }>,
  sinceIso: string,
  untilIso: string,
  hasRevenue: boolean,
): Array<{ date: string; bookings: number; revenue_native: number | null }> {
  const have = new Set(rows.map((r) => r.date));
  const out = [...rows];
  for (let t = Date.parse(`${sinceIso}T00:00:00Z`); t <= Date.parse(`${untilIso}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (!have.has(date)) out.push({ date, bookings: 0, revenue_native: hasRevenue ? 0 : null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function refreshBookingRollups(opts?: {
  days?: number;
  tenantId?: string;
}): Promise<{ tenants: number; rows: number; errors: number }> {
  const days = opts?.days ?? DEFAULT_WINDOW_DAYS;
  const sb = serviceClient();

  let q = sb
    .from("booking_metric_config")
    .select(
      "tenant_id, engine, booking_source, date_field, status_field, completed_statuses, revenue_field, refund_field, refund_basis, currency, reporting_timezone, amount_unit, state, confirmed_by, confirmed_at",
    )
    .eq("state", "confirmed");
  if (opts?.tenantId) q = q.eq("tenant_id", opts.tenantId);
  const { data, error } = await q;
  if (error) throw new Error(`booking-rollup-refresh: config read failed: ${error.message}`);

  const configs = (data ?? []) as BookingMetricConfig[];
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const sinceIso = ymd(new Date(now.getTime() - days * 86_400_000));
  const untilIso = ymd(new Date(now.getTime() + 86_400_000));

  let tenants = 0;
  let rows = 0;
  let errors = 0;

  for (const cfg of configs) {
    try {
      const res = await fetchOperatorBookingsDaily(cfg.tenant_id, cfg, { sinceIso, untilIso });
      if (!res) continue;
      tenants += 1;
      const refreshed_at = new Date().toISOString();
      const upserts = withZeroDays(res.rows, sinceIso, untilIso, cfg.revenue_field != null).map((r) => ({
        tenant_id: cfg.tenant_id,
        day: r.date,
        bookings: r.bookings,
        revenue_native: r.revenue_native,
        currency: res.currency,
        refreshed_at,
      }));
      const { error: upErr } = await sb
        .from("booking_daily_rollup")
        .upsert(upserts, { onConflict: "tenant_id,day" });
      if (upErr) throw new Error(upErr.message);
      rows += upserts.length;
    } catch {
      errors += 1;
    }
  }

  return { tenants, rows, errors };
}

export const bookingRollupRefreshFn = inngest.createFunction(
  { id: "booking-rollup-refresh" },
  { cron: "0 */6 * * *" },
  async ({ logger }) => {
    const r = await refreshBookingRollups();
    logger.info(
      `booking-rollup-refresh: ${r.rows} rows across ${r.tenants} tenant(s), ${r.errors} error(s)`,
    );
    return r;
  },
);
