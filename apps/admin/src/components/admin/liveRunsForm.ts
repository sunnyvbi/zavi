
export type LiveRunRow = {
  slug: string;
  tenant_id: string;
  start: string;
  unlock: string;
  end: string;
  budget_usd: string;
  raise_start_usd: string;
  raise_on: string;
  goal_bookings: string;
  goal_hosts: string;
  goal_value_usd: string;
  public: boolean;
  home_pill: boolean;
  bookings_factor: string;
  fixes: FixRow[];
  extra: Record<string, unknown>;
};

export type FixRow = { day: string; bookings: string; hosts: string; spent_usd: string; booking_value_usd: string };
const FIX_FIELDS = ["bookings", "hosts", "spent_usd", "booking_value_usd"] as const;

export const UPCAR_AI_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ET = "America/New_York";

function etOffset(atUtcMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(atUtcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const mins = Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - atUtcMs) / 60000);
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function etLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const naive = Date.parse(`${local}:00Z`);
  const off = etOffset(naive + 5 * 3600000);
  const iso = `${local}:00${off}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function isoToEtLocal(iso: unknown): string {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

export function rowsFromBlob(blob: Record<string, unknown>): LiveRunRow[] {
  const map = blob?.live_runs;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, Record<string, unknown>>).map(([slug, r]) => {
    const g = (r?.goals ?? {}) as Record<string, unknown>;
    const raise = (r?.budget_raise ?? {}) as Record<string, unknown>;
    const unlock = r?.unlock_at && r.unlock_at !== r.start_at ? isoToEtLocal(r.unlock_at) : "";
    return {
      slug,
      tenant_id: String(r?.tenant_id ?? ""),
      start: isoToEtLocal(r?.start_at),
      unlock,
      end: isoToEtLocal(r?.end_at),
      budget_usd: r?.budget_usd == null ? "" : String(r.budget_usd),
      raise_start_usd: raise.start_usd == null ? "" : String(raise.start_usd),
      raise_on: typeof raise.on === "string" ? raise.on : "",
      goal_bookings: g.bookings == null ? "" : String(g.bookings),
      goal_hosts: g.hosts == null ? "" : String(g.hosts),
      goal_value_usd: g.booking_value_usd == null ? "" : String(g.booking_value_usd),
      public: r?.public === true,
      home_pill: r?.home_pill === true,
      bookings_factor: r?.bookings_estimate_factor == null || r.bookings_estimate_factor === 1 ? "" : String(r.bookings_estimate_factor),
      fixes: Object.entries((r?.overrides ?? {}) as Record<string, Record<string, unknown>>)
        .map(([day, o]) => ({
          day,
          bookings: o?.bookings == null ? "" : String(o.bookings),
          hosts: o?.hosts == null ? "" : String(o.hosts),
          spent_usd: o?.spent_usd == null ? "" : String(o.spent_usd),
          booking_value_usd: o?.booking_value_usd == null ? "" : String(o.booking_value_usd),
        }))
        .sort((a, b) => (a.day < b.day ? -1 : 1)),
      extra: r ?? {},
    };
  });
}

export function blobFromRows(rows: LiveRunRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const start_at = etLocalToIso(r.start);
    const overrides: Record<string, Record<string, number>> = {};
    for (const f of r.fixes) {
      const o: Record<string, number> = {};
      for (const k of FIX_FIELDS) if (f[k].trim() !== "") o[k] = Number(f[k]);
      if (f.day && Object.keys(o).length) overrides[f.day] = { ...overrides[f.day], ...o };
    }
    const { overrides: _old, bookings_estimate_factor: _oldFactor, budget_raise: _oldRaise, ...kept } = r.extra;
    const factor = r.bookings_factor.trim() === "" ? 1 : Number(r.bookings_factor);
    out[r.slug.trim()] = {
      ...kept,
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(factor !== 1 ? { bookings_estimate_factor: factor } : {}),
      tenant_id: r.tenant_id.trim(),
      start_at,
      unlock_at: r.unlock ? etLocalToIso(r.unlock) : start_at,
      end_at: etLocalToIso(r.end),
      budget_usd: Number(r.budget_usd),
      ...(r.raise_start_usd.trim() !== "" || r.raise_on !== "" ? { budget_raise: { on: r.raise_on, start_usd: Number(r.raise_start_usd) } } : {}),
      goals: {
        ...(r.goal_bookings.trim() !== "" ? { bookings: Number(r.goal_bookings) } : {}),
        ...(r.goal_hosts.trim() !== "" ? { hosts: Number(r.goal_hosts) } : {}),
        ...(r.goal_value_usd.trim() !== "" ? { booking_value_usd: Number(r.goal_value_usd) } : {}),
      },
      public: r.public,
      home_pill: r.home_pill,
    };
  }
  return out;
}

export function newRow(slug: string): LiveRunRow {
  return { slug, tenant_id: UPCAR_AI_TENANT, start: "", unlock: "", end: "", budget_usd: "", raise_start_usd: "", raise_on: "", goal_bookings: "", goal_hosts: "", goal_value_usd: "", public: false, home_pill: false, bookings_factor: "", fixes: [], extra: {} };
}
