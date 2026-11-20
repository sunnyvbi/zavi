import { globalClient } from "@/services/tenant-client";

export type LiveStuntConfig = {
  slug: string;
  tenant_id: string;
  start_at: string;
  unlock_at: string;
  end_at: string;
  budget_usd: number;
  budget_raise?: BudgetRaise | null;
  goals: { bookings: number | null; hosts: number | null; booking_value_usd?: number };
  host_match: Record<string, string | number | boolean>;
  review_ttl_hours: number;
  public: boolean;
  home_pill: boolean;
  overrides?: Record<string, DayOverride>;
  bookings_estimate_factor: number;
};

export type BudgetRaise = { on: string; start_usd: number };
export type DayOverride = { bookings?: number; hosts?: number; spent_usd?: number; booking_value_usd?: number };

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_HOST_MATCH = { hostStatus: true };
const factor = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 3 ? v : 1);
const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

export function parseLiveRun(slug: string, raw: unknown): LiveStuntConfig | null {
  if (!SLUG_RE.test(slug) || !raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tenant_id !== "string" || !UUID.test(r.tenant_id.trim())) return null;
  const start_at = isoOrNull(r.start_at);
  const end_at = isoOrNull(r.end_at);
  const unlock_at = isoOrNull(r.unlock_at) ?? start_at;
  const budget_usd = posNum(r.budget_usd);
  const budget_raise = parseBudgetRaise(r.budget_raise);
  const g = (r.goals && typeof r.goals === "object" ? r.goals : {}) as Record<string, unknown>;
  const bookings = posNum(g.bookings);
  const hosts = posNum(g.hosts);
  const booking_value_usd = posNum(g.booking_value_usd);
  if (!start_at || !end_at || !unlock_at || budget_usd === null) return null;
  if (booking_value_usd === null && (bookings === null || hosts === null)) return null;
  if (!(Date.parse(start_at) <= Date.parse(unlock_at) && Date.parse(unlock_at) <= Date.parse(end_at))) return null;
  if (Date.parse(start_at) % 3_600_000 !== 0) return null;
  if (Date.parse(end_at) - Date.parse(start_at) > 62 * 86400000) return null;
  return {
    slug,
    tenant_id: r.tenant_id.trim(),
    start_at,
    unlock_at,
    end_at,
    budget_usd,
    budget_raise: budget_raise === "bad" ? null : budget_raise,
    goals: { bookings, hosts, ...(booking_value_usd !== null ? { booking_value_usd } : {}) },
    host_match: safeMatch(r.host_match) ?? DEFAULT_HOST_MATCH,
    review_ttl_hours: Math.min(168, posNum(r.review_ttl_hours) ?? 72),
    public: r.public === true,
    home_pill: r.home_pill === true,
    overrides: parseOverrides(r.overrides) ?? {},
    bookings_estimate_factor: factor(r.bookings_estimate_factor),
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (day: string) => {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
};
const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;
const dollars = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000_000;

export function parseBudgetRaise(v: unknown): BudgetRaise | null | "bad" {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "bad";
  const r = v as Record<string, unknown>;
  const start_usd = posNum(r.start_usd);
  if (typeof r.on !== "string" || !DAY_RE.test(r.on) || !realDay(r.on) || start_usd === null) return "bad";
  return { on: r.on, start_usd };
}

export function parseOverrides(v: unknown): Record<string, DayOverride> | null {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, DayOverride> = {};
  for (const [day, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!DAY_RE.test(day) || !realDay(day) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const o: DayOverride = {};
    for (const [k, val] of Object.entries(r)) {
      if (val == null) continue;
      if ((k === "bookings" || k === "hosts") && count(val)) o[k] = val as number;
      else if (k === "spent_usd" && dollars(val)) o.spent_usd = Math.round((val as number) * 100) / 100;
      else if (k === "booking_value_usd" && dollars(val)) o.booking_value_usd = Math.round(val as number);
      else return null;
    }
    if (Object.keys(o).length) out[day] = o;
  }
  return out;
}

export function parseLiveRuns(blob: Record<string, unknown>): LiveStuntConfig[] {
  const map = blob?.live_runs;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>)
    .map(([slug, raw]) => parseLiveRun(slug, raw))
    .filter((c): c is LiveStuntConfig => c !== null);
}

export function safeMatch(v: unknown): Record<string, string | number | boolean> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return null;
    if (!["string", "number", "boolean"].includes(typeof val)) return null;
    out[k] = val as string | number | boolean;
  }
  return Object.keys(out).length ? out : null;
}

export async function readLiveRuns(): Promise<LiveStuntConfig[]> {
  try {
    const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
    if (error) return [];
    return parseLiveRuns(((data as { blob?: unknown } | null)?.blob ?? {}) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export async function readLiveRun(slug: string): Promise<LiveStuntConfig | null> {
  if (!SLUG_RE.test(slug)) return null;
  return (await readLiveRuns()).find((r) => r.slug === slug) ?? null;
}

export function liveRunStartMoveRejection(
  patch: unknown,
  current: Pick<LiveStuntConfig, "slug" | "start_at" | "public" | "home_pill">[],
  now: Date,
): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  for (const run of current) {
    if (Date.parse(run.start_at) > now.getTime()) continue;
    const next = (patch as Record<string, unknown>)[run.slug];
    if (next === undefined && run.public && run.home_pill)
      return `Run "${run.slug}" has started and is the featured public run, so it cannot be removed: its day pages are indexed. Turn off its home pill first.`;
    if (!next || typeof next !== "object") continue;
    const start = (next as Record<string, unknown>).start_at;
    if (typeof start === "string" && Date.parse(start) !== Date.parse(run.start_at))
      return `Run "${run.slug}" has started, so its start_at stays ${run.start_at}: its public day pages are numbered from it.`;
  }
  return null;
}

export function liveRunsRejection(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "live_runs must be an object keyed by page slug, e.g. { \"upcar-test\": {...} }.";
  const pills: string[] = [];
  for (const [slug, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!SLUG_RE.test(slug)) return `"${slug}" is not a valid page slug (lowercase letters, digits and dashes).`;
    const run = parseLiveRun(slug, raw);
    if (raw && typeof raw === "object" && parseOverrides((raw as Record<string, unknown>).overrides) === null)
      return `Run "${slug}" has a bad number correction: days are YYYY-MM-DD, bookings and hosts are whole numbers, spend is dollars, none negative.`;
    if (raw && typeof raw === "object" && parseBudgetRaise((raw as Record<string, unknown>).budget_raise) === "bad")
      return `Run "${slug}" has a bad budget raise: it needs the budget at the start in dollars and the date it was raised, YYYY-MM-DD.`;
    const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>).bookings_estimate_factor : undefined;
    if (f !== undefined && !(typeof f === "number" && f >= 1 && f <= 3)) return `Run "${slug}" has a bad bookings multiplier: a number from 1 to 3.`;
    if (!run) return `Run "${slug}" needs tenant_id, start_at (on the hour, e.g. 09:00), end_at, budget_usd and goals ({bookings, hosts}, or {booking_value_usd}), with start <= unlock <= end and at most 62 days.`;
    if (run.home_pill) pills.push(slug);
  }
  if (pills.length > 1) return `Only one run can have the home pill; ${pills.join(" and ")} both do.`;
  return null;
}
