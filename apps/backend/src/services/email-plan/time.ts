
export type WallTime = { date: string; time: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function wallOf(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")), h: Number(get("hour")), mi: Number(get("minute")), wd: get("weekday") };
}

export function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

export type ToInstant = { ok: true; at: Date } | { ok: false; code: "bad_time" | "nonexistent_time" | "bad_timezone" };

export function wallToInstant(w: WallTime, tz: string): ToInstant {
  if (!isKnownZone(tz)) return { ok: false, code: "bad_timezone" };
  const dm = DATE.exec(w.date);
  const tm = TIME.exec(w.time);
  if (!dm || !tm) return { ok: false, code: "bad_time" };
  const [y, mo, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return { ok: false, code: "bad_time" };
  const offsetAt = (ms: number) => {
    const p = wallOf(ms, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000;
  };
  const candidates = new Set<number>();
  for (const probe of [naive - 14 * 3_600_000, naive, naive + 14 * 3_600_000]) candidates.add(naive - offsetAt(probe));
  const hits = [...candidates]
    .filter((ms) => {
      const p = wallOf(ms, tz);
      return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
    })
    .sort((a, b) => a - b);
  return hits.length ? { ok: true, at: new Date(hits[0]) } : { ok: false, code: "nonexistent_time" };
}

export function wallLabel(at: Date | string, tz: string): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

export function wallDate(at: Date, tz: string): string {
  const p = wallOf(at.getTime(), tz);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export const WEEKLY_PLAN_CRON = "0 8 * * 1";
