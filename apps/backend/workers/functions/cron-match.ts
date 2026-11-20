
type FieldSpec = { min: number; max: number };
const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

function matchPart(part: string, value: number, spec: FieldSpec): boolean {
  let step = 1;
  let base = part;
  const slash = part.indexOf("/");
  if (slash !== -1) {
    step = parseInt(part.slice(slash + 1), 10);
    base = part.slice(0, slash);
    if (!Number.isInteger(step) || step <= 0) return false;
  }
  let lo: number;
  let hi: number;
  if (base === "*") {
    lo = spec.min;
    hi = spec.max;
  } else if (base.includes("-")) {
    const [a, b] = base.split("-");
    lo = parseInt(a, 10);
    hi = parseInt(b, 10);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
  } else {
    const n = parseInt(base, 10);
    if (!Number.isInteger(n)) return false;
    lo = n;
    hi = n;
  }
  if (lo < spec.min || hi > spec.max || lo > hi) return false;
  if (value < lo || value > hi) return false;
  return (value - lo) % step === 0;
}

function fieldMatches(token: string, value: number, spec: FieldSpec): boolean {
  for (const part of token.split(",")) {
    if (matchPart(part.trim(), value, spec)) return true;
  }
  return false;
}

const DOW_SHORT: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const tzValidCache = new Map<string, boolean>();
export function isValidTimeZone(tz: string): boolean {
  const cached = tzValidCache.get(tz);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  tzValidCache.set(tz, ok);
  return ok;
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = zonedFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    zonedFormatterCache.set(timeZone, f);
  }
  return f;
}

function zonedCronValues(when: Date, timeZone: string): number[] | null {
  if (!isValidTimeZone(timeZone)) return null;
  const parts = zonedFormatter(timeZone).formatToParts(when);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get("minute"), 10);
  const dom = parseInt(get("day"), 10);
  const month = parseInt(get("month"), 10);
  const dow = DOW_SHORT[get("weekday")] ?? 0;
  return [minute, hour, dom, month, dow];
}

export function cronMatches(
  expr: string,
  when: Date,
  timeZone?: string | null,
): boolean {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) return false;
  const zoned =
    timeZone && timeZone.length > 0 ? zonedCronValues(when, timeZone) : null;
  const values = zoned ?? [
    when.getUTCMinutes(),
    when.getUTCHours(),
    when.getUTCDate(),
    when.getUTCMonth() + 1,
    when.getUTCDay(),
  ];
  for (let i = 0; i < 5; i++) {
    let tok = tokens[i];
    if (i === 4 && tok === "7") tok = "0";
    if (!fieldMatches(tok, values[i], FIELDS[i])) return false;
  }
  return true;
}

export function cronDueInBucket(
  expr: string,
  bucketStartIso: string,
  timeZone?: string | null,
): boolean {
  const start = new Date(bucketStartIso).getTime();
  if (Number.isNaN(start)) return false;
  for (let m = 0; m < 5; m++) {
    if (cronMatches(expr, new Date(start + m * 60_000), timeZone)) return true;
  }
  return false;
}

export function nextLocalCronFire(
  expr: string,
  timeZone: string,
  from: Date,
  maxDays = 366,
): Date | null {
  const start = Math.ceil(from.getTime() / 60_000) * 60_000;
  const maxMinutes = maxDays * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    const t = new Date(start + i * 60_000);
    if (cronMatches(expr, t, timeZone)) return t;
  }
  return null;
}

export function missedDueBuckets(
  expr: string,
  since: Date | null,
  now: Date = new Date(),
  maxLookbackDays = 7,
): number {
  const nowMs = now.getTime();
  const lookbackFloor = nowMs - maxLookbackDays * 86_400_000;
  const startMs = Math.max(since ? since.getTime() + 60_000 : lookbackFloor, lookbackFloor);
  if (startMs > nowMs) return 0;
  const FIVE_MIN = 5 * 60_000;
  let count = 0;
  for (let t = Math.floor(startMs / FIVE_MIN) * FIVE_MIN; t <= nowMs; t += FIVE_MIN) {
    if (cronDueInBucket(expr, new Date(t).toISOString())) count += 1;
  }
  return count;
}

export function validateCronExpression(expr: string): string | null {
  const t = (expr ?? "").trim();
  const toks = t.split(/\s+/);
  if (toks.length !== 5) {
    return "cron must have exactly 5 fields: minute hour day-of-month month day-of-week";
  }
  for (let i = 0; i < 5; i++) {
    for (const part of toks[i].split(",")) {
      const p = part.trim();
      if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(p)) {
        return `invalid token "${toks[i]}" in field ${i + 1}`;
      }
      const stepM = p.match(/\/(\d+)$/);
      if (stepM && parseInt(stepM[1], 10) <= 0) {
        return `invalid step in field ${i + 1}`;
      }
      const spec = FIELDS[i];
      const base = p.split("/")[0];
      if (base !== "*") {
        for (const n of base.split("-")) {
          const v = parseInt(n, 10);
          if (v < spec.min || v > spec.max) {
            return `value ${v} out of range in field ${i + 1} (${spec.min}-${spec.max})`;
          }
        }
      }
    }
  }
  let minuteHits = 0;
  for (let m = 0; m < 60; m++) {
    if (fieldMatches(toks[0], m, FIELDS[0])) minuteHits += 1;
  }
  if (minuteHits > 12) {
    return "cadence too frequent — minimum is every 5 minutes";
  }
  return null;
}
