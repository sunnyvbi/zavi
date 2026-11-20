import type { DayOverride, LiveStuntConfig } from "./config";
import type { StuntSnapshot } from "./snapshot";
import { DAY_KINDS, type DayKind, type Entry } from "./draft";
import { measurementDays, recentPerDay, runsOutDay } from "./days";
import { findIdentifiers, scrubPlaces, tidyPublicText } from "./scrub";
import { countHeadline, distinctHeadline, isCountHeadline, isOwnerHeadline, plainHeadline } from "./headline";

export type PublicDay = Entry & { published_at: string | null; updated_at: string | null };
export type LiveUpcarPublic = {
  as_of: string;
  run: { slug: string; listed: boolean };
  clock: { start_at: string; unlock_at: string; end_at: string };
  budget_usd: number;
  budget_raise: { on: string; start_usd: number } | null;
  goals: { bookings: number | null; hosts: number | null; booking_value_usd?: number };
  bookings_estimate_factor: number;
  locked: boolean;
  numbers: null | {
    spent_usd: number;
    spend_per_day_recent_usd: number;
    runs_out_day: number | null;
    bookings: number | null;
    hosts: number | null;
    booking_value_usd: number | null;
    pace: { bookings_per_week: number | null; hosts_per_week: number | null; booking_value_per_week: number | null; window: "4w_before_start" };
    by_day: { day: string; bookings: number | null; hosts: number | null; spent_usd: number; booking_value_usd: number | null }[];
  };
  now_line: { last_review_at: string | null; changes_today: number; channels_today: string[] };
  days: PublicDay[];
};

export type StoredDay = {
  day: string;
  status: string;
  full_entry: unknown;
  neutral_entry: unknown;
  edited_headline: string | null;
  edited_why: string | null;
  edited_kind: string | null;
  published_at?: string | null;
  updated_at?: string | null;
};

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? tidyPublicText(scrubPlaces(v.trim().slice(0, max + 100))).slice(0, max) : null;
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const kindOf = (v: unknown): DayKind | null => (typeof v === "string" && (DAY_KINDS as readonly string[]).includes(v) ? (v as DayKind) : null);
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const safe = (s: string | null) => s === null || findIdentifiers(s).length === 0;
const sumOrNull = (xs: (number | null)[]) => (xs.length === 0 || xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0));

function rebuild(raw: unknown, locked: boolean, row: StoredDay, fix: DayOverride | undefined): { day: PublicDay; owner: boolean } | null {
  const e: Record<string, unknown> = { ...((raw ?? {}) as Record<string, unknown>), ...(fix ?? {}) };
  let kind = kindOf(e.kind) ?? "WORK";
  let headline = plainHeadline(text(e.headline, 200) ?? "") || null;
  let why = text(e.why, 600);
  const owner = !locked && isOwnerHeadline(row.edited_headline, typeof e.headline === "string" ? e.headline : null);
  if (!locked) {
    if (owner) headline = text(row.edited_headline, 200) ?? headline;
    why = text(row.edited_why, 600) ?? why;
    kind = kindOf(row.edited_kind) ?? kind;
  } else if (kind === "WIN" || kind === "LOSS") {
    kind = "WORK";
  }
  if (!headline) return null;
  const channels = (Array.isArray(e.channels) ? e.channels : []).map((c) => str(c, 40)).filter((c): c is string => !!c).slice(0, 8);
  const work = (Array.isArray(e.work) ? e.work : []).map((w) => text(w, 400)).filter((w): w is string => !!w).slice(0, 6);
  const budget = (Array.isArray(e.budget) ? e.budget : []).slice(0, 8).map((b) => {
    const r = (b ?? {}) as Record<string, unknown>;
    return { channel: str(r.channel, 40) ?? "Ads", from_usd: locked ? null : numOrNull(r.from_usd), to_usd: locked ? null : numOrNull(r.to_usd) };
  });
  const day: PublicDay = {
    day: row.day, kind, headline, channels, work, why: locked ? null : why, budget,
    spent_usd: locked ? null : numOrNull(e.spent_usd),
    bookings: locked ? null : numOrNull(e.bookings),
    hosts: locked ? null : numOrNull(e.hosts),
    published_at: isoOrNull(row.published_at),
    updated_at: isoOrNull(row.updated_at),
  };
  const strings = [day.headline, day.why, ...day.channels, ...day.work, ...day.budget.map((b) => b.channel)];
  return strings.every(safe) ? { day, owner } : null;
}

