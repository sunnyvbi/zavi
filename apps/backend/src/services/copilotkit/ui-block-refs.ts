
import {
  BlockReceiptSchema,
  type BlockReceipt,
  type ChartBlock,
  type KpiBlock,
} from "@zavi/shared";
import { getResult, resultIsVerified, type StoredResult } from "@/services/analytics/metric-results";

type Ctx = { tenant_id: string; run_id: string };
type Resolved<T> = { ok: true; block: T } | { ok: false; message: string };

const MAX_CHART_POINTS = 30;

function unknownResult(id: string): string {
  return `${id} is not a result from this run (results do not carry over between runs). Call growth__get_metric again, then pass its result_id.`;
}

export function blockReceiptOf(r: StoredResult): BlockReceipt {
  const rc = r.receipt as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
  const w = rc.window as { since?: unknown; until?: unknown } | undefined;
  const candidate = {
    source: str(rc.source, 40) ?? (r.kind === "compute" ? "compute" : "metric"),
    metric_id: str(rc.metric_id, 60),
    definition: str(rc.definition, 300),
    fetched_at: str(rc.fetched_at, 40),
    window:
      w && typeof w.since === "string" && typeof w.until === "string" && w.since && w.until
        ? { since: w.since, until: w.until }
        : undefined,
    tz: str(rc.tz, 64),
    currency: typeof rc.currency === "string" ? rc.currency.slice(0, 8) : rc.currency === null ? null : undefined,
    formula: str(rc.formula, 300),
    caveats: Array.isArray(rc.caveats)
      ? rc.caveats.filter((c): c is string => typeof c === "string").slice(0, 8).map((c) => c.slice(0, 300))
      : undefined,
  };
  const clean = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
  const parsed = BlockReceiptSchema.safeParse(clean);
  return parsed.success ? parsed.data : { source: candidate.source };
}

function unitFor(r: StoredResult, receipt: BlockReceipt): string | undefined {
  if (r.unit === "currency") {
    const c = receipt.currency ?? null;
    return c === "USD" ? "$" : c ? c.slice(0, 8) : undefined;
  }
  if (r.unit === "seconds") return "s";
  return undefined;
}

function pointsOf(r: StoredResult, id: string): { ok: true; points: ChartBlock["series"] } | { ok: false; message: string } {
  if (r.kind !== "metric" || !r.series) {
    return { ok: false, message: `${id} is one computed number, not a series. Show it with show_kpis, or chart a growth__get_metric result.` };
  }
  const points = r.series
    .filter((p) => p.value != null && Number.isFinite(p.value))
    .map((p) => ({ label: p.start, value: p.value as number }));
  if (points.length === 0) return { ok: false, message: `${id} has no values to draw (the source returned none).` };
  if (points.length > MAX_CHART_POINTS) {
    return {
      ok: false,
      message: `${id} has ${points.length} points; a chart holds ${MAX_CHART_POINTS}. Call growth__get_metric again with a coarser grain (week or month) or a shorter window.`,
    };
  }
  return { ok: true, points };
}

export type ChartInput = Omit<ChartBlock, "kind" | "series" | "verified" | "receipt" | "as_of" | "window" | "result_id" | "compare"> & {
  series?: ChartBlock["series"];
  result_id?: string;
  compare_result_id?: string;
};

export function resolveChartInput(ctx: Ctx, input: ChartInput): Resolved<ChartBlock> {
  const { result_id, compare_result_id, series, ...rest } = input;
  if (!result_id) {
    if (!series || series.length === 0) {
      return { ok: false, message: "Pass result_id from growth__get_metric, or series." };
    }
    return { ok: true, block: { kind: "chart", ...rest, series, verified: false } };
  }
  const r = getResult(ctx.tenant_id, ctx.run_id, result_id);
  if (!r) return { ok: false, message: unknownResult(result_id) };
  const main = pointsOf(r, result_id);
  if (!main.ok) return main;
  const receipt = blockReceiptOf(r);

  let compare: ChartBlock["series"] | undefined;
  const c = compare_result_id ? getResult(ctx.tenant_id, ctx.run_id, compare_result_id) : null;
  if (compare_result_id) {
    if (!c) return { ok: false, message: unknownResult(compare_result_id) };
    if (c.receipt.metric_id !== r.receipt.metric_id || c.unit !== r.unit) {
      return { ok: false, message: `${compare_result_id} is a different metric from ${result_id}; compare_result_id must be the same metric over another period.` };
    }
    const cp = pointsOf(c, compare_result_id);
    if (!cp.ok) return cp;
    compare = cp.points;
  }

  const unit = unitFor(r, receipt);
  const { unit: _modelUnit, ...presentation } = rest;
  return {
    ok: true,
    block: {
      kind: "chart",
      ...presentation,
      ...(unit ? { unit } : {}),
      series: main.points,
      ...(compare ? { compare } : {}),
      result_id,
      verified: resultIsVerified(r) && (!c || resultIsVerified(c)),
      receipt,
      ...(receipt.fetched_at ? { as_of: receipt.fetched_at } : {}),
      ...(receipt.window ? { window: receipt.window } : {}),
    },
  };
}

export type KpiInput = {
  title: string;
  items: Array<{
    label: string;
    value?: string | number;
    delta?: string;
    tone?: "up" | "down" | "flat";
    result_id?: string;
  }>;
};

export function resolveKpiInput(ctx: Ctx, input: KpiInput): Resolved<KpiBlock> {
  const items: KpiBlock["items"] = [];
  for (const it of input.items) {
    if (!it.result_id) {
      if (it.value === undefined) return { ok: false, message: `KPI "${it.label}" needs a value or a result_id.` };
      items.push({ label: it.label, value: it.value, ...(it.delta ? { delta: it.delta } : {}), ...(it.tone ? { tone: it.tone } : {}), verified: false });
      continue;
    }
    const r = getResult(ctx.tenant_id, ctx.run_id, it.result_id);
    if (!r) return { ok: false, message: unknownResult(it.result_id) };
    if (r.value == null || !Number.isFinite(r.value)) {
      return { ok: false, message: `${it.result_id} has no value (the source returned none), so there is nothing to show for "${it.label}".` };
    }
    let delta: string | undefined;
    let tone: "up" | "down" | "flat" | undefined;
    if (r.delta_pct != null && Number.isFinite(r.delta_pct)) {
      delta = `${r.delta_pct > 0 ? "+" : ""}${r.delta_pct}% vs prior period`;
      tone = r.delta_pct > 0 ? "up" : r.delta_pct < 0 ? "down" : "flat";
    }
    items.push({
      label: it.label,
      value: r.value,
      ...(delta ? { delta } : {}),
      ...(tone ? { tone } : {}),
      result_id: it.result_id,
      verified: resultIsVerified(r),
      receipt: blockReceiptOf(r),
    });
  }
  return { ok: true, block: { kind: "kpi", title: input.title, items, verified: items.every((i) => i.verified === true) } };
}
