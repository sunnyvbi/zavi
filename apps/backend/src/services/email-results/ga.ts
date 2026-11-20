
import type { GaFilterExpression, GaRunReportBody, GaRunReportResponse } from "@/services/tools/google-analytics/_client";

export function localParts(at: Date, timeZone: string): { date: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

export function validTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const VISITOR_DAYS = 7;

export function visitorsReportBody(a: { slug: string; startedAt: Date; finishedAt: Date; timeZone: string }): GaRunReportBody {
  const start = localParts(a.startedAt, a.timeZone);
  const end = localParts(new Date(a.finishedAt.getTime() + VISITOR_DAYS * 86_400_000), a.timeZone);
  const day = start.date.replace(/-/g, "");
  const earlyHours = Array.from({ length: start.hour }, (_, h) => `${day}${String(h).padStart(2, "0")}`);
  const exact = (fieldName: string, value: string): GaFilterExpression => ({ filter: { fieldName, stringFilter: { matchType: "EXACT", value, caseSensitive: true } } });
  const expressions: GaFilterExpression[] = [exact("sessionCampaignName", a.slug), exact("sessionSource", "email"), exact("sessionMedium", "zavi")];
  if (earlyHours.length > 0) expressions.push({ notExpression: { filter: { fieldName: "dateHour", inListFilter: { values: earlyHours } } } });
  return {
    dateRanges: [{ startDate: start.date, endDate: end.date < start.date ? start.date : end.date }],
    metrics: [{ name: "totalUsers" }],
    dimensionFilter: { andGroup: { expressions } },
    limit: "1",
  };
}

export function visitorsFrom(r: GaRunReportResponse): number {
  const v = Number(r.rows?.[0]?.metricValues?.[0]?.value ?? "0");
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export const TIMEZONE_PROBE: GaRunReportBody = {
  dateRanges: [{ startDate: "yesterday", endDate: "today" }],
  metrics: [{ name: "totalUsers" }],
  limit: "1",
};
