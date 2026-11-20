export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function dayLabel(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", month: "short", timeZone }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")}`;
}

export function fmtDay(day: string): string {
  return dayLabel(new Date(`${day}T12:00:00Z`), "UTC");
}

export function fmtInstant(iso: string): string {
  return dayLabel(new Date(iso), "America/New_York");
}

export function stuntDayNumber(day: string, startAt: string): number {
  const start = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(startAt));
  return Math.round((Date.parse(day) - Date.parse(start)) / 86400000) + 1;
}

export function relative(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
