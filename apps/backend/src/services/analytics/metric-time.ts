
export type LocalDate = string;

export type Grain = "day" | "week" | "month";

export const WINDOW_PRESETS = [
  "yesterday",
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "last_90d",
  "last_week",
  "last_month",
  "month_to_date",
  "year_to_date",
] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];

export type WindowInput = {
  preset?: WindowPreset;
  since?: LocalDate;
  until?: LocalDate;
  include_today?: boolean;
};

export type ResolvedWindow = {
  since: LocalDate;
  until: LocalDate;
  tz: string;
  notes: string[];
};

export const MAX_WINDOW_DAYS = 400;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function localDateOf(d: Date, tz: string): LocalDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function tzOffsetMinutes(atUtc: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(atUtc);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return (asUtc - atUtc.getTime()) / 60000;
}

export function localDayStartUtc(date: LocalDate, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d);
  const guess = naive - tzOffsetMinutes(new Date(naive), tz) * 60000;
  return new Date(naive - tzOffsetMinutes(new Date(guess), tz) * 60000);
}

export function windowUtcRange(w: { since: LocalDate; until: LocalDate; tz: string }): {
  since: Date;
  until: Date;
} {
  return { since: localDayStartUtc(w.since, w.tz), until: localDayStartUtc(addDays(w.until, 1), w.tz) };
}

function toUtc(date: LocalDate): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function fromUtc(d: Date): LocalDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, n: number): LocalDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

export function daysBetween(since: LocalDate, until: LocalDate): number {
  return Math.round((toUtc(until).getTime() - toUtc(since).getTime()) / 86_400_000) + 1;
}

export function startOfWeek(date: LocalDate): LocalDate {
  const d = toUtc(date);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return addDays(date, -sinceMonday);
}

export function startOfMonth(date: LocalDate): LocalDate {
  return `${date.slice(0, 8)}01`;
}

export function endOfMonth(date: LocalDate): LocalDate {
  const [y, m] = date.split("-").map(Number);
  return fromUtc(new Date(Date.UTC(y, m, 0, 12)));
}

function addMonths(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return fromUtc(target);
}

export function bucketStart(date: LocalDate, grain: Grain): LocalDate {
  if (grain === "day") return date;
  if (grain === "week") return startOfWeek(date);
  return startOfMonth(date);
}

export function bucketEnd(start: LocalDate, grain: Grain): LocalDate {
  if (grain === "day") return start;
  if (grain === "week") return addDays(start, 6);
  return endOfMonth(start);
}

export function bucketsFor(
  w: { since: LocalDate; until: LocalDate },
  grain: Grain,
): Array<{ start: LocalDate; end: LocalDate; partial: boolean }> {
  const out: Array<{ start: LocalDate; end: LocalDate; partial: boolean }> = [];
  let start = bucketStart(w.since, grain);
  for (let i = 0; i < 1000 && start <= w.until; i++) {
    const end = bucketEnd(start, grain);
    out.push({ start, end, partial: start < w.since || end > w.until });
    start = addDays(end, 1);
  }
  return out;
}

export function resolveWindow(input: WindowInput | undefined, tz: string, now: Date): ResolvedWindow {
  const w = input ?? {};
  const today = localDateOf(now, tz);
  const yesterday = addDays(today, -1);
  const lastFull = w.include_today ? today : yesterday;
  const notes: string[] = [];

  let since: LocalDate;
  let until: LocalDate;

  if (w.since || w.until) {
    if (w.preset) throw new WindowError("Pass either a preset or since/until, not both.");
    if (!w.since || !w.until) throw new WindowError("since and until must both be set (YYYY-MM-DD).");
    if (!DATE_RE.test(w.since) || !DATE_RE.test(w.until)) {
      throw new WindowError("since and until must be YYYY-MM-DD dates.");
    }
    since = w.since;
    until = w.until;
    if (until > lastFull) {
      notes.push(
        w.include_today
          ? `until moved from ${until} to ${lastFull}: a future day has no data.`
          : `until moved from ${until} to ${lastFull}: today is a partial day and is excluded unless include_today is set.`,
      );
      until = lastFull;
    }
  } else {
    const preset = w.preset ?? "last_28d";
    const n = /^last_(\d+)d$/.exec(preset);
    if (n) {
      until = lastFull;
      since = addDays(until, -(Number(n[1]) - 1));
    } else if (preset === "yesterday") {
      since = until = yesterday;
    } else if (preset === "last_week") {
      until = addDays(startOfWeek(today), -1);
      since = addDays(until, -6);
    } else if (preset === "last_month") {
      until = addDays(startOfMonth(today), -1);
      since = startOfMonth(until);
    } else if (preset === "month_to_date") {
      since = startOfMonth(today);
      until = lastFull;
    } else {
      since = `${today.slice(0, 4)}-01-01`;
      until = lastFull;
    }
  }

  if (since > until) {
    throw new WindowError(
      `The window ${since}..${until} has no complete day yet. Set include_today, or pick an earlier window.`,
    );
  }
  if (daysBetween(since, until) > MAX_WINDOW_DAYS) {
    throw new WindowError(`Window is longer than ${MAX_WINDOW_DAYS} days. Pick a shorter one.`);
  }
  return { since, until, tz, notes };
}

export type CompareMode = "previous_period" | "previous_year";

export function compareWindow(w: ResolvedWindow, mode: CompareMode): ResolvedWindow {
  if (mode === "previous_year") {
    return { since: addMonths(w.since, -12), until: addMonths(w.until, -12), tz: w.tz, notes: [] };
  }
  const wholeMonths = w.since === startOfMonth(w.since) && w.until === endOfMonth(w.until);
  if (wholeMonths) {
    const months =
      (Number(w.until.slice(0, 4)) - Number(w.since.slice(0, 4))) * 12 +
      (Number(w.until.slice(5, 7)) - Number(w.since.slice(5, 7))) +
      1;
    const since = addMonths(w.since, -months);
    return { since, until: addDays(w.since, -1), tz: w.tz, notes: [] };
  }
  const len = daysBetween(w.since, w.until);
  const until = addDays(w.since, -1);
  return { since: addDays(until, -(len - 1)), until, tz: w.tz, notes: [] };
}

export function compactToLocalDate(s: string): LocalDate | null {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}
