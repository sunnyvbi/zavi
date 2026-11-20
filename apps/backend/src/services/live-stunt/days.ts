
export const PT = "America/Los_Angeles";
export const ET = "America/New_York";

export function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function tzOffsetMinutes(atUtc: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(atUtc);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return (asUtc - atUtc.getTime()) / 60000;
}

function localMidnightUtc(y: number, m: number, d: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d);
  const guess = naive - tzOffsetMinutes(new Date(naive), tz) * 60000;
  return naive - tzOffsetMinutes(new Date(guess), tz) * 60000;
}

export function dayRangeUtc(day: string, tz: string): { since: string; until: string } {
  const [y, m, d] = day.split("-").map(Number);
  return {
    since: new Date(localMidnightUtc(y, m, d, tz)).toISOString(),
    until: new Date(localMidnightUtc(y, m, d + 1, tz)).toISOString(),
  };
}

export function measurementDays(a: { start_at: string; end_at: string; now: Date }): { day: string; since: string; until: string }[] {
  const lo = Date.parse(a.start_at);
  const hi = Math.min(a.now.getTime(), Date.parse(a.end_at));
  const out: { day: string; since: string; until: string }[] = [];
  if (!(hi > lo)) return out;
  let key = dayKey(new Date(lo), PT);
  for (let i = 0; i < 32; i++) {
    const r = dayRangeUtc(key, PT);
    const since = Math.max(lo, Date.parse(r.since));
    const until = Math.min(hi, Date.parse(r.until));
    if (since < until) out.push({ day: key, since: new Date(since).toISOString(), until: new Date(until).toISOString() });
    if (Date.parse(r.until) >= hi) break;
    key = dayKey(new Date(Date.parse(r.until) + 3600000), PT);
  }
  return out;
}

export function stuntDay(now: Date, startAt: string): number {
  const startKey = dayKey(new Date(startAt), ET);
  const nowKey = dayKey(now, ET);
  return Math.round((Date.parse(nowKey) - Date.parse(startKey)) / 86400000) + 1;
}

export function recentPerDay(byDay: { spent_usd: number }[]): number {
  const full = byDay.slice(0, -1).slice(-5);
  if (full.length === 0) return 0;
  return Math.round(full.reduce((s, r) => s + r.spent_usd, 0) / full.length);
}

export function runsOutDay(a: { day: number; left: number; perDay: number }): number | null {
  if (a.perDay <= 0) return null;
  return a.day + Math.ceil(a.left / a.perDay);
}
