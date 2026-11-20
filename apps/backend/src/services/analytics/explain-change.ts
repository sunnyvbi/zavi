
import { type CatalogBreakdown, type CatalogMetricMeta } from "@/services/analytics/metric-registry";
import { catalogEntry, roundFor, type FetchOk, type FetchResult, type MetricImpl, type Parts } from "@/services/analytics/metric-catalog";
import { addParts } from "@/services/analytics/metric-catalog/shared";
import {
  addDays,
  compareWindow,
  resolveWindow,
  WindowError,
  type LocalDate,
  type ResolvedWindow,
  type WindowInput,
} from "@/services/analytics/metric-time";

export const EXPLAIN_DIMENSIONS: CatalogBreakdown[] = [
  "source_medium",
  "campaign",
  "platform",
  "country",
  "device",
  "landing_page",
  "page",
  "query",
];

const OVERLAPPING_SEGMENTS: ReadonlySet<string> = new Set(["users"]);

export const MAX_DRIVERS = 3;
const SEGMENTS_SHOWN = 5;
export const HIGH_SHARE = 0.6;
export const MEDIUM_SHARE = 0.3;

export type ExplainCompare = "previous_period" | "previous_week" | "previous_year";
export type Confidence = "high" | "medium" | "low";

export const DIMENSION_WORDS: Record<CatalogBreakdown, string> = {
  source_medium: "source / medium",
  campaign: "campaign",
  platform: "ad platform",
  country: "country",
  device: "device",
  landing_page: "landing page",
  page: "page in search",
  query: "search query",
};

export type SegmentContribution = {
  key: string;
  current: number | null;
  compare: number | null;
  contribution: number;
  share: number | null;
  existed_before: boolean;
};

export type Contributions =
  | {
      ok: true;
      current_total: number;
      compare_total: number;
      total_change: number;
      additive: boolean;
      segments: SegmentContribution[];
      other_contribution: number;
    }
  | { ok: false; reason: "no_value" };

function subtract(a: Parts, b: Parts): Parts {
  const out: Parts = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) - v;
  return out;
}

