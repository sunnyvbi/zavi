
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function lastCompleteDay(now: Date = new Date()): Date {
  const anchor = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() - 1));
}

export function fullDaysWindow(days: number, now: Date = new Date()): { since: string; until: string } {
  const until = lastCompleteDay(now);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { since: ymd(since), until: ymd(until) };
}
