
import type { ResolvedWindow } from "@/services/analytics/metric-time";
import { fetchAdSpendTotal } from "./ads";
import { stripeMetrics } from "./stripe";
import { div, sumByDate } from "./shared";
import type { FetchOk, FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

type Side = { label: string; fetch: (ctx: MetricFetchCtx, w: ResolvedWindow) => Promise<FetchResult>; part: string };

export async function fetchRatioOf(
  ctx: MetricFetchCtx,
  w: ResolvedWindow,
  num: Side,
  den: Side,
  opts: { sameCurrency: boolean },
): Promise<FetchResult> {
  const inner = { ...ctx, breakdown: undefined };
  const [a, b] = await Promise.all([num.fetch(inner, w), den.fetch(inner, w)]);
  for (const [side, r] of [[num, a], [den, b]] as const) {
    if (r.ok === false) {
      return { ok: false, reason: r.reason, message: `${side.label}: ${r.message}` };
    }
  }
  const na = a as FetchOk;
  const nb = b as FetchOk;
  if (opts.sameCurrency && na.currency && nb.currency && na.currency !== nb.currency) {
    return {
      ok: false,
      reason: "currency_mismatch",
      message: `${num.label} is in ${na.currency} and ${den.label} is in ${nb.currency}. No FX conversion is done, so no ratio is given.`,
    };
  }
  const rows: Array<{ date: string; parts: Parts }> = [];
  for (const d of na.daily ?? []) rows.push({ date: d.date, parts: { num: d.parts[num.part] ?? 0 } });
  for (const d of nb.daily ?? []) rows.push({ date: d.date, parts: { den: d.parts[den.part] ?? 0 } });
  return {
    ok: true,
    daily: sumByDate(rows),
    currency: na.currency ?? nb.currency ?? null,
    row_count: na.row_count + nb.row_count,
    truncated: false,
    caveats: [...na.caveats, ...nb.caveats],
    params: { numerator: { metric: num.label, ...na.params }, denominator: { metric: den.label, ...nb.params } },
  };
}

const adSpend: Side = { label: "Total ad spend", fetch: (ctx, w) => fetchAdSpendTotal(ctx, w), part: "spend" };

export const derivedMetrics: Record<string, MetricImpl> = {
  cac: {
    value: (p) => div(p.num, p.den),
    fetch: (ctx, w) =>
      fetchRatioOf(ctx, w, adSpend, { label: "New customers", fetch: stripeMetrics.new_customers.fetch, part: "customers" }, {
        sameCurrency: false,
      }),
  },
  blended_roas: {
    value: (p) => div(p.num, p.den),
    fetch: (ctx, w) =>
      fetchRatioOf(ctx, w, { label: "Net revenue", fetch: stripeMetrics.net_revenue.fetch, part: "net" }, adSpend, {
        sameCurrency: true,
      }),
  },
};
