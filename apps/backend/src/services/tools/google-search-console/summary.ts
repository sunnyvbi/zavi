import { googleSearchConsoleCreds, searchAnalyticsQuery } from "./_client";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export type GscSummaryRow = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscSummary = {
  connected: true;
  site_url: string;
  days: number;
  start_date: string;
  end_date: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  series: Array<{ date: string; clicks: number; impressions: number }>;
  top_queries: GscSummaryRow[];
  top_pages: GscSummaryRow[];
};

function mapRows(
  rows:
    | Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>
    | undefined,
): GscSummaryRow[] {
  return (rows ?? []).map((r) => ({
    key: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

export async function buildSearchConsoleSummary(tenant_id: string, days: number): Promise<GscSummary> {
  const startDate = isoDaysAgo(days);
  const endDate = isoDaysAgo(1);
  const creds = await googleSearchConsoleCreds(tenant_id);

  const [series, queries, pages] = await Promise.all([
    searchAnalyticsQuery(tenant_id, { startDate, endDate, dimensions: ["date"], rowLimit: days }),
    searchAnalyticsQuery(tenant_id, { startDate, endDate, dimensions: ["query"], rowLimit: 10 }),
    searchAnalyticsQuery(tenant_id, { startDate, endDate, dimensions: ["page"], rowLimit: 10 }),
  ]);

  const seriesRows = mapRows(series.rows);
  const clicks = seriesRows.reduce((s, r) => s + r.clicks, 0);
  const impressions = seriesRows.reduce((s, r) => s + r.impressions, 0);
  const position =
    impressions > 0
      ? seriesRows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions
      : 0;

  return {
    connected: true,
    site_url: creds.site_url,
    days,
    start_date: startDate,
    end_date: endDate,
    totals: {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position,
    },
    series: seriesRows.map((r) => ({ date: r.key, clicks: r.clicks, impressions: r.impressions })),
    top_queries: mapRows(queries.rows),
    top_pages: mapRows(pages.rows),
  };
}
