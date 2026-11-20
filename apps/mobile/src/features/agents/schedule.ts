
export type Schedule = {
  cron_expression: string;
  enabled: boolean;
  last_fired_at: string | null;
  timezone: string | null;
};

type ParsedCron = {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
};

function expandField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let step = 1;
    let range = part;
    const slash = part.split("/");
    if (slash.length === 2) {
      range = slash[0];
      step = Number(slash[1]);
      if (!Number.isInteger(step) || step < 1) return null;
    } else if (slash.length !== 1) {
      return null;
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = expandField(parts[0], 0, 59);
  const hours = expandField(parts[1], 0, 23);
  const daysOfMonth = expandField(parts[2], 1, 31);
  const months = expandField(parts[3], 1, 12);
  const dowRaw = expandField(parts[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !dowRaw) return null;
  const daysOfWeek = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2].trim() !== "*",
    dowRestricted: parts[4].trim() !== "*",
  };
}

function matchesCron(d: Date, p: ParsedCron): boolean {
  if (!p.months.includes(d.getUTCMonth() + 1)) return false;
  const domMatch = p.daysOfMonth.includes(d.getUTCDate());
  const dowMatch = p.daysOfWeek.includes(d.getUTCDay());
  const dayOk = p.domRestricted && p.dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
  if (!dayOk) return false;
  return p.hours.includes(d.getUTCHours()) && p.minutes.includes(d.getUTCMinutes());
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    fmt = null;
  }
  formatters.set(timeZone, fmt);
  return fmt;
}

function wallClockAt(instant: Date, timeZone: string): Date | null {
  const fmt = zoneFormatter(timeZone);
  if (!fmt || typeof fmt.formatToParts !== "function") return null;
  const parts = fmt.formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const mi = get("minute");
  if ([y, mo, d, hour, mi].some((v) => Number.isNaN(v))) return null;
  return new Date(Date.UTC(y, mo - 1, d, hour, mi, 0, 0));
}

function instantForWallClock(wall: Date, timeZone: string): Date | null {
  const offsetAt = (instant: Date): number | null => {
    const w = wallClockAt(instant, timeZone);
    return w ? w.getTime() - instant.getTime() : null;
  };
  const first = offsetAt(wall);
  if (first === null) return null;
  let candidate = new Date(wall.getTime() - first);
  const second = offsetAt(candidate);
  if (second === null) return null;
  if (second !== first) candidate = new Date(wall.getTime() - second);
  const roundTrip = wallClockAt(candidate, timeZone);
  if (!roundTrip || roundTrip.getTime() !== wall.getTime()) return null;
  return candidate;
}

