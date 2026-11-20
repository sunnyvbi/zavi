import { ExpectedToolError } from "@/services/tools/types";
import { dateInZone, shiftDate } from "@/services/growth/account-zone";
import { endpoint, ownedAccount, proxyPages, type RedditAccount } from "./adapter";
import type { RedditLevel } from "./identifiers";
import type { ConversionEvent } from "./readiness";

const MICROS_PER_UNIT = 1_000_000;
const CENTS_PER_UNIT = 100;

export const REPORT_FIELDS = [
  "SPEND", "IMPRESSIONS", "CLICKS",
  "CONVERSION_SIGN_UP_CLICKS", "CONVERSION_SIGN_UP_VIEWS",
  "CONVERSION_LEAD_CLICKS", "CONVERSION_LEAD_VIEWS",
  "CONVERSION_PURCHASE_CLICKS", "CONVERSION_PURCHASE_VIEWS",
  "CONVERSION_PURCHASE_TOTAL_VALUE",
];

export function metric(row: Record<string, unknown>, field: string): number | null {
  const v = field in row ? row[field] : row[field.toLowerCase()];
  if (v === undefined) throw new ExpectedToolError("reddit_ads_bad_metric", `Reddit omitted the requested ${field} metric; the report is incomplete.`);
  if (v === null) return null;
  const numeric = typeof v === "number" || (typeof v === "string" && /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v.trim()));
  const n = numeric ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new ExpectedToolError("reddit_ads_bad_metric", `Reddit returned an invalid ${field} metric.`);
  return n;
}

function assertKnownZone(zone: string): void {
  dateInZone(new Date(), zone);
}

export async function reportRows(account: RedditAccount, accountId: string, since: string, until: string, zone: string, level: RedditLevel = "campaign") {
  assertKnownZone(zone);
  const data = {
    starts_at: `${since}T00:00:00Z`,
    ends_at: `${shiftDate(until, 1)}T00:00:00Z`,
    time_zone_id: zone,
    fields: REPORT_FIELDS,
    breakdowns: [`${level.toUpperCase()}_ID`, "DATE"],
  };
  return proxyPages(account, endpoint("ad_accounts", accountId, "/reports"), data);
}

const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
const per = (v: number | null, unit: number): number | null => (v === null ? null : v / unit);

export function reportMetrics(row: Record<string, unknown>, event?: ConversionEvent) {
  const signups = add(metric(row, "CONVERSION_SIGN_UP_CLICKS"), metric(row, "CONVERSION_SIGN_UP_VIEWS"));
  const leads = add(metric(row, "CONVERSION_LEAD_CLICKS"), metric(row, "CONVERSION_LEAD_VIEWS"));
  const purchases = add(metric(row, "CONVERSION_PURCHASE_CLICKS"), metric(row, "CONVERSION_PURCHASE_VIEWS"));
  const byEvent = { SIGN_UP: signups, LEAD: leads, PURCHASE: purchases };
  return {
    spend: per(metric(row, "SPEND"), MICROS_PER_UNIT),
    impressions: metric(row, "IMPRESSIONS"),
    clicks: metric(row, "CLICKS"),
    signups,
    leads,
    purchases,
    revenue: per(metric(row, "CONVERSION_PURCHASE_TOTAL_VALUE"), CENTS_PER_UNIT),
    goal_conversions: event ? byEvent[event] : null,
  };
}

function rowKey(row: Record<string, unknown>, level: RedditLevel): { object_id: string; date: string } {
  const object_id = row[`${level}_id`] ?? row[`${level.toUpperCase()}_ID`];
  const date = row.date ?? row.DATE;
  if (typeof object_id !== "string" || typeof date !== "string") throw new ExpectedToolError("reddit_ads_bad_response", "Reddit returned a report row without an object or date.");
  const calendarDate = date.slice(0, 10);
  const parsedDate = new Date(`${calendarDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date)
    || !Number.isFinite(Date.parse(date)) || !Number.isFinite(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== calendarDate) {
    throw new ExpectedToolError("reddit_ads_bad_response", "Reddit returned an invalid report date.");
  }
  return { object_id, date: calendarDate };
}

export async function performance(tenantId: string, accountId: string, days: number, level: RedditLevel, event?: ConversionEvent) {
  const { account, details } = await ownedAccount(tenantId, accountId);
  if (typeof details.time_zone_id !== "string") throw new ExpectedToolError("reddit_ads_timezone_unknown", "Reddit did not return the account timezone.");
  const zone = details.time_zone_id;
  const now = new Date();
  const until = dateInZone(now, zone);
  const since = shiftDate(until, 1 - days);
  const rows = await reportRows(account, accountId, since, until, zone, level);
  return {
    ad_account_id: accountId,
    currency: details.currency ?? null,
    account_timezone: zone,
    window: { since, until },
    fetched_at: now.toISOString(),
    attribution: "Attribution windows are set per ad group (view_through_conversion_type); read them with reddit_ads_read_objects before comparing campaigns.",
    reporting_delay: "Metrics may take six hours to stabilize; delayed conversions can revise earlier days.",
    conversion_event: event ?? null,
    rows: rows.map((r) => {
      const key = rowKey(r, level);
      return { ...key, provisional: key.date === until, ...reportMetrics(r, event) };
    }),
  };
}
