
import { searchAnalyticsQuery, type GscSearchAnalyticsResponse } from "@/services/tools/google-search-console/_client";
import type { ResolvedWindow } from "@/services/analytics/metric-time";
import { div, failFrom, sumByDate, sumByKey } from "./shared";
import type { FetchOk, FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

const ROW_LIMIT = 25_000;
const BREAKDOWN_TOP = 50;

function parts(r: NonNullable<GscSearchAnalyticsResponse["rows"]>[number]): Parts {
  const impressions = Number(r.impressions ?? 0);
  return {
    clicks: Number(r.clicks ?? 0),
    impressions,
    pos_x_impr: Number(r.position ?? 0) * impressions,
  };
}

async function fetchSearch(ctx: MetricFetchCtx, w: ResolvedWindow): Promise<FetchResult> {
  try {
    const res = await searchAnalyticsQuery(ctx.tenant_id, {
      startDate: w.since,
      endDate: w.until,
      dimensions: ["date"],
      rowLimit: ROW_LIMIT,
      type: "web",
    });
    const rows = res.rows ?? [];
    const out: FetchOk = {
      ok: true,
      daily: sumByDate(rows.map((r) => ({ date: r.keys?.[0] ?? "", parts: parts(r) }))),
      currency: null,
      row_count: rows.length,
      truncated: false,
      caveats: [],
      params: { source: "gsc.searchAnalytics", dimensions: ["date"], type: "web", since: w.since, until: w.until },
    };
    if (ctx.breakdown === "query" || ctx.breakdown === "page") {
      const by = await searchAnalyticsQuery(ctx.tenant_id, {
        startDate: w.since,
        endDate: w.until,
        dimensions: [ctx.breakdown],
        rowLimit: BREAKDOWN_TOP,
        type: "web",
      });
      out.breakdown = sumByKey((by.rows ?? []).map((r) => ({ key: r.keys?.[0] ?? "", parts: parts(r) })), "clicks");
      out.caveats.push(
        `Breakdown shows the top ${BREAKDOWN_TOP} ${ctx.breakdown === "query" ? "queries" : "pages"} by clicks.` +
          (ctx.breakdown === "query" ? " Google hides rare queries, so they add up to less than the total." : ""),
      );
    }
    return out;
  } catch (e) {
    return failFrom(e, "Google Search Console");
  }
}

export const gscMetrics: Record<string, MetricImpl> = {
  search_clicks: { value: (p) => p.clicks ?? 0, fetch: fetchSearch },
  search_impressions: { value: (p) => p.impressions ?? 0, fetch: fetchSearch },
  search_ctr: { value: (p) => div(p.clicks, p.impressions), fetch: fetchSearch },
  search_avg_position: { value: (p) => div(p.pos_x_impr, p.impressions), fetch: fetchSearch },
};
