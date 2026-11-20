
export type MeetingScheduleConfig = {
  days_of_week: number[];
  join_time: string;
  timezone: string;
};

export type DueResult =
  | { due: false }
  | { due: true; local_date: string; join_at_iso: string; target_iso: string };

export const JOIN_LEAD_MIN = 5;
export const JOIN_WINDOW_MIN = 10;

export function computeDueJoin(
  cfg: MeetingScheduleConfig,
  now: Date,
  windowMin = JOIN_WINDOW_MIN,
): DueResult {
  const occurrences = occurrencesAround(cfg, now);
  if (!occurrences) return { due: false };
  const nowMs = now.getTime();
  for (const o of occurrences) {
    const sinceMs = nowMs - o.target_ms;
    if (sinceMs < -JOIN_LEAD_MIN * 60_000 || sinceMs >= windowMin * 60_000) continue;
    const joinAt = o.target_ms - nowMs >= 60_000 ? o.target_ms : nowMs + 60_000;
    return {
      due: true,
      local_date: o.local_date,
      join_at_iso: new Date(joinAt).toISOString(),
      target_iso: new Date(o.target_ms).toISOString(),
    };
  }
  return { due: false };
}

export function nextOpenMeetingDate(cfg: MeetingScheduleConfig, now: Date, windowMin = JOIN_WINDOW_MIN): string | null {
  const occurrences = occurrencesAround(cfg, now);
  if (!occurrences) return null;
  for (const o of occurrences) {
    if (now.getTime() - o.target_ms < windowMin * 60_000) return o.local_date;
  }
  return null;
}

type Occurrence = { local_date: string; target_ms: number };

function occurrencesAround(cfg: MeetingScheduleConfig, now: Date): Occurrence[] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(cfg.join_time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  let parts: Parts;
  try {
    parts = localParts(now, cfg.timezone);
  } catch {
    return null;
  }
  const out: Occurrence[] = [];
  for (const dayOffset of [-1, 0, 1]) {
    if (!cfg.days_of_week.includes((parts.weekday + dayOffset + 7) % 7)) continue;
    const day = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d + dayOffset));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const target = zonedInstant(y, mo, d, h, mi, cfg.timezone);
    if (target === null) continue;
    out.push({ local_date: `${y}-${pad(mo)}-${pad(d)}`, target_ms: target });
  }
  return out;
}

function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number | null {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const p = localParts(new Date(t), timeZone);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  const p = localParts(new Date(t), timeZone);
  if (p.y !== y || p.mo !== mo || p.d !== d || p.h !== h || p.mi !== mi) return null;
  return t;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

type Parts = { weekday: number; y: number; mo: number; d: number; h: number; mi: number };

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function localParts(now: Date, timeZone: string): Parts {
  let fmt = FORMATTERS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    weekday: WEEKDAYS[parts.weekday] ?? -1,
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute),
  };
}