export function toPublicPayload(a: { snapshot: StuntSnapshot | null; days: StoredDay[]; cfg: LiveStuntConfig; now: Date }): LiveUpcarPublic {
  const { cfg, snapshot, now } = a;
  const locked = now.getTime() < Date.parse(cfg.unlock_at);
  const fixes = cfg.overrides ?? {};
  const k = cfg.bookings_estimate_factor;
  const est = (x: number | null | undefined) => (x == null ? null : Math.round(x * k));
  const snapDays = new Map((snapshot?.by_day ?? []).map((d) => [d.day, d]));
  const runDays = new Set(measurementDays({ start_at: cfg.start_at, end_at: cfg.end_at, now }).map((d) => d.day));
  const dayList = [...new Set([...snapDays.keys(), ...Object.keys(fixes).filter((d) => runDays.has(d))])].sort();
  const by_day = dayList.map((day) => {
    const d = snapDays.get(day) ?? { bookings: null, hosts: null, spent_usd: 0, booking_value_usd: null };
    const f = fixes[day] ?? {};
    return {
      day, bookings: f.bookings ?? est(d.bookings), hosts: f.hosts ?? d.hosts, spent_usd: f.spent_usd ?? d.spent_usd,
      booking_value_usd: f.booking_value_usd ?? est(d.booking_value_usd),
    };
  });
  const spent = Math.round(by_day.reduce((s, d) => s + d.spent_usd, 0) * 100) / 100;
  const perDay = recentPerDay(by_day);
  const numbers: LiveUpcarPublic["numbers"] =
    locked || !snapshot
      ? null
      : {
          spent_usd: spent,
          spend_per_day_recent_usd: perDay,
          runs_out_day: runsOutDay({ day: snapshot.day, left: Math.max(0, cfg.budget_usd - spent), perDay }),
          bookings: sumOrNull(by_day.map((d) => d.bookings)),
          hosts: sumOrNull(by_day.map((d) => d.hosts)),
          booking_value_usd: sumOrNull(by_day.map((d) => d.booking_value_usd)),
          pace: {
            bookings_per_week: est(snapshot.pace.bookings_per_week),
            hosts_per_week: snapshot.pace.hosts_per_week,
            booking_value_per_week: est(snapshot.pace.booking_value_per_week),
            window: "4w_before_start",
          },
          by_day,
        };
  const built = a.days
    .filter((d) => d.status === "published")
    .sort((x, y) => (x.day < y.day ? 1 : -1))
    .map((d) => rebuild(locked ? d.neutral_entry : d.full_entry, locked, d, fixes[d.day]))
    .filter((d): d is { day: PublicDay; owner: boolean } => d !== null);
  const rows = new Map(by_day.map((r) => [r.day, r]));
  const shown: string[] = [];
  for (let i = built.length - 1; i >= 0; i--) {
    const { day, owner } = built[i];
    const r = numbers ? rows.get(day.day) : undefined;
    const facts = { ...day, spent_usd: r ? r.spent_usd : day.spent_usd, bookings: r ? r.bookings : day.bookings };
    if (!owner && isCountHeadline(day.headline)) day.headline = countHeadline(facts) || day.headline;
    if (!owner) day.headline = distinctHeadline(day.headline, shown, facts);
    shown.push(day.headline);
  }
  const days = built.map((b) => b.day);
  return {
    as_of: snapshot?.taken_at ?? now.toISOString(),
    run: { slug: cfg.slug, listed: cfg.home_pill },
    clock: { start_at: cfg.start_at, unlock_at: cfg.unlock_at, end_at: cfg.end_at },
    budget_usd: cfg.budget_usd,
    budget_raise: cfg.budget_raise ?? null,
    goals: { ...cfg.goals },
    bookings_estimate_factor: k,
    locked,
    numbers,
    now_line: {
      last_review_at: snapshot?.last_review_at ?? null,
      changes_today: snapshot?.changes_today ?? 0,
      channels_today: (snapshot?.channels_today ?? []).filter((c) => safe(c)),
    },
    days,
  };
}
