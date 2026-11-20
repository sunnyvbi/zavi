
import { z } from "zod";
import type { ToolContext, ToolSpec } from "@/services/tools/types";
import { CATALOG_BREAKDOWNS, CATALOG_METRIC_IDS, type CatalogMetricMeta } from "@/services/analytics/metric-registry";
import {
  WINDOW_PRESETS,
  WindowError,
  compareWindow,
  localDateOf,
  resolveWindow,
  type ResolvedWindow,
} from "@/services/analytics/metric-time";
import { aggregate, catalogEntry, roundFor, type FetchOk } from "@/services/analytics/metric-catalog";
import { resolveReportingTimezone, type ResolvedTz } from "@/services/analytics/tenant-timezone";
import { newResultId, putResult } from "@/services/analytics/metric-results";
import { recordFiguresFromPull, recordTrustedMoneyValue } from "@/services/agents/engine/figure-ledger";
import { dataNoteCaveats, listActiveDataNotes, type DataNote } from "@/services/analytics/data-notes";

export const GET_METRIC_LEDGER_NAME = "growth__get_metric";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const getMetricInputSchema = z
  .object({
    metric_id: z.enum(CATALOG_METRIC_IDS),
    window: z
      .object({
        preset: z.enum(WINDOW_PRESETS).optional(),
        since: dateStr.optional(),
        until: dateStr.optional(),
        include_today: z.boolean().optional(),
      })
      .strict()
      .optional(),
    grain: z.enum(["day", "week", "month"]).default("day"),
    breakdown: z.enum(CATALOG_BREAKDOWNS).optional(),
    compare: z.enum(["previous_period", "previous_year"]).optional(),
  })
  .strict();

export type GetMetricInput = z.infer<typeof getMetricInputSchema>;

export type GetMetricDeps = {
  now: () => Date;
  resolveTz: (tenant_id: string) => Promise<ResolvedTz>;
  readDataNotes?: (tenant_id: string, metric_id: string) => Promise<DataNote[]>;
};

const realDeps: Required<GetMetricDeps> = {
  now: () => new Date(),
  resolveTz: (tenant_id) => resolveReportingTimezone(tenant_id),
  readDataNotes: (tenant_id, metric_id) => listActiveDataNotes(tenant_id, metric_id),
};

async function noteCaveats(deps: GetMetricDeps, tenant_id: string, metric_id: string): Promise<string[]> {
  try {
    return dataNoteCaveats(await (deps.readDataNotes ?? realDeps.readDataNotes)(tenant_id, metric_id));
  } catch {
    return ["The founder's data notes could not be read just now, so a saved correction may be missing here."];
  }
}

function baseReceipt(meta: CatalogMetricMeta, w: { since: string; until: string }, tz: string, fetchedAt: string) {
  return {
    source: meta.source,
    metric_id: meta.id,
    definition: meta.definition,
    window: { since: w.since, until: w.until },
    tz,
    fetched_at: fetchedAt,
  };
}

function record(ctx: ToolContext, output: unknown): void {
  if (!ctx.run_id) return;
  try {
    recordFiguresFromPull(ctx.run_id, JSON.stringify(output), GET_METRIC_LEDGER_NAME);
  } catch {
  }
}

