import { PINTEREST_CHANNEL, PINTEREST_METER_KEY, PINTEREST_READS_PER_DAY, refreshPinterest } from "@/services/pinterest-social/snapshots";
import { utcDay } from "@/services/x-social/read-cap";
import { PIN_WINDOWS, type DailyRow, type PinFormat, type PinRow } from "@/services/pinterest-social/detail";
import type { DashboardBuilder, DashboardContext } from "./_contract";

type SnapshotMetrics = {
  account_totals?: Record<string, number> | null;
  account_error?: string | null;
  window?: { start_date?: string; end_date?: string } | null;
  daily?: DailyRow[] | null;
  pins?: Record<string, PinRow[]> | null;
  pins_error?: string | null;
};

type Totals = { views: number; engagements: number; clicks: number; saves: number };

export type PinterestWindow = Omit<Totals, "engagements"> & {
  engagements: number | null;
  days: number;
  new_followers: number | null;
  prev: (Totals & { new_followers: number | null }) | null;
  formats: Array<{ format: PinFormat; impressions: number; engagements: number }>;
  top: PinRow[];
  pins_failed: boolean;
};

export type PinterestAnalytics = { as_of: string | null; windows: Record<string, PinterestWindow | null> };

type AccountRow = {
  captured_on: string;
  username: string | null;
  followers_count: number | null;
  post_count: number | null;
  metrics: SnapshotMetrics | null;
};

const numberAt = (row: AccountRow | null, key: string): number | null => {
  const value = row?.metrics?.account_totals?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export function shapePinterest(rows: AccountRow[]) {
  const latest = rows.at(-1) ?? null;
  const previous = rows.length > 1 ? rows.at(-2) ?? null : null;
  if (!latest) return { account: null, metrics: [], last_day: null, problem: null };
  const metric = (key: string, value: number | null, prev: number | null, unit: string | null = "count") =>
    value === null ? [] : [{
      key,
      value,
      unit,
      window_kind: key === "followers" ? null : "30d",
      day: latest.captured_on,
      grounded: true,
      prev_value: prev,
      prev_day: prev === null ? null : previous?.captured_on ?? null,
    }];
  return {
    account: { username: latest.username, followers: latest.followers_count },
    metrics: [
      ...metric("followers", latest.followers_count, previous?.followers_count ?? null),
      ...metric("impressions", numberAt(latest, "IMPRESSION"), numberAt(previous, "IMPRESSION")),
      ...metric("outbound_clicks", numberAt(latest, "OUTBOUND_CLICK"), numberAt(previous, "OUTBOUND_CLICK")),
      ...metric("saves", numberAt(latest, "SAVE"), numberAt(previous, "SAVE")),
    ],
    last_day: latest.captured_on,
    problem: latest.metrics?.account_error
      ? "Pinterest connected, but it did not return account analytics. A Pinterest business account may be required."
      : null,
  };
}

const DAY = 86_400_000;
const TOP_SHOWN = 5;

const dayMs = (ymd: string) => Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);

function sum(rows: DailyRow[]): Totals {
  return rows.reduce<Totals>(
    (t, r) => ({ views: t.views + r.impressions, engagements: t.engagements + r.engagements, clicks: t.clicks + r.clicks, saves: t.saves + r.saves }),
    { views: 0, engagements: 0, clicks: 0, saves: 0 },
  );
}

function followersAt(rows: AccountRow[], cutoff: number, days: number): number | null {
  const slack = Math.max(2, Math.round(days / 10)) * DAY;
  const hit = rows.filter((r) => dayMs(r.captured_on) <= cutoff && typeof r.followers_count === "number").at(-1);
  return hit && dayMs(hit.captured_on) >= cutoff - slack ? hit.followers_count : null;
}

function gain(later: number | null, earlier: number | null): number | null {
  return later === null || earlier === null ? null : later - earlier;
}

const rate = (p: PinRow) => (p.impressions > 0 ? p.engagements / p.impressions : 0);

export function topPins(pins: PinRow[]): PinRow[] {
  return [...pins].sort((a, b) => b.impressions - a.impressions).slice(0, TOP_SHOWN).sort((a, b) => rate(b) - rate(a));
}

export function formatSplit(pins: PinRow[]): PinterestWindow["formats"] {
  const by = new Map<PinFormat, { impressions: number; engagements: number }>();
  for (const p of pins) {
    if (!p.format || p.impressions <= 0) continue;
    const t = by.get(p.format) ?? { impressions: 0, engagements: 0 };
    by.set(p.format, { impressions: t.impressions + p.impressions, engagements: t.engagements + p.engagements });
  }
  return [...by.entries()].map(([format, t]) => ({ format, ...t })).sort((a, b) => b.engagements / b.impressions - a.engagements / a.impressions);
}

function customWindow(rows: AccountRow[], daily: DailyRow[] | null, range: { since: string; until: string }): PinterestWindow | null {
  if (!daily || daily.length === 0) return null;
  const from = dayMs(range.since);
  const to = dayMs(range.until);
  if (dayMs(daily[0].date) > from) return null;
  const days = Math.round((to - from) / DAY) + 1;
  const current = daily.filter((r) => dayMs(r.date) >= from && dayMs(r.date) <= to);
  if (current.length === 0) return null;
  const before = daily.filter((r) => dayMs(r.date) < from && dayMs(r.date) >= from - days * DAY);
  const covered = dayMs(daily[0].date) <= from - days * DAY;
  const end = followersAt(rows, to, days);
  const start = followersAt(rows, from - DAY, days);
  return {
    days,
    ...sum(current),
    new_followers: gain(end, start),
    prev: covered ? { ...sum(before), new_followers: gain(start, followersAt(rows, from - (days + 1) * DAY, days)) } : null,
    formats: [],
    top: [],
    pins_failed: false,
  };
}

