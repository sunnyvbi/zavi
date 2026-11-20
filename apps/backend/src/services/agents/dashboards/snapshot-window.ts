const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type SnapshotWindow = { since: string; until: string | null; isDefault: boolean; period: { from: string; to: string } };

export function snapshotWindow(c: { rangeDays: number | null; customRange?: { since: string; until: string } | null }, defaultDays: number, now = Date.now()): SnapshotWindow {
  if (c.customRange) {
    return { since: c.customRange.since, until: c.customRange.until, isDefault: false, period: { from: c.customRange.since, to: c.customRange.until } };
  }
  const days = c.rangeDays ?? defaultDays;
  const since = ymd(now - days * DAY);
  return { since, until: null, isDefault: days === defaultDays, period: { from: since, to: ymd(now) } };
}

export function spanDays(range: { since: string; until: string }): number {
  return Math.round((Date.parse(`${range.until}T00:00:00Z`) - Date.parse(`${range.since}T00:00:00Z`)) / DAY) + 1;
}
