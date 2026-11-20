export type PickedRange = { id: string; days: number; since?: string; until?: string };
export type CustomSpan = { since: string; until: string };

export const CUSTOM_RANGE_ID = "custom";
export const MAX_CUSTOM_DAYS = 90;

const DAY = 86_400_000;

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const firstOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const sameDay = (a: Date | null, b: Date | null) => !!a && !!b && a.getTime() === b.getTime();
export const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY) + 1;
export const monthName = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
export const mediumDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const shortDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const pad = (n: number) => String(n).padStart(2, "0");

export const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fromYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function rangeLabel(from: Date, to: Date): string {
  if (sameDay(from, to)) return mediumDate(from);
  return from.getFullYear() === to.getFullYear() ? `${shortDay(from)} – ${mediumDate(to)}` : `${mediumDate(from)} – ${mediumDate(to)}`;
}

export function spanLabel(span: CustomSpan): string {
  return rangeLabel(fromYmd(span.since), fromYmd(span.until));
}

export function presetSpan(days: number, today: Date): { from: Date; to: Date } {
  return { from: addDays(today, -days), to: addDays(today, -1) };
}

export function parseTypedDate(text: string, today: Date): Date | null {
  const t = text.trim();
  if (!t) return null;
  const d = new Date(/\d{4}/.test(t) ? t : `${t} ${today.getFullYear()}`);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function payloadPeriod(payload: unknown): { from: string; to: string } | null {
  const p = (payload as { period?: { from?: unknown; to?: unknown } } | null)?.period;
  return p && typeof p.from === "string" && typeof p.to === "string" && YMD.test(p.from) && YMD.test(p.to) ? { from: p.from, to: p.to } : null;
}

export function customRangeRefused(custom: CustomSpan | null, period: { from: string; to: string } | null): boolean {
  if (!custom || !period) return false;
  return Math.abs(fromYmd(period.from).getTime() - fromYmd(custom.since).getTime()) > DAY;
}

export function windowKey(picked: PickedRange): string {
  return picked.since && picked.until ? `${picked.since}_${picked.until}` : String(picked.days);
}
