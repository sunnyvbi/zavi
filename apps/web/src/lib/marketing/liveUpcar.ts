import * as React from "react";
import { apiUrl } from "@/lib/api";

export type DayKind = "PLAN" | "CHANGE" | "WIN" | "LOSS" | "HUMAN" | "NOT_AVAILABLE" | "WORK";
export type PublicDay = {
  day: string;
  kind: DayKind;
  headline: string;
  channels: string[];
  work: string[];
  why: string | null;
  budget: { channel: string; from_usd: number | null; to_usd: number | null }[];
  spent_usd: number | null;
  bookings: number | null;
  hosts: number | null;
  published_at?: string | null;
  updated_at?: string | null;
};
export type LiveUpcar = {
  as_of: string;
  run: { slug: string; listed: boolean };
  demo_now?: string;
  clock: { start_at: string; unlock_at: string; end_at: string };
  budget_usd: number;
  budget_raise: { on: string; start_usd: number } | null;
  goals: { bookings: number | null; hosts: number | null; booking_value_usd: number | null };
  bookings_estimate_factor: number;
  locked: boolean;
  numbers: null | {
    spent_usd: number | null;
    spend_per_day_recent_usd: number | null;
    runs_out_day: number | null;
    bookings: number | null;
    hosts: number | null;
    booking_value_usd: number | null;
    pace: { bookings_per_week: number | null; hosts_per_week: number | null; booking_value_per_week: number | null };
    by_day: { day: string; bookings: number | null; hosts: number | null; spent_usd: number | null; booking_value_usd: number | null }[];
  };
  now_line: { last_review_at: string | null; changes_today: number; channels_today: string[] };
  days: PublicDay[];
};

export const LIVE_UPCAR_FALLBACK_CLOCK = {
  start_at: "2026-10-01T00:00:00-04:00",
  unlock_at: "2026-10-13T09:00:00-04:00",
  end_at: "2026-10-30T23:59:59-04:00",
};

const KINDS: DayKind[] = ["PLAN", "CHANGE", "WIN", "LOSS", "HUMAN", "NOT_AVAILABLE", "WORK"];
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const iso = (v: unknown, d: string) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : d);

