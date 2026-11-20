
import { serverClientFromBearer } from "@/services/supabase";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import { getConfirmedBookingConfig, getBookingMetricConfig } from "./config";

export type BookingTrendState = "confirmed_money" | "unconfirmed" | "none";

export type BookingTrendPoint = {
  date: string;
  bookings: number | null;
  revenue_usd: number | null;
  mer: number | null;
  cost_per_booking_usd: number | null;
};

export type BookingTrend = {
  state: BookingTrendState;
  points: BookingTrendPoint[];
  currency: string | null;
  mer_available: boolean;
  refreshed_at: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function buildBookingTrend(
  tenant_id: string,
  accessToken: string,
  spendByDate: Map<string, number>,
): Promise<BookingTrend> {
  const confirmed = await getConfirmedBookingConfig(tenant_id);
  if (!confirmed) {
    let unconfirmed = (await getBookingMetricConfig(tenant_id)) != null;
    if (!unconfirmed) {
      try {
        const cat = await getCatalog(tenant_id);
        unconfirmed = !!cat?.hints?.bookings?.table && !!cat?.hints?.bookings?.created_at_field;
      } catch {
      }
    }
    return {
      state: unconfirmed ? "unconfirmed" : "none",
      points: [],
      currency: null,
      mer_available: false,
      refreshed_at: null,
    };
  }

  const dates = [...spendByDate.keys()].sort((a, b) => a.localeCompare(b));
  if (dates.length === 0) {
    return {
      state: "confirmed_money",
      points: [],
      currency: confirmed.currency,
      mer_available: confirmed.currency === "USD",
      refreshed_at: null,
    };
  }

  const sb = serverClientFromBearer(accessToken);
  let rollup: Array<{
    day: string;
    bookings: number;
    revenue_native: number | null;
    refreshed_at: string;
  }> = [];
  try {
    const { data } = await sb
      .from("booking_daily_rollup")
      .select("day, bookings, revenue_native, refreshed_at")
      .eq("tenant_id", tenant_id)
      .gte("day", dates[0])
      .lte("day", dates[dates.length - 1]);
    rollup = (data ?? []) as typeof rollup;
  } catch {
    rollup = [];
  }

  const byDay = new Map(rollup.map((r) => [r.day, r]));
  const merAvailable = confirmed.currency === "USD";
  const refreshed_at =
    rollup.reduce<string | null>(
      (acc, r) => (!acc || r.refreshed_at > acc ? r.refreshed_at : acc),
      null,
    ) ?? null;

  const points: BookingTrendPoint[] = dates.map((date) => {
    const r = byDay.get(date);
    const spend = spendByDate.get(date) ?? 0;
    const bookings = r ? r.bookings : null;
    const revenue_usd = merAvailable && r ? r.revenue_native : null;
    const mer = revenue_usd != null && spend > 0 ? round2(revenue_usd / spend) : null;
    const cost_per_booking_usd =
      bookings != null && bookings > 0 ? round2(spend / bookings) : null;
    return { date, bookings, revenue_usd, mer, cost_per_booking_usd };
  });

  return {
    state: "confirmed_money",
    points,
    currency: confirmed.currency,
    mer_available: merAvailable,
    refreshed_at,
  };
}
