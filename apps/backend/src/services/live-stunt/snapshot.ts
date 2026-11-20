import type { LiveStuntConfig } from "./config";
import { dayKey, ET, measurementDays, stuntDay } from "./days";
import { channelLabel } from "./labels";

export type SnapshotDay = { day: string; bookings: number | null; hosts: number | null; spent_usd: number; booking_value_usd?: number | null };
export type StuntSnapshot = {
  taken_at: string;
  day: number;
  by_day: SnapshotDay[];
  pace: { bookings_per_week: number | null; hosts_per_week: number | null; booking_value_per_week?: number | null };
  last_review_at: string | null;
  changes_today: number;
  channels_today: string[];
};
export type SnapshotDeps = {
  countBookings(since: string, until: string): Promise<number | null>;
  countHosts(since: string, until: string): Promise<number | null>;
  bookingValue?(since: string, until: string): Promise<number | null>;
  spendByDay(fromDay: string, toDay: string): Promise<Record<string, number>>;
  nowLine(sinceUtc: string): Promise<{ last_review_at: string | null; changes_today: number; channel_slugs: string[] }>;
  now(): Date;
};

const RECOUNT_DAYS = 2;
const PACE_WEEKS = 4;

export async function buildSnapshot(cfg: LiveStuntConfig, deps: SnapshotDeps, previous?: StuntSnapshot | null): Promise<StuntSnapshot> {
  const now = deps.now();
  const days = measurementDays({ start_at: cfg.start_at, end_at: cfg.end_at, now });
  const prevByDay = new Map((previous?.by_day ?? []).map((d) => [d.day, d]));

  const counted = await Promise.all(
    days.map(async (d, i) => {
      const recent = i >= days.length - RECOUNT_DAYS;
      const prev = prevByDay.get(d.day);
      const value = deps.bookingValue
        ? !recent && prev && prev.booking_value_usd != null ? Promise.resolve(prev.booking_value_usd) : deps.bookingValue(d.since, d.until)
        : Promise.resolve(null);
      const [bookings, hosts, booking_value_usd] = await Promise.all([
        !recent && prev ? Promise.resolve(prev.bookings) : deps.countBookings(d.since, d.until),
        deps.countHosts(d.since, d.until),
        value,
      ]);
      return { day: d.day, bookings, hosts, booking_value_usd };
    }),
  );

  const firstSpendDay = dayKey(new Date(cfg.start_at), ET);
  const lastSpendDay = dayKey(new Date(cfg.end_at), ET);
  const spend = days.length ? await deps.spendByDay(firstSpendDay, lastSpendDay) : {};
  const inStunt = (day: string) => day >= firstSpendDay && day <= lastSpendDay;
  const by_day: SnapshotDay[] = counted.map((c) => ({ ...c, spent_usd: inStunt(c.day) ? Math.round((spend[c.day] ?? 0) * 100) / 100 : 0 }));

  let pace = previous?.pace ?? null;
  if (!pace || pace.bookings_per_week == null || pace.hosts_per_week == null || (deps.bookingValue && pace.booking_value_per_week == null)) {
    const until = new Date(Date.parse(cfg.start_at)).toISOString();
    const since = new Date(Date.parse(cfg.start_at) - PACE_WEEKS * 7 * 86400000).toISOString();
    const [b, h, v] = await Promise.all([
      deps.countBookings(since, until),
      deps.countHosts(since, until),
      deps.bookingValue ? deps.bookingValue(since, until) : Promise.resolve(null),
    ]);
    pace = {
      bookings_per_week: b == null ? null : Math.round(b / PACE_WEEKS),
      hosts_per_week: h == null ? null : Math.round(h / PACE_WEEKS),
      booking_value_per_week: v == null ? null : Math.round(v / PACE_WEEKS),
    };
  }

  const startOfTodayUtc = days.length ? days[days.length - 1].since : now.toISOString();
  const line = await deps.nowLine(startOfTodayUtc);

  return {
    taken_at: now.toISOString(),
    day: stuntDay(now, cfg.start_at),
    by_day,
    pace,
    last_review_at: line.last_review_at,
    changes_today: line.changes_today,
    channels_today: [...new Set(line.channel_slugs.map(channelLabel))],
  };
}
