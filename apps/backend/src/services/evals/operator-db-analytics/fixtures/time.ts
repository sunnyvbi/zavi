
export function localMidnightUtc(y: number, m: number, d: number, tz: string): Date {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = naive;
  for (let i = 0; i < 4; i++) {
    const next = naive - tzOffsetMs(new Date(guess), tz);
    if (next === guess) break;
    guess = next;
  }
  if (localDateOf(new Date(guess), tz) === ymd(y, m, d)) return new Date(guess);

  for (let minute = 1; minute <= 180; minute++) {
    const t = new Date(guess + minute * 60_000);
    if (localDateOf(t, tz) === ymd(y, m, d)) return t;
  }
  return new Date(guess);
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function localDateOf(at: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

export function localMonthRange(y: number, m: number, tz: string): [Date, Date] {
  const start = localMidnightUtc(y, m, 1, tz);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return [start, localMidnightUtc(ny, nm, 1, tz)];
}

export function inRange(at: unknown, start: Date, end: Date): boolean {
  const t = at instanceof Date ? at : new Date(String(at));
  return t >= start && t < end;
}
