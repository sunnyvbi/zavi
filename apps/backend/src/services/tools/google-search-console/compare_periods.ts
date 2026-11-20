
import { z } from "zod";
import { googleSearchConsoleCreds, searchAnalyticsQuery, type GscSearchAnalyticsResponse } from "./_client";
import { customRangeSchema, dateRangeSchema, previousWindow, resolveRange, windowDays } from "./_range";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  dimension: z.enum(["query", "page", "country", "device"]).default("page"),
  date_range: dateRangeSchema,
  custom_range: customRangeSchema.optional(),
  min_impressions: z.number().int().min(0).max(100_000).default(10),
  limit: z.number().int().min(1).max(100).default(20),
});

export type GscMetrics = { clicks: number; impressions: number; ctr: number; position: number };
type Metrics = GscMetrics;
const ZERO: Metrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

export function toMap(res: GscSearchAnalyticsResponse): Map<string, Metrics> {
  const m = new Map<string, Metrics>();
  for (const r of res.rows ?? []) {
    m.set(r.keys?.[0] ?? "", {
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    });
  }
  return m;
}

export function totals(m: Map<string, Metrics>): Metrics {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const v of m.values()) {
    clicks += v.clicks;
    impressions += v.impressions;
    weighted += v.position * v.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  };
}

export function compareRows(cur: Map<string, Metrics>, prev: Map<string, Metrics>) {
  return [...new Set([...cur.keys(), ...prev.keys()])].map((key) => {
    const c = cur.get(key) ?? ZERO;
    const p = prev.get(key) ?? ZERO;
    return {
      key,
      current: c,
      previous: p,
      clicks_delta: c.clicks - p.clicks,
      impressions_delta: c.impressions - p.impressions,
      position_delta: c.position && p.position ? c.position - p.position : null,
      status: !prev.has(key) ? "gained" : !cur.has(key) ? "lost" : c.clicks >= p.clicks ? "improved" : "declined",
    };
  });
}

export const gscComparePeriodsTool: ToolSpec = {
  name: "google_search_console_compare_periods",
  effect: "read",
  description:
    "Compare organic performance against the immediately preceding equal-length window and return what moved: totals delta plus per-row clicks/impressions/position deltas by query, page, country or device, split into declined, improved, lost (had traffic before, none now) and gained (new this window). Use this for 'why is organic traffic down' or 'what did that change do' — a single-window read cannot answer either. position_delta is current minus previous, so a NEGATIVE value means the rank improved. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { dimension, date_range, custom_range, min_impressions, limit } = inputSchema.parse(input);
    const current = resolveRange(date_range, custom_range);
    const previous = previousWindow(current);

    const creds = await googleSearchConsoleCreds(ctx.tenant_id);
    const [curRes, prevRes] = await Promise.all([
      searchAnalyticsQuery(
        ctx.tenant_id,
        { startDate: current.startDate, endDate: current.endDate, dimensions: [dimension], rowLimit: 1000 },
        creds,
      ),
      searchAnalyticsQuery(
        ctx.tenant_id,
        { startDate: previous.startDate, endDate: previous.endDate, dimensions: [dimension], rowLimit: 1000 },
        creds,
      ),
    ]);

    const cur = toMap(curRes);
    const prev = toMap(prevRes);

    const rows = compareRows(cur, prev).filter((r) => r.current.impressions + r.previous.impressions >= min_impressions);

    const byAbsClicks = (a: { clicks_delta: number }, b: { clicks_delta: number }) =>
      Math.abs(b.clicks_delta) - Math.abs(a.clicks_delta);
    const pick = (status: string) => rows.filter((r) => r.status === status).sort(byAbsClicks).slice(0, limit);

    const curTotals = totals(cur);
    const prevTotals = totals(prev);

    return {
      dimension,
      current_range: current.label,
      previous_range: previous.label,
      window_days: windowDays(current),
      site_url: creds.site_url,
      totals: {
        current: curTotals,
        previous: prevTotals,
        clicks_delta: curTotals.clicks - prevTotals.clicks,
        impressions_delta: curTotals.impressions - prevTotals.impressions,
        clicks_delta_pct: prevTotals.clicks > 0 ? (curTotals.clicks - prevTotals.clicks) / prevTotals.clicks : null,
        position_delta: curTotals.position && prevTotals.position ? curTotals.position - prevTotals.position : null,
      },
      truncated_at_api_limit: (curRes.rows ?? []).length >= 1000 || (prevRes.rows ?? []).length >= 1000,
      rows_compared: rows.length,
      declined: pick("declined"),
      improved: pick("improved"),
      lost: pick("lost"),
      gained: pick("gained"),
    };
  },
};