export function nextRuns(expr: string, timeZone?: string | null, n = 3, from: Date = new Date()): Date[] {
  const p = parseCron(expr);
  if (!p || n <= 0) return [];
  const zoned = timeZone && zoneFormatter(timeZone) ? timeZone : null;
  const cursor = zoned ? wallClockAt(from, zoned) : new Date(from.getTime());
  if (!cursor) return [];
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limitMs = cursor.getTime() + 400 * 24 * 60 * 60 * 1000;
  const out: Date[] = [];
  while (cursor.getTime() <= limitMs && out.length < n) {
    if (matchesCron(cursor, p)) {
      if (!zoned) out.push(new Date(cursor.getTime()));
      else {
        const instant = instantForWallClock(cursor, zoned);
        if (instant) out.push(instant);
      }
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return out;
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function listDows(dows: number[]): string {
  const key = dows.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  const names = dows.map((d) => DOW_NAMES[d]);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function formatClock(h: number, m: number): string {
  const hour12 = ((h + 11) % 12) + 1;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function describeCron(expr: string, zoneLabel?: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const p = parseCron(expr);
  if (!p) return null;
  const [minF, hrF] = parts;
  const zone = zoneLabel ? `in ${zoneLabel}` : "in UTC";
  if (expr.trim() === "* * * * *") return "Every minute.";
  const stepMatch = minF.match(/^\*\/(\d+)$/);
  if (stepMatch && hrF === "*" && !p.domRestricted && !p.dowRestricted && parts[3] === "*") {
    return `Every ${stepMatch[1]} minutes.`;
  }
  let when = "";
  if (p.minutes.length === 1 && p.hours.length === 1) {
    when = `at ${formatClock(p.hours[0], p.minutes[0])} ${zone}`;
  } else if (hrF === "*" && p.minutes.length === 1 && !p.domRestricted && !p.dowRestricted) {
    return `At :${String(p.minutes[0]).padStart(2, "0")} past every hour (${zone}).`;
  } else {
    return `Runs on a custom schedule (${zone}).`;
  }
  if (!p.domRestricted && !p.dowRestricted) return `Every day ${when}.`;
  if (p.dowRestricted && !p.domRestricted) return `On ${listDows(p.daysOfWeek)} ${when}.`;
  if (p.domRestricted && !p.dowRestricted) return `On day ${p.daysOfMonth.join(", ")} of each month ${when}.`;
  return `On ${listDows(p.daysOfWeek)} or day ${p.daysOfMonth.join(", ")} of the month ${when}.`;
}

export type ScheduleShape = "daily" | "weekdays" | "weekly" | "hourly" | "custom";

export function timeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function cronToShape(expr: string): { shape: ScheduleShape; time: string } {
  const p = parseCron(expr);
  const parts = expr.trim().split(/\s+/);
  if (!p || parts.length !== 5) return { shape: "custom", time: "09:00" };
  const [, hrF, domF, monF, dowF] = parts;
  if (p.minutes.length !== 1 || domF !== "*" || monF !== "*") return { shape: "custom", time: "09:00" };
  const minute = p.minutes[0];
  if (hrF === "*" && dowF === "*") return { shape: "hourly", time: timeOfDay(0, minute) };
  if (p.hours.length !== 1) return { shape: "custom", time: "09:00" };
  const time = timeOfDay(p.hours[0], minute);
  if (dowF === "*") return { shape: "daily", time };
  if (dowF === "1-5") return { shape: "weekdays", time };
  if (dowF === "1") return { shape: "weekly", time };
  return { shape: "custom", time };
}

export function withTimeOfDay(expr: string, time: string): string | null {
  const t = parseTimeOfDay(time);
  if (!t) return null;
  const { shape } = cronToShape(expr);
  switch (shape) {
    case "daily":
      return `${t.minute} ${t.hour} * * *`;
    case "weekdays":
      return `${t.minute} ${t.hour} * * 1-5`;
    case "weekly":
      return `${t.minute} ${t.hour} * * 1`;
    default:
      return null;
  }
}

const ZONE_LABELS: Record<string, string> = {
  "America/Los_Angeles": "Los Angeles (PT)",
  "America/Denver": "Denver (MT)",
  "America/Phoenix": "Phoenix (MST)",
  "America/Chicago": "Chicago (CT)",
  "America/New_York": "New York (ET)",
  "America/Toronto": "Toronto (ET)",
  "Europe/London": "London (GMT/BST)",
  "Europe/Paris": "Paris (CET)",
  "Europe/Berlin": "Berlin (CET)",
  "Asia/Dubai": "Dubai (GST)",
  "Asia/Kolkata": "India (IST)",
  "Asia/Calcutta": "India (IST)",
  "Asia/Singapore": "Singapore (SGT)",
  "Asia/Tokyo": "Tokyo (JST)",
  "Australia/Sydney": "Sydney (AET)",
  UTC: "UTC",
};

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timeZoneLabel(tz: string): string {
  return ZONE_LABELS[tz] ?? (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}

export function formatInZone(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toUTCString();
  }
}

export function relativeUntil(next: Date, now: Date = new Date()): string {
  const ms = next.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export function scheduleLine(s: Schedule | null, now: Date = new Date()): string {
  if (!s) return "No schedule yet";
  const tz = s.timezone ?? "UTC";
  const desc = describeCron(s.cron_expression, timeZoneLabel(tz)) ?? s.cron_expression;
  if (!s.enabled) return `${desc} · paused`;
  const next = nextRuns(s.cron_expression, s.timezone, 1, now)[0];
  return next ? `${desc} · next run ${relativeUntil(next, now)}` : desc;
}
