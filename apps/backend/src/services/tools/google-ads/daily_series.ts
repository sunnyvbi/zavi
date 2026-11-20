
import { gadsSearch } from "./_client";

export type GoogleDailyRow = {
  date: string;
  campaign_id: string;
  campaign_name: string;
  spend_usd: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversions_value_usd: number;
};

type GadsDailyRow = {
  campaign?: { id?: string; name?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: string;
    conversionsValue?: string;
  };
  segments?: { date?: string };
};

const GADS_DATE_RANGES = [
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;
export type GoogleDailyRange = (typeof GADS_DATE_RANGES)[number];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function fetchGoogleDailySeries(
  tenant_id: string,
  opts: {
    date_range?: GoogleDailyRange;
    custom_range?: { since: string; until: string };
  },
): Promise<{ rows: GoogleDailyRow[] }> {
  const range = opts.date_range ?? "LAST_30_DAYS";
  const dateClause = opts.custom_range
    ? `segments.date BETWEEN '${opts.custom_range.since}' AND '${opts.custom_range.until}'`
    : `segments.date DURING ${range}`;
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE ${dateClause}
    ORDER BY campaign.id, segments.date
  `;
  const raw = (await gadsSearch(tenant_id, query)) as GadsDailyRow[];
  const rows: GoogleDailyRow[] = raw.map((r) => {
    const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
    return {
      date: r.segments?.date ?? "",
      campaign_id: r.campaign?.id ?? "",
      campaign_name: r.campaign?.name ?? "",
      spend_usd: round2(cost),
      impressions: Number(r.metrics?.impressions ?? 0),
      clicks: Number(r.metrics?.clicks ?? 0),
      conversions: round2(Number(r.metrics?.conversions ?? 0)),
      conversions_value_usd: round2(Number(r.metrics?.conversionsValue ?? 0)),
    };
  });
  return { rows };
}
