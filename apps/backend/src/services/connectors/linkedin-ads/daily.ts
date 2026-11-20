import { dayChunks } from "@/services/connectors/core/budget-ledger";
import { ExpectedToolError } from "@/services/tools/types";
import { withLinkedInAdsToken } from "./client";
import { LINKEDIN_ADS_DAILY_LIMIT, LINKEDIN_ADS_UNREADABLE, linkedinAdsGet, type LinkedInPage } from "./http";

export type LinkedInDailyPivot = "CAMPAIGN_GROUP" | "CAMPAIGN" | "CREATIVE";

export const LINKEDIN_DAILY_METRICS = ["spend", "impressions", "reach", "clicks", "conversions", "leads", "conversion_value"] as const;
export type LinkedInDailyMetric = (typeof LINKEDIN_DAILY_METRICS)[number];

export type LinkedInDailyAnalyticsRow = {
  date: string;
  pivot: string;
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  conversions: number | null;
  leads: number | null;
  conversion_value: number | null;
  missing_metrics: LinkedInDailyMetric[];
};

export type LinkedInDailyReadOpts = {
  pivot: LinkedInDailyPivot;
  since: string;
  until: string;
  campaigns?: string[];
  fresh?: boolean;
};

export type LinkedInDailyPartialReason = "rate_limited" | "daily_limit" | "element_cap" | "read_failed";

export type LinkedInDailyRead = {
  rows: LinkedInDailyAnalyticsRow[];
  truncated: boolean;
  read_through: string | null;
  partial_reason: LinkedInDailyPartialReason | null;
};

const DAILY_FIELDS = "dateRange,pivotValues,costInLocalCurrency,impressions,approximateMemberReach,clicks,externalWebsiteConversions,oneClickLeads,conversionValueInLocalCurrency";
export const LINKEDIN_DAILY_CHUNK_DAYS = 7;
const ELEMENT_CAP = 15_000;

type LiDailyRow = {
  dateRange?: { start?: { year?: number; month?: number; day?: number } };
  pivotValues?: string[];
  costInLocalCurrency?: string | null;
  impressions?: number;
  approximateMemberReach?: number;
  clicks?: number;
  externalWebsiteConversions?: number;
  oneClickLeads?: number;
  conversionValueInLocalCurrency?: string | null;
};

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (ymd: string) => {
  const [year, month, day] = ymd.split("-").map(Number);
  return { year, month, day };
};

const measured = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function toDailyRow(r: LiDailyRow): LinkedInDailyAnalyticsRow | null {
  const s = r.dateRange?.start;
  const pivot = r.pivotValues?.[0];
  if (!s?.year || !s.month || !s.day || !pivot) return null;
  const values = {
    spend: measured(r.costInLocalCurrency),
    impressions: measured(r.impressions),
    reach: measured(r.approximateMemberReach),
    clicks: measured(r.clicks),
    conversions: measured(r.externalWebsiteConversions),
    leads: measured(r.oneClickLeads),
    conversion_value: measured(r.conversionValueInLocalCurrency),
  };
  return {
    date: `${s.year}-${pad(s.month)}-${pad(s.day)}`,
    pivot,
    ...values,
    missing_metrics: LINKEDIN_DAILY_METRICS.filter((m) => values[m] === null),
  };
}

const partialReason = (e: unknown): LinkedInDailyPartialReason => {
  if (!(e instanceof ExpectedToolError)) return "read_failed";
  if (e.message === LINKEDIN_ADS_DAILY_LIMIT) return "daily_limit";
  return e.meta?.http_status === 429 || e.meta?.status === 429 ? "rate_limited" : "read_failed";
};

const sorted = (rows: LinkedInDailyAnalyticsRow[]): LinkedInDailyAnalyticsRow[] =>
  rows.sort((a, b) => (a.pivot === b.pivot ? a.date.localeCompare(b.date) : a.pivot.localeCompare(b.pivot)));

export async function readLinkedInDailyAnalyticsWithToken(token: string, accountId: string, opts: LinkedInDailyReadOpts): Promise<LinkedInDailyRead> {
  const rows: LinkedInDailyAnalyticsRow[] = [];
  let readThrough: string | null = null;
  for (const chunk of dayChunks(opts.since, opts.until, LINKEDIN_DAILY_CHUNK_DAYS)) {
    let page: LinkedInPage<LiDailyRow>;
    try {
      page = await linkedinAdsGet<LinkedInPage<LiDailyRow>>(
        token,
        "adAnalytics",
        {
          q: "analytics",
          pivot: opts.pivot,
          timeGranularity: "DAILY",
          dateRange: { start: parts(chunk.since), end: parts(chunk.until) },
          accounts: [`urn:li:sponsoredAccount:${accountId}`],
          ...(opts.campaigns ? { campaigns: opts.campaigns } : {}),
        },
        { fields: DAILY_FIELDS },
        { fresh: opts.fresh === true },
      );
    } catch (e) {
      if (readThrough === null) throw e;
      return { rows: sorted(rows), truncated: true, read_through: readThrough, partial_reason: partialReason(e) };
    }
    if (!Array.isArray(page.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
    if (page.elements.length >= ELEMENT_CAP) return { rows: sorted(rows), truncated: true, read_through: readThrough, partial_reason: "element_cap" };
    const chunkRows: LinkedInDailyAnalyticsRow[] = [];
    for (const r of page.elements) {
      const row = toDailyRow(r);
      if (!row) {
        if (readThrough === null) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
        return { rows: sorted(rows), truncated: true, read_through: readThrough, partial_reason: "read_failed" };
      }
      chunkRows.push(row);
    }
    rows.push(...chunkRows);
    readThrough = chunk.until;
  }
  return { rows: sorted(rows), truncated: false, read_through: readThrough, partial_reason: null };
}

export async function readLinkedInDailyAnalytics(tenant_id: string, accountId: string, opts: LinkedInDailyReadOpts): Promise<LinkedInDailyRead> {
  return withLinkedInAdsToken(tenant_id, (token) => readLinkedInDailyAnalyticsWithToken(token, accountId, opts));
}
