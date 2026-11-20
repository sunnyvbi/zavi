import type { LiveUpcar, PublicDay } from "@/lib/marketing/liveUpcar";
import { stuntDayNumber } from "./format";

export function parseDayNumber(raw: string): number | null {
  return /^[1-9]\d?$/.test(raw) ? Number(raw) : null;
}

type ByDay = NonNullable<LiveUpcar["numbers"]>["by_day"][number];
export type DayFigures = { spent_usd: number | null; hosts: number | null; bookings: number | null };

export type PublishedDayPage = {
  n: number;
  entry: PublicDay;
  figures: DayFigures;
  prev: number | null;
  next: number | null;
};

export function runDayCount(clock: LiveUpcar["clock"]): number {
  return Math.max(1, stuntDayNumber(etDate(clock.end_at), clock.start_at));
}

export function publishedDayNumbers(d: LiveUpcar): { n: number; entry: PublicDay }[] {
  if (d.locked) return [];
  const days = runDayCount(d.clock);
  const seen = new Set<number>();
  return d.days
    .map((entry) => ({ n: stuntDayNumber(entry.day, d.clock.start_at), entry }))
    .filter(({ n }) => {
      if (!Number.isInteger(n) || n < 1 || n > days || seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .sort((a, b) => a.n - b.n);
}

export function publishedDay(d: LiveUpcar, raw: string): PublishedDayPage | null {
  const n = parseDayNumber(raw);
  if (n === null) return null;
  const all = publishedDayNumbers(d);
  const i = all.findIndex((x) => x.n === n);
  if (i === -1) return null;
  const entry = all[i].entry;
  const row = d.numbers?.by_day.find((r) => r.day === entry.day);
  return {
    n,
    entry,
    figures: figuresFor(entry, row),
    prev: i > 0 ? all[i - 1].n : null,
    next: i < all.length - 1 ? all[i + 1].n : null,
  };
}

function figuresFor(entry: PublicDay, row: ByDay | undefined): DayFigures {
  if (row) return { spent_usd: row.spent_usd, hosts: row.hosts, bookings: row.bookings };
  return { spent_usd: entry.spent_usd, hosts: entry.hosts, bookings: entry.bookings };
}

export function daysWithFigures(d: LiveUpcar): PublicDay[] {
  const byDay = d.numbers?.by_day;
  if (!byDay) return d.days;
  return d.days.map((entry) => ({ ...entry, ...figuresFor(entry, byDay.find((r) => r.day === entry.day)) }));
}

function etDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
}

export function dayDates(entry: PublicDay): { published: string; modified: string } {
  const dayStart = etMidnight(entry.day);
  const published = entry.published_at && Date.parse(entry.published_at) >= Date.parse(dayStart) ? entry.published_at : dayStart;
  const updated = entry.updated_at ?? published;
  const modified = Date.parse(updated) >= Date.parse(published) ? updated : published;
  return { published, modified };
}

function etMidnight(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const hourEt = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(new Date(ms));
  const edt = Date.UTC(y, m - 1, d, 4);
  return new Date(hourEt(edt) === "00" ? edt : Date.UTC(y, m - 1, d, 5)).toISOString();
}
