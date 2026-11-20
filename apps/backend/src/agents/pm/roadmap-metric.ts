
import type { AgentContext } from "@/services/agents/types";

export const BASELINE_NAMED_QUERIES = [
  "query_funnel_by_geo_category",
  "query_recent_transactions",
  "query_active_supply_by_geo_category",
] as const;
export type BaselineQuery = (typeof BASELINE_NAMED_QUERIES)[number];

export const METRIC_MOVE_REL_THRESHOLD = 0.1;
export const METRIC_MOVE_ABS_FLOOR = 1;

export type BaselineAnchor = {
  baseline_query: BaselineQuery;
  baseline_value: number;
};

export type OperatorDbTrace = {
  name: string;
  output_preview?: string;
  status?: string;
};

export function toBaselineQueryName(toolName: string): BaselineQuery | null {
  const bare = toolName.replace(/^operator_db__?/, "");
  return (BASELINE_NAMED_QUERIES as readonly string[]).includes(bare)
    ? (bare as BaselineQuery)
    : null;
}

export function comparableScalar(query: BaselineQuery, parsed: unknown): number | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const data = (parsed as { data?: unknown }).data ?? parsed;

  if (query === "query_recent_transactions") {
    if (Array.isArray(data)) return data.length;
    const rows = (data as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows.length : null;
  }

  const rows = (data as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return null;
  const field = query === "query_funnel_by_geo_category" ? "book_n" : "active_listings_n";
  let sum = 0;
  let sawNumber = false;
  for (const r of rows) {
    const v = r && typeof r === "object" ? (r as Record<string, unknown>)[field] : undefined;
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      sawNumber = true;
    }
  }
  return sawNumber ? sum : null;
}

export function deriveBaselineFromTraces(
  traces: readonly OperatorDbTrace[] | undefined | null,
): BaselineAnchor | null {
  if (!traces || traces.length === 0) return null;
  for (const t of traces) {
    if (!t || typeof t.name !== "string") continue;
    if (t.status && t.status !== "ok") continue;
    const q = toBaselineQueryName(t.name);
    if (!q) continue;
    let parsed: unknown;
    try {
      parsed = t.output_preview ? JSON.parse(t.output_preview) : null;
    } catch {
      continue;
    }
    const scalar = comparableScalar(q, parsed);
    if (scalar != null) return { baseline_query: q, baseline_value: scalar };
  }
  return null;
}

export function classifyMetricMove(
  baseline: number,
  current: number,
): "moved" | "flat" {
  const absDelta = Math.abs(current - baseline);
  if (absDelta < METRIC_MOVE_ABS_FLOOR) return "flat";
  const rel = absDelta / Math.max(Math.abs(baseline), 1);
  return rel > METRIC_MOVE_REL_THRESHOLD ? "moved" : "flat";
}

export async function rerunBaselineMetric(
  ctx: AgentContext,
  query: BaselineQuery,
): Promise<number | null> {
  try {
    if (query === "query_recent_transactions") return null;

    const { resolveAttachedDb } = await import("@/services/data-gateway");
    const { driver, cfg, close } = await resolveAttachedDb({
      tenant_id: ctx.tenant_id,
      caller: { kind: "agent", agent_slug: ctx.agent?.slug ?? "pm", run_id: ctx.runId ?? null, tool_name: `operator_db__${query}` },
    });
    try {
    const filter = { lookback_weeks: 13, top_n: 100 } as const;
    const result =
      query === "query_funnel_by_geo_category"
        ? await driver.query_funnel_by_geo_category(filter, cfg as never)
        : await driver.query_active_supply_by_geo_category(filter, cfg as never);

    return comparableScalar(query, result);
    } finally {
      await close();
    }
  } catch (e) {
    console.warn(
      `[pm roadmap metric] live re-run of ${query} failed for tenant=${ctx.tenant_id}: ${(e as Error).message}`,
    );
    return null;
  }
}
