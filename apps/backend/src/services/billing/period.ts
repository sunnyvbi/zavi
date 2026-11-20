
function addMonthsClamped(anchor: Date, months: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
  return target;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function calendarMonthWindow(today: string): { start: string; end: string } {
  const t = parseIsoDate(today) ?? new Date();
  return {
    start: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))),
    end: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1))),
  };
}

export function creditMonthWindow(
  anchor: string | null | undefined,
  today: string,
): { start: string; end: string } {
  const a = anchor ? parseIsoDate(new Date(anchor).toISOString()) : null;
  const t = parseIsoDate(today);
  if (!a || !t) return calendarMonthWindow(today);
  let m =
    (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth());
  let start = addMonthsClamped(a, m);
  if (start > t) {
    m -= 1;
    start = addMonthsClamped(a, m);
  }
  return { start: iso(start), end: iso(addMonthsClamped(a, m + 1)) };
}

export function paidWindowToday(anchor: string | null | undefined, now: Date = new Date()): string {
  const a = anchor ? new Date(anchor) : null;
  if (!a || Number.isNaN(a.getTime())) return iso(now);
  const shiftMs = a.getTime() - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  return iso(new Date(now.getTime() - shiftMs));
}