function sumParts(list: Parts[]): Parts {
  const out: Parts = {};
  for (const p of list) addParts(out, p);
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function rebuilds(value: MetricImpl["value"], total: Parts, segs: Parts[], other: Parts): boolean {
  const t = value(total);
  if (t === null) return false;
  let sum = value(other) ?? 0;
  for (const s of segs) {
    const v = value(s);
    if (v === null) return false;
    sum += v;
  }
  return close(sum, t);
}

export function computeContributions(
  value: MetricImpl["value"],
  current: { total: Parts; segments: Array<{ key: string; parts: Parts }> },
  compare: { total: Parts; segments: Array<{ key: string; parts: Parts }> },
): Contributions {
  const v1 = value(current.total);
  const v0 = value(compare.total);
  if (v1 === null || v0 === null || !Number.isFinite(v1) || !Number.isFinite(v0)) return { ok: false, reason: "no_value" };

  const keys = [...new Set([...current.segments.map((s) => s.key), ...compare.segments.map((s) => s.key)])];
  const cur = new Map(current.segments.map((s) => [s.key, s.parts]));
  const prev = new Map(compare.segments.map((s) => [s.key, s.parts]));
  const s1 = keys.map((k) => cur.get(k) ?? {});
  const s0 = keys.map((k) => prev.get(k) ?? {});
  const other1 = subtract(current.total, sumParts(s1));
  const other0 = subtract(compare.total, sumParts(s0));
  const additive = rebuilds(value, current.total, s1, other1) && rebuilds(value, compare.total, s0, other0);
  const total_change = v1 - v0;

  const segments: SegmentContribution[] = keys.map((key, i) => {
    const a = value(s1[i]);
    const b = value(s0[i]);
    let contribution: number;
    if (additive) {
      contribution = (a ?? 0) - (b ?? 0);
    } else {
      const without = value(addParts(subtract(current.total, s1[i]), s0[i]));
      contribution = without === null ? 0 : v1 - without;
    }
    return {
      key,
      current: a,
      compare: b,
      contribution,
      share: total_change !== 0 ? contribution / total_change : null,
      existed_before: (b ?? 0) > 0,
    };
  });
  const other_contribution = additive ? (value(other1) ?? 0) - (value(other0) ?? 0) : 0;
  return { ok: true, current_total: v1, compare_total: v0, total_change, additive, segments, other_contribution };
}

export function confidenceFor(share: number, additive: boolean, existedBefore: boolean): Confidence {
  if (share >= HIGH_SHARE) return additive && existedBefore ? "high" : "medium";
  if (share >= MEDIUM_SHARE) return "medium";
  return "low";
}

export type Driver = {
  dimension: CatalogBreakdown;
  segment: string;
  contribution: number;
  share_pct: number;
  confidence: Confidence;
};

export function pickDrivers(
  byDimension: Array<{ dimension: CatalogBreakdown; c: Extract<Contributions, { ok: true }> }>,
  max = MAX_DRIVERS,
): Driver[] {
  const all: Array<Driver & { share: number }> = [];
  for (const { dimension, c } of byDimension) {
    for (const s of c.segments) {
      if (s.share === null || !(s.share > 0)) continue;
      all.push({
        dimension,
        segment: s.key,
        contribution: s.contribution,
        share: s.share,
        share_pct: Math.round(s.share * 1000) / 10,
        confidence: confidenceFor(s.share, c.additive, s.existed_before),
      });
    }
  }
  all.sort((a, b) => b.share - a.share);
  return all.slice(0, max).map(({ share: _share, ...d }) => d);
}

export function explainCompareWindow(w: ResolvedWindow, mode: ExplainCompare): ResolvedWindow {
  if (mode === "previous_week") return { since: addDays(w.since, -7), until: addDays(w.until, -7), tz: w.tz, notes: [] };
  return compareWindow(w, mode);
}

export function totalPartsOf(f: FetchOk, w: { since: LocalDate; until: LocalDate }): Parts {
  if (f.total_parts) return f.total_parts;
  const out: Parts = {};
  for (const d of f.daily ?? []) if (d.date >= w.since && d.date <= w.until) addParts(out, d.parts);
  return out;
}

export type ExplainInput = {
  metric_id: string;
  window?: WindowInput;
  compare?: ExplainCompare;
};

export type ExplainCtx = {
  tenant_id: string;
  tz: string;
  now: Date;
  gateway?: import("@/services/data-gateway/types").GatewayContext;
};

export type ExplainResult =
  | {
      status: "ok";
      metric_id: string;
      label: string;
      unit: CatalogMetricMeta["unit"];
      direction: CatalogMetricMeta["direction"];
      window: { since: LocalDate; until: LocalDate };
      compare_window: { since: LocalDate; until: LocalDate };
      total: number | null;
      compare_total: number | null;
      change: number | null;
      change_pct: number | null;
      dimensions: Array<{
        dimension: CatalogBreakdown;
        additive: boolean;
        segments: Array<{ segment: string; current: number | null; compare: number | null; contribution: number | null; share_pct: number | null }>;
        all_other_contribution: number | null;
      }>;
      drivers: Driver[];
      currency: string | null;
      caveats: string[];
    }
  | { status: string; metric_id: string; message: string; caveats: string[] };

export type ExplainDeps = {
  catalogEntry: typeof catalogEntry;
};

const realDeps: ExplainDeps = { catalogEntry };

export async function explainChange(ctx: ExplainCtx, input: ExplainInput, deps: ExplainDeps = realDeps): Promise<ExplainResult> {
  const entry = deps.catalogEntry(input.metric_id);
  const fail = (status: string, message: string, caveats: string[] = []) => ({ status, metric_id: input.metric_id, message, caveats });
  if (!entry) return fail("unsupported", `${input.metric_id} is not a catalog metric.`);
  const { meta, impl } = entry;
  if (meta.point_in_time) return fail("unsupported", `${meta.id} is a reading of now, not a sum over days, so it has no breakdown to explain.`);
  if (OVERLAPPING_SEGMENTS.has(meta.id)) {
    return fail("unsupported", `${meta.label} counts a person once however many segments they appear in, so its change cannot be split into contributions. Explain sessions instead.`);
  }
  const dims = EXPLAIN_DIMENSIONS.filter((d) => meta.breakdowns.includes(d));
  if (dims.length === 0) return fail("unsupported", `${meta.id} has no breakdown, so there is nothing to split the change by.`);

  let w: ResolvedWindow;
  try {
    w = resolveWindow(input.window, ctx.tz, ctx.now);
  } catch (e) {
    if (e instanceof WindowError) return fail("invalid_window", e.message);
    throw e;
  }
  const cw = explainCompareWindow(w, input.compare ?? "previous_period");
  const caveats: string[] = [...meta.caveats, ...w.notes];

  const base = {
    tenant_id: ctx.tenant_id,
    tz: ctx.tz,
    now: ctx.now,
    grain: "day" as const,
    gateway: ctx.gateway ?? { tenant_id: ctx.tenant_id, caller: { kind: "background" as const, feature: "Explain change" } },
  };
  const byDimension: Array<{ dimension: CatalogBreakdown; c: Extract<Contributions, { ok: true }> }> = [];
  let totals: { cur: Parts; prev: Parts; currency: string | null } | null = null;
  let lastFail: FetchResult | null = null;

  for (const dimension of dims) {
    const [a, b] = await Promise.all([
      impl.fetch({ ...base, breakdown: dimension }, w),
      impl.fetch({ ...base, breakdown: dimension }, cw),
    ]);
    if (!a.ok || !b.ok) {
      lastFail = !a.ok ? a : b;
      caveats.push(`The ${DIMENSION_WORDS[dimension]} split could not be read: ${(lastFail as Extract<FetchResult, { ok: false }>).message}`);
      continue;
    }
    if (a.currency && b.currency && a.currency !== b.currency) {
      return fail("currency_mismatch", `The two windows are in ${a.currency} and ${b.currency}. No FX conversion is done.`, caveats);
    }
    caveats.push(...a.caveats.filter((c) => !caveats.includes(c)));
    const cur = totalPartsOf(a, w);
    const prev = totalPartsOf(b, cw);
    totals ??= { cur, prev, currency: a.currency ?? b.currency ?? null };
    const c = computeContributions(impl.value, { total: cur, segments: a.breakdown ?? [] }, { total: prev, segments: b.breakdown ?? [] });
    if (c.ok) byDimension.push({ dimension, c });
  }

  if (!totals) {
    const f = lastFail as Extract<FetchResult, { ok: false }> | null;
    return fail(f?.reason ?? "read_failed", f?.message ?? `${meta.id} could not be read.`, caveats);
  }

  const total = roundFor(meta.unit, impl.value(totals.cur));
  const compare_total = roundFor(meta.unit, impl.value(totals.prev));
  const change = total !== null && compare_total !== null ? roundFor(meta.unit, total - compare_total) : null;
  const change_pct =
    total !== null && compare_total !== null && compare_total !== 0
      ? Math.round(((total - compare_total) / Math.abs(compare_total)) * 1000) / 10
      : null;
  if (change === 0) caveats.push("The number did not change between the two windows, so there is no change to explain.");
  if (byDimension.some((d) => !d.c.additive)) {
    caveats.push("For a ratio, each segment's share is what the total would be if only that segment had not changed; the shares do not add up to 100%.");
  }

  const pct = (s: number | null) => (s === null ? null : Math.round(s * 1000) / 10);
  return {
    status: "ok",
    metric_id: meta.id,
    label: meta.label,
    unit: meta.unit,
    direction: meta.direction,
    window: { since: w.since, until: w.until },
    compare_window: { since: cw.since, until: cw.until },
    total,
    compare_total,
    change,
    change_pct,
    dimensions: byDimension.map(({ dimension, c }) => ({
      dimension,
      additive: c.additive,
      segments: [...c.segments]
        .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
        .slice(0, SEGMENTS_SHOWN)
        .map((s) => ({
          segment: s.key,
          current: roundFor(meta.unit, s.current),
          compare: roundFor(meta.unit, s.compare),
          contribution: roundFor(meta.unit, s.contribution),
          share_pct: pct(s.share),
        })),
      all_other_contribution: c.additive ? roundFor(meta.unit, c.other_contribution) : null,
    })),
    drivers: change === 0 ? [] : pickDrivers(byDimension).map((d) => ({ ...d, contribution: roundFor(meta.unit, d.contribution) ?? 0 })),
    currency: meta.unit === "currency" ? totals.currency : null,
    caveats,
  };
}
