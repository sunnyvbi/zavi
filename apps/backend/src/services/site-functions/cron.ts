
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
  source: string;
}

export class CronError extends Error {}

const FIELDS: Array<[string, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
];

function parseField(raw: string, [label, lo, hi]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new CronError(`invalid ${label} "${part}"`);
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      a = Number(m[2]);
      b = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : a;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (a < lo || b > hi || a > b || step < 1) throw new CronError(`${label} out of range in "${part}"`);
    for (let i = a; i <= b; i += step) out.add(label === "day of week" && i === 7 ? 0 : i);
  }
  return out;
}

export function parseCron(src: string): Cron {
  if (typeof src !== "string" || src.length > 100) throw new CronError("cron must be a string of at most 100 chars");
  const parts = src.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { minute, hour, dom, month, dow, domStar: parts[2] === "*", dowStar: parts[4] === "*", source: parts.join(" ") };
}

function dayMatches(c: Cron, d: Date): boolean {
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;
}

export function nextFire(c: Cron, after: Date): Date {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.month.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  throw new CronError(`cron "${c.source}" never fires`);
}

export function latestDueSlot(c: Cron, from: Date, at: Date): Date | null {
  let slot: Date | null = null;
  let probe = new Date(from.getTime() - 60_000);
  for (let i = 0; i < 10_000; i++) {
    const n = nextFire(c, probe);
    if (n.getTime() > at.getTime()) break;
    slot = n;
    probe = n;
  }
  return slot;
}

export function minIntervalMinutes(c: Cron, from: Date, samples = 50): number {
  let prev = nextFire(c, from);
  let min = Infinity;
  for (let i = 0; i < samples; i++) {
    const n = nextFire(c, prev);
    min = Math.min(min, (n.getTime() - prev.getTime()) / 60_000);
    prev = n;
  }
  return min;
}
