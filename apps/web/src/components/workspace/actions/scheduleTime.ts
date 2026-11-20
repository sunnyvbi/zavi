export const SCHEDULE_DAYS_AHEAD = 60;
export const SCHEDULE_STRIP = 5;

export type Clock = { hour: string; minute: string; pm: boolean };

const two = (n: number): string => String(n).padStart(2, "0");

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function shiftDay(day: string, by: number): string {
  const d = parseDay(day);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + by));
}

export function shiftMonth(day: string, by: number): string {
  const d = parseDay(day);
  return localDay(new Date(d.getFullYear(), d.getMonth() + by, 1));
}

export function monthLabel(day: string): string {
  return parseDay(day).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function wallTime(d: Date): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function zonedParts(d: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d).map((part) => [part.type, part.value]),
  );
}

export function dayInTimeZone(d: Date, timeZone?: string | null): string {
  if (!timeZone) return localDay(d);
  const parts = zonedParts(d, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function wallTimeInZone(d: Date, timeZone?: string | null): string {
  if (!timeZone) return wallTime(d);
  const parts = zonedParts(d, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function soonTime(now: Date, timeZone?: string | null): string {
  const later = new Date(now.getTime() + 60 * 60_000);
  return dayInTimeZone(later, timeZone) === dayInTimeZone(now, timeZone) ? wallTimeInZone(later, timeZone) : "23:59";
}

export function clockOf(time: string): Clock {
  const [h = 9, m = 0] = time.split(":").map(Number);
  return { hour: String(h % 12 || 12), minute: two(m), pm: h >= 12 };
}

export function time24({ hour, minute, pm }: Clock): string | null {
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h < 1 || h > 12 || m > 59) return null;
  return `${two((h % 12) + (pm ? 12 : 0))}:${two(m)}`;
}

export function timeLabel(time: string): string {
  const c = clockOf(time);
  return `${c.hour}:${c.minute} ${c.pm ? "PM" : "AM"}`;
}
