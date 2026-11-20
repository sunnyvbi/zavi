
import { tzOffsetMinutes, isValidTz, localWallToUtc } from "@/services/agents/reminders";

export const DEFAULT_TENANT_TZ = "America/Los_Angeles";

export function tenantDayStartIso(timezone: string | null | undefined, now: Date = new Date()): string {
  const tz = timezone && isValidTz(timezone) ? timezone : null;
  if (!tz) return utcDayStartIso(now);

  const shifted = new Date(now.getTime() + tzOffsetMinutes(tz, now) * 60_000);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");

  const start = localWallToUtc(`${y}-${mo}-${d}T00:00`, tz);
  return start ? start.toISOString() : utcDayStartIso(now);
}

function utcDayStartIso(now: Date): string {
  return now.toISOString().slice(0, 10) + "T00:00:00.000Z";
}
