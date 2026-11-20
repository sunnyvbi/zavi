
import { METRIC_CATALOG, type CatalogMetricMeta, type CatalogUnit } from "@/services/analytics/metric-registry";
import { bucketsFor, bucketStart, type Grain, type LocalDate, type ResolvedWindow } from "@/services/analytics/metric-time";
import { adMetrics } from "./ads";
import { derivedMetrics } from "./derived";
import { ga4Metrics } from "./ga4";
import { gscMetrics } from "./gsc";
import { operatorDbMetrics } from "./operator-db";
import { outcomeMetrics } from "./outcomes";
import { addParts } from "./shared";
import { stripeMetrics } from "./stripe";
import type { Bounds, FetchOk, MetricImpl, Parts } from "./types";

export type { Bounds, Estimate, FetchOk, FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

export const METRIC_IMPLS: Readonly<Record<string, MetricImpl>> = Object.freeze({
  ...stripeMetrics,
  ...adMetrics,
  ...ga4Metrics,
  ...gscMetrics,
  ...operatorDbMetrics,
  ...derivedMetrics,
  ...outcomeMetrics,
});

export function catalogEntry(id: string): { meta: CatalogMetricMeta; impl: MetricImpl } | null {
  const meta = METRIC_CATALOG[id];
  const impl = METRIC_IMPLS[id];
  return meta && impl ? { meta, impl } : null;
}

export function roundFor(unit: CatalogUnit, v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const dp = unit === "ratio" ? 4 : 2;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export type SeriesPoint = { start: LocalDate; end: LocalDate; value: number | null; partial: boolean; bounds?: Bounds };

export type Aggregated = {
  series: SeriesPoint[];
  total: number | null;
  total_bounds?: Bounds;
  breakdown?: Array<{ key: string; value: number | null }>;
};

function pointOf(meta: CatalogMetricMeta, impl: MetricImpl, f: FetchOk, parts: Parts): { value: number | null; bounds?: Bounds } {
  const exact = !f.estimate || f.estimate.exact;
  const value = exact ? roundFor(meta.unit, impl.value(parts)) : null;
  if (!f.estimate || !impl.bounds) return { value };
  const b = impl.bounds(parts, f.estimate.inputs);
  return { value, bounds: { low: roundFor(meta.unit, b.low), high: roundFor(meta.unit, b.high) } };
}

export function aggregate(
  meta: CatalogMetricMeta,
  impl: MetricImpl,
  f: FetchOk,
  w: ResolvedWindow,
  grain: Grain,
): Aggregated {
  const skeleton = bucketsFor(w, grain);
  const byBucket = new Map<LocalDate, Parts>();
  if (f.buckets) {
    for (const b of f.buckets) byBucket.set(bucketStart(b.start, grain), addParts(byBucket.get(bucketStart(b.start, grain)) ?? {}, b.parts));
  } else {
    for (const d of f.daily ?? []) {
      if (d.date < w.since || d.date > w.until) continue;
      const k = bucketStart(d.date, grain);
      byBucket.set(k, addParts(byBucket.get(k) ?? {}, d.parts));
    }
  }
  const series: SeriesPoint[] = meta.point_in_time
    ? (f.buckets ?? []).map((b) => ({ start: b.start, end: b.start, value: roundFor(meta.unit, impl.value(b.parts)), partial: false }))
    : skeleton.map((b) => ({
        start: b.start,
        end: b.end,
        ...pointOf(meta, impl, f, byBucket.get(b.start) ?? {}),
        partial: b.partial,
      }));

  let totalParts: Parts;
  if (f.total_parts) totalParts = f.total_parts;
  else {
    totalParts = {};
    for (const d of f.daily ?? []) if (d.date >= w.since && d.date <= w.until) addParts(totalParts, d.parts);
  }
  const tot = pointOf(meta, impl, f, totalParts);
  const out: Aggregated = { series, total: tot.value, ...(tot.bounds ? { total_bounds: tot.bounds } : {}) };
  if (f.breakdown) out.breakdown = f.breakdown.map((b) => ({ key: b.key, value: roundFor(meta.unit, impl.value(b.parts)) }));
  return out;
}