export function shapePinterestAnalytics(rows: AccountRow[], custom?: { since: string; until: string } | null): PinterestAnalytics {
  const latest = rows.at(-1) ?? null;
  const daily = Array.isArray(latest?.metrics?.daily) ? latest!.metrics!.daily! : null;
  const pins = latest?.metrics?.pins ?? null;
  const windows: Record<string, PinterestWindow | null> = {};
  if (custom) windows.custom = customWindow(rows, daily, custom);
  for (const days of PIN_WINDOWS) {
    const top = pins?.[String(days)] ?? [];
    const pins_failed = !!latest?.metrics?.pins_error && !pins?.[String(days)];
    const today = latest ? dayMs(latest.captured_on) : 0;
    const followersNow = latest?.followers_count ?? null;
    const baseOne = followersAt(rows, today - days * DAY, days);
    const baseTwo = followersAt(rows, today - 2 * days * DAY, days);
    if (!latest || !daily || daily.length === 0) {
      const totals = days === 30 ? latest?.metrics?.account_totals ?? null : null;
      windows[String(days)] = totals
        ? {
            days,
            views: totals.IMPRESSION ?? 0,
            engagements: totals.ENGAGEMENT ?? null,
            clicks: totals.OUTBOUND_CLICK ?? 0,
            saves: totals.SAVE ?? 0,
            new_followers: gain(followersNow, baseOne),
            prev: null,
            formats: formatSplit(top),
            top: topPins(top),
            pins_failed,
          }
        : null;
      continue;
    }
    const end = dayMs(daily.at(-1)!.date);
    const current = daily.filter((r) => dayMs(r.date) > end - days * DAY);
    const before = daily.filter((r) => dayMs(r.date) <= end - days * DAY && dayMs(r.date) > end - 2 * days * DAY);
    const covered = dayMs(daily[0].date) <= end - (2 * days - 1) * DAY;
    windows[String(days)] = {
      days,
      ...sum(current),
      new_followers: gain(followersNow, baseOne),
      prev: covered ? { ...sum(before), new_followers: gain(baseOne, baseTwo) } : null,
      formats: formatSplit(top),
      top: topPins(top),
      pins_failed,
    };
  }
  return { as_of: latest?.captured_on ?? null, windows };
}

async function readRows(c: DashboardContext): Promise<AccountRow[]> {
  const since = new Date(Date.now() - 61 * 86_400_000).toISOString().slice(0, 10);
  const [history, recent] = await Promise.all([
    c.sb
      .from("social_account_snapshots")
      .select("captured_on, username, followers_count, post_count")
      .eq("tenant_id", c.tenantId)
      .eq("channel", PINTEREST_CHANNEL)
      .gte("captured_on", since)
      .order("captured_on", { ascending: true }),
    c.sb
      .from("social_account_snapshots")
      .select("captured_on, metrics")
      .eq("tenant_id", c.tenantId)
      .eq("channel", PINTEREST_CHANNEL)
      .gte("captured_on", since)
      .order("captured_on", { ascending: false })
      .limit(2),
  ]);
  if (history.error) throw new Error(history.error.message);
  if (recent.error) throw new Error(recent.error.message);
  const metrics = new Map(((recent.data ?? []) as Array<{ captured_on: string; metrics: SnapshotMetrics | null }>).map((r) => [r.captured_on, r.metrics]));
  return ((history.data ?? []) as Array<Omit<AccountRow, "metrics">>).map((r) => ({ ...r, metrics: metrics.get(r.captured_on) ?? null }));
}

export const build: DashboardBuilder = async (c) => {
  let connected = false;
  try {
    const { data } = await c.sb
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", c.tenantId)
      .eq("slug", "composio.pinterest");
    connected = (data ?? []).length > 0;
  } catch {
    connected = false;
  }

  let rows: AccountRow[] = [];
  let storedOk = true;
  let problem: string | null = null;
  try {
    rows = await readRows(c);
  } catch {
    storedOk = false;
    problem = "Zavi could not load your stored Pinterest numbers just now. Try again in a minute.";
  }
  const readToday = rows.some((row) => row.captured_on === utcDay());
  if (connected && storedOk && (c.meteredRefresh || !readToday)) {
    const refreshed = await refreshPinterest(c.tenantId);
    if (refreshed.ok) {
      try {
        rows = await readRows(c);
      } catch {
        problem = "Zavi could not load your stored Pinterest numbers just now. Try again in a minute.";
      }
    } else if (c.meteredRefresh || refreshed.reason !== "cap_reached") {
      problem = refreshed.message;
    }
  }

  let used = PINTEREST_READS_PER_DAY;
  try {
    const { data, error } = await c.sb
      .from("tenant_metered_read_counters")
      .select("reads")
      .eq("tenant_id", c.tenantId)
      .eq("day", utcDay())
      .eq("key", PINTEREST_METER_KEY)
      .maybeSingle();
    if (!error) used = Number((data as { reads?: number } | null)?.reads ?? 0);
  } catch {
    used = PINTEREST_READS_PER_DAY;
  }

  const shaped = shapePinterest(rows);
  return {
    connected,
    ...shaped,
    analytics: shapePinterestAnalytics(rows, c.customRange ?? null),
    problem: problem ?? shaped.problem,
    refresh: { used, cap: PINTEREST_READS_PER_DAY, remaining: Math.max(0, PINTEREST_READS_PER_DAY - used) },
  };
};