export function parseLiveUpcar(j: unknown): LiveUpcar | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const clock = (o.clock ?? {}) as Record<string, unknown>;
  const goals = (o.goals ?? {}) as Record<string, unknown>;
  const nums = o.numbers as Record<string, unknown> | null | undefined;
  const line = (o.now_line ?? {}) as Record<string, unknown>;
  const pace = ((nums?.pace ?? {}) as Record<string, unknown>);
  return {
    as_of: s(o.as_of) ?? "",
    run: { slug: s(((o.run ?? {}) as Record<string, unknown>).slug) ?? "", listed: ((o.run ?? {}) as Record<string, unknown>).listed === true },
    ...(o.as_of === "demo" && typeof o.demo_now === "string" && Number.isFinite(Date.parse(o.demo_now)) ? { demo_now: o.demo_now } : {}),
    clock: {
      start_at: iso(clock.start_at, LIVE_UPCAR_FALLBACK_CLOCK.start_at),
      unlock_at: iso(clock.unlock_at, LIVE_UPCAR_FALLBACK_CLOCK.unlock_at),
      end_at: iso(clock.end_at, LIVE_UPCAR_FALLBACK_CLOCK.end_at),
    },
    budget_usd: n(o.budget_usd) ?? 25000,
    budget_raise: (() => {
      const r = (o.budget_raise ?? {}) as Record<string, unknown>;
      const on = s(r.on);
      const start_usd = n(r.start_usd);
      return on && start_usd ? { on, start_usd } : null;
    })(),
    goals: (() => {
      const value = n(goals.booking_value_usd) || null;
      return { bookings: n(goals.bookings) || (value ? null : 600), hosts: n(goals.hosts) || (value ? null : 500), booking_value_usd: value };
    })(),
    bookings_estimate_factor: n(o.bookings_estimate_factor) ?? 1,
    locked: o.locked !== false,
    numbers:
      o.locked === false && nums && typeof nums === "object"
        ? {
            spent_usd: n(nums.spent_usd),
            spend_per_day_recent_usd: n(nums.spend_per_day_recent_usd),
            runs_out_day: n(nums.runs_out_day),
            bookings: n(nums.bookings),
            hosts: n(nums.hosts),
            booking_value_usd: n(nums.booking_value_usd),
            pace: { bookings_per_week: n(pace.bookings_per_week), hosts_per_week: n(pace.hosts_per_week), booking_value_per_week: n(pace.booking_value_per_week) },
            by_day: arr(nums.by_day).map((d) => {
              const r = (d ?? {}) as Record<string, unknown>;
              return { day: s(r.day) ?? "", bookings: n(r.bookings), hosts: n(r.hosts), spent_usd: n(r.spent_usd), booking_value_usd: n(r.booking_value_usd) };
            }),
          }
        : null,
    now_line: {
      last_review_at: s(line.last_review_at),
      changes_today: n(line.changes_today) ?? 0,
      channels_today: arr(line.channels_today).map(s).filter((x): x is string => !!x),
    },
    days: arr(o.days)
      .map((d): PublicDay | null => {
        const r = (d ?? {}) as Record<string, unknown>;
        const headline = s(r.headline);
        const day = s(r.day);
        if (!headline || !day) return null;
        return {
          day,
          kind: KINDS.includes(r.kind as DayKind) ? (r.kind as DayKind) : "WORK",
          headline,
          channels: arr(r.channels).map(s).filter((x): x is string => !!x),
          work: arr(r.work).map(s).filter((x): x is string => !!x),
          why: s(r.why),
          budget: arr(r.budget).map((b) => {
            const x = (b ?? {}) as Record<string, unknown>;
            return { channel: s(x.channel) ?? "Ads", from_usd: n(x.from_usd), to_usd: n(x.to_usd) };
          }),
          spent_usd: n(r.spent_usd),
          bookings: n(r.bookings),
          hosts: n(r.hosts),
          published_at: isoOrNull(r.published_at),
          updated_at: isoOrNull(r.updated_at),
        };
      })
      .filter((x): x is PublicDay => x !== null),
  };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LIVE_FETCH_TIMEOUT_MS = 8_000;

async function fetchLiveUpcar(slug: string, previewLocked: boolean, timeoutMs: number): Promise<LiveUpcar | "not_found" | null> {
  if (!SLUG_RE.test(slug)) return "not_found";
  try {
    const res = await fetch(apiUrl(`/api/public/live/${slug}${previewLocked ? "?locked=1" : ""}`), {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return null;
    return parseLiveUpcar(await res.json());
  } catch {
    return null;
  }
}

const requestCache: <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A) => R =
  (React as unknown as { cache?: <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A) => R }).cache ?? ((fn) => fn);

const cachedLiveUpcar = requestCache(fetchLiveUpcar);

export function getLiveUpcar(slug: string, previewLocked = false, timeoutMs: number = LIVE_FETCH_TIMEOUT_MS): Promise<LiveUpcar | "not_found" | null> {
  return cachedLiveUpcar(slug, previewLocked, timeoutMs);
}

export function budgetOn(d: Pick<LiveUpcar, "budget_usd" | "budget_raise">, day: string): number {
  return d.budget_raise && day < d.budget_raise.on ? d.budget_raise.start_usd : d.budget_usd;
}

export function runEnded(clock: { end_at: string }, nowMs: number): boolean {
  return nowMs >= Date.parse(clock.end_at);
}

export async function getLivePillSlug(opts: { evenIfEnded?: boolean } = {}): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("/api/public/live"), {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { pill?: { slug?: unknown; ended?: unknown } | null };
    if (j?.pill?.ended === true && !opts.evenIfEnded) return null;
    const slug = j?.pill?.slug;
    return typeof slug === "string" && SLUG_RE.test(slug) ? slug : null;
  } catch {
    return null;
  }
}
