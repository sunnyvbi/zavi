
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MIN_BENCH_MS = 20 * MINUTE;
const MAX_BENCH_MS = 8 * 24 * HOUR;

export type LimitKind = "weekly" | "session" | "other";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function limitKind(text: string): LimitKind {
  if (/\bweekly limit\b|\b(opus|sonnet) limit\b/i.test(text)) return "weekly";
  if (/\bsession limit\b/i.test(text)) return "session";
  return "other";
}

function tzOffsetMs(at: number, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
    return Number.isFinite(asUtc) ? asUtc - Math.floor(at / 1000) * 1000 : null;
  } catch {
    return null;
  }
}

function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = tzOffsetMs(guess, tz);
  if (off1 == null) return null;
  const off2 = tzOffsetMs(guess - off1, tz);
  return guess - (off2 ?? off1);
}

function zonedYmd(now: number, tz: string): { y: number; mo: number; d: number } | null {
  const off = tzOffsetMs(now, tz);
  if (off == null) return null;
  const local = new Date(now + off);
  return { y: local.getUTCFullYear(), mo: local.getUTCMonth(), d: local.getUTCDate() };
}

export function parseResetAt(text: string, now: number): number | null {
  const m =
    /resets?\s+(?:on\s+|at\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z_/+\-]+)\)/i.exec(
      text,
    );
  if (!m) return null;
  const [, monName, dayStr, hStr, minStr, ampm, tzRaw] = m;
  const tz = /^utc$/i.test(tzRaw) ? "UTC" : tzRaw;
  let h = Number(hStr) % 12;
  if (ampm.toLowerCase() === "pm") h += 12;
  const mi = minStr ? Number(minStr) : 0;
  if (h > 23 || mi > 59) return null;
  const today = zonedYmd(now, tz);
  if (!today) return null;
  if (monName) {
    const mo = MONTHS.indexOf(monName.slice(0, 3).toLowerCase());
    const d = Number(dayStr);
    if (mo < 0 || !(d >= 1 && d <= 31)) return null;
    let at = zonedEpoch(today.y, mo, d, h, mi, tz);
    if (at != null && at < now - 2 * 24 * HOUR) at = zonedEpoch(today.y + 1, mo, d, h, mi, tz);
    return at;
  }
  let at = zonedEpoch(today.y, today.mo, today.d, h, mi, tz);
  if (at != null && at <= now) at = zonedEpoch(today.y, today.mo, today.d + 1, h, mi, tz);
  return at;
}

export function usageLimitBenchMs(text: string, now: number, sdkResetsAtSec?: number | null): number {
  const stated =
    typeof sdkResetsAtSec === "number" && Number.isFinite(sdkResetsAtSec) && sdkResetsAtSec > 0
      ? sdkResetsAtSec * 1000
      : parseResetAt(text, now);
  const kind = limitKind(text);
  const ms =
    stated != null ? stated - now : kind === "weekly" ? 24 * HOUR : kind === "session" ? 5 * HOUR : MIN_BENCH_MS;
  return Math.min(MAX_BENCH_MS, Math.max(MIN_BENCH_MS, ms));
}
