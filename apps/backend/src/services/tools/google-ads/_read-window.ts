import { gadsSearch, type GoogleAdsSearch } from "./_client";
import { ExpectedToolError } from "@/services/tools/types";

export async function accountClock(tenantId: string, search: GoogleAdsSearch = (query) => gadsSearch(tenantId, query)) {
  const rows = await search("SELECT customer.time_zone FROM customer LIMIT 1") as { customer?: { timeZone?: string } }[];
  const timeZone = rows[0]?.customer?.timeZone;
  if (!timeZone) throw new ExpectedToolError("google_ads_timezone_not_observed", "Account time zone was not reported; a dated query cannot be safely constructed.");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  return { time_zone: timeZone, date, date_time: `${date} ${value("hour")}:${value("minute")}:${value("second")}` };
}

export function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
