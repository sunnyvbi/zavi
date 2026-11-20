
import { z } from "zod";

export const dateRangeSchema = z
  .enum(["LAST_7_DAYS", "LAST_28_DAYS", "LAST_90_DAYS"])
  .default("LAST_28_DAYS");

export const customRangeSchema = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const RANGE_TO_DAYS: Record<string, number> = {
  LAST_7_DAYS: 7,
  LAST_28_DAYS: 28,
  LAST_90_DAYS: 90,
};

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export type ResolvedRange = { startDate: string; endDate: string; label: string };

export function resolveRange(
  date_range: string | undefined,
  custom_range?: { since: string; until: string },
): ResolvedRange {
  const startDate = custom_range ? custom_range.since : isoDaysAgo(RANGE_TO_DAYS[date_range ?? ""] ?? 28);
  const endDate = custom_range ? custom_range.until : isoDaysAgo(1);
  return { startDate, endDate, label: `${startDate}..${endDate}` };
}

function toUtcMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function windowDays(range: ResolvedRange): number {
  return Math.floor((toUtcMs(range.endDate) - toUtcMs(range.startDate)) / 86_400_000) + 1;
}

export function previousWindow(range: ResolvedRange): ResolvedRange {
  const days = windowDays(range);
  const endMs = toUtcMs(range.startDate) - 86_400_000;
  const startMs = endMs - (days - 1) * 86_400_000;
  const startDate = fromUtcMs(startMs);
  const endDate = fromUtcMs(endMs);
  return { startDate, endDate, label: `${startDate}..${endDate}` };
}