export async function runGetMetric(ctx: ToolContext, raw: unknown, deps: GetMetricDeps = realDeps) {
  const input = getMetricInputSchema.parse(raw);
  const entry = catalogEntry(input.metric_id);
  if (!entry) throw new Error(`catalog metric ${input.metric_id} has no implementation`);
  const { meta, impl } = entry;
  const now = deps.now();
  const fetchedAt = now.toISOString();
  const { tz } = await deps.resolveTz(ctx.tenant_id);

  const refuse = (status: string, message: string, w: { since: string; until: string }, caveats: string[] = []) => {
    const out = {
      result_id: null,
      metric_id: meta.id,
      status,
      message,
      receipt: { ...baseReceipt(meta, w, tz, fetchedAt), caveats: [...meta.caveats, ...caveats] },
    };
    return out;
  };

  let window: ResolvedWindow;
  try {
    window = meta.point_in_time
      ? { since: localDateOf(now, tz), until: localDateOf(now, tz), tz, notes: [] }
      : resolveWindow(input.window, tz, now);
  } catch (e) {
    if (e instanceof WindowError) return refuse("invalid_window", e.message, { since: "", until: "" });
    throw e;
  }

  const grain = meta.point_in_time ? "day" : input.grain;
  if (!meta.grains.includes(grain)) {
    return refuse("unsupported", `${meta.id} supports grain ${meta.grains.join(", ")}.`, window);
  }
  if (input.breakdown && meta.outcome) {
    return refuse(
      "unsupported_definition",
      `A per-${input.breakdown} ${meta.id} needs an attribution mapping (which orders each channel or campaign brought in), and none is set up. Ask again without a breakdown for the blended number.`,
      window,
    );
  }
  if (input.breakdown && !meta.breakdowns.includes(input.breakdown)) {
    return refuse(
      "unsupported",
      meta.breakdowns.length
        ? `${meta.id} can be broken down by ${meta.breakdowns.join(", ")}, not ${input.breakdown}.`
        : `${meta.id} has no breakdown.`,
      window,
    );
  }

  const fctx = {
    tenant_id: ctx.tenant_id,
    tz,
    now,
    grain,
    breakdown: input.breakdown,
    gateway: {
      tenant_id: ctx.tenant_id,
      caller: { kind: "agent" as const, agent_slug: ctx.agent_slug ?? null, run_id: ctx.run_id ?? null, tool_name: "get_metric" },
    },
  };
  const main = await impl.fetch(fctx, window);
  if (!main.ok) {
    const out = refuse(main.reason, main.message, window, main.caveats ?? []);
    record(ctx, out);
    return out;
  }

  const agg = aggregate(meta, impl, main, window, grain);
  if (!meta.point_in_time && input.window?.include_today) {
    const today = localDateOf(now, tz);
    for (const p of agg.series) if (p.end >= today) p.partial = true;
  }
  const caveats = [
    ...meta.caveats,
    ...window.notes,
    ...main.caveats,
    ...(main.estimate?.assumptions ?? []),
    ...(await noteCaveats(deps, ctx.tenant_id, meta.id)),
  ];
  if (!meta.point_in_time && agg.series.some((p) => p.partial)) {
    caveats.push(`Buckets marked partial are only partly inside ${window.since}..${window.until}.`);
  }

  let compare_total: number | null | undefined;
  let compareWin: { since: string; until: string } | undefined;
  if (input.compare && meta.point_in_time) {
    caveats.push("compare is not applied to a point-in-time metric.");
  } else if (input.compare && meta.outcome) {
    caveats.push(`compare is not run for ${meta.id} (each read scans the whole order history); read the earlier window separately.`);
  } else if (input.compare) {
    const cw = compareWindow(window, input.compare);
    compareWin = { since: cw.since, until: cw.until };
    const prior = await impl.fetch({ ...fctx, breakdown: undefined }, cw);
    if (prior.ok) {
      compare_total = aggregate(meta, impl, prior as FetchOk, cw, grain).total;
      if (main.currency && prior.currency && main.currency !== prior.currency) {
        compare_total = null;
        caveats.push(`The compare window is in ${prior.currency}, not ${main.currency}, so it is not compared.`);
      }
    } else {
      compare_total = null;
      caveats.push(`The compare window ${cw.since}..${cw.until} could not be read: ${prior.message}`);
    }
  }

  const total = agg.total;
  const delta_abs =
    compare_total != null && total != null ? roundFor(meta.unit, total - compare_total) : compare_total === undefined ? undefined : null;
  const delta_pct =
    compare_total != null && total != null && compare_total !== 0
      ? Math.round(((total - compare_total) / Math.abs(compare_total)) * 10000) / 100
      : compare_total === undefined
        ? undefined
        : null;

  const result_id = newResultId("metric");
  const receipt = {
    ...baseReceipt(meta, window, tz, fetchedAt),
    params: {
      grain,
      ...(input.window ? { window: input.window } : { window: { preset: meta.point_in_time ? "now" : "last_28d" } }),
      ...(input.breakdown ? { breakdown: input.breakdown } : {}),
      ...(input.compare ? { compare: input.compare, compare_window: compareWin } : {}),
      ...main.params,
    },
    currency: meta.unit === "currency" ? main.currency : null,
    row_count: main.row_count,
    truncated: main.truncated,
    caveats,
  };

  const output = {
    result_id,
    metric_id: meta.id,
    label: meta.label,
    unit: meta.unit,
    status: "ok" as const,
    series: agg.series,
    total,
    ...(agg.total_bounds ? { bounds: agg.total_bounds } : {}),
    ...(main.estimate
      ? { estimate: { exact: main.estimate.exact, why_not_exact: main.estimate.exact ? [] : main.estimate.assumptions, coverage: main.estimate.coverage } }
      : {}),
    ...(compare_total !== undefined ? { compare_total, delta_abs, delta_pct } : {}),
    ...(agg.breakdown ? { breakdown: agg.breakdown } : {}),
    receipt,
  };

  putResult(ctx.tenant_id, ctx.run_id, {
    result_id,
    kind: "metric",
    value: total,
    compare_value: compare_total ?? null,
    receipt,
    label: meta.label,
    unit: meta.unit,
    series: agg.series,
    delta_pct: delta_pct ?? null,
  });
  record(ctx, output);
  if (ctx.run_id && meta.unit === "currency") {
    for (const v of [total, compare_total]) if (typeof v === "number") recordTrustedMoneyValue(ctx.run_id, v);
  }
  return output;
}

export const getMetricTool: ToolSpec = {
  name: "growth_get_metric",
  effect: "read",
  description:
    "Read ONE business metric from the catalog, computed in code from the connected source, with a receipt. Use this instead of reading raw rows and doing the math yourself. " +
    "metric_id is one of the catalog ids (net_revenue, gross_revenue, refunds, mrr, new_customers, meta_/google_ ad_spend|clicks|cpc|conversions|cpa|roas, ad_spend_total, sessions, users, key_events, conversion_rate, search_clicks|impressions|ctr|avg_position, signups, bookings, cac, blended_roas, first_completed_cac, completed_net_roas). " +
    "first_completed_cac / completed_net_roas are blended finished-outcome CAC/ROAS on the founder-confirmed order map; total null + bounds means not exact (say the bounds and why_not_exact). " +
    "window: {preset} (last_7d, last_28d, last_month, month_to_date, ...) or {since, until} as YYYY-MM-DD in the tenant's reporting time zone; today's partial day is excluded unless include_today. grain: day|week|month. compare: previous_period|previous_year adds compare_total, delta_abs and delta_pct. " +
    "Returns {result_id, series, total, receipt}; pass result_id to growth__compute for any further arithmetic, and quote the receipt's caveats. " +
    "A status other than ok (not_connected, read_failed, needs_confirmation, currency_mismatch, unsupported, unsupported_definition, too_many_rows, empty_window) means there is NO number: say so and say what would fix it, never estimate.",
  input_schema: getMetricInputSchema,
  async execute(ctx, input) {
    return runGetMetric(ctx, input);
  },
};
