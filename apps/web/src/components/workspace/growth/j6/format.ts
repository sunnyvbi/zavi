
import type { Forecast } from "./api";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY = 86_400_000;

export function day(value: string | null | undefined): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export const monthName = (d: Date = new Date()) => FULL_MONTHS[d.getMonth()];

export const dollars = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dayMs = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
const todayMs = (now: Date) => Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

export function monthEnd(now: Date = new Date()): string {
  return ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

export function daysLeftInMonth(now: Date = new Date()): number {
  return Math.round((dayMs(monthEnd(now)) - todayMs(now)) / DAY) + 1;
}

export function amountText(delta: number | null): string | null {
  if (delta === null) return null;
  return `${delta < 0 ? "−" : "+"}$${Math.abs(Math.round(delta)).toLocaleString("en-US")}/day`;
}

export type RunsOut = { kind: "lasts" } | { kind: "date"; on: string } | { kind: "unknown" };

export function runsOutNow(f: Forecast | null, leftUsd: number | null = null, now: Date = new Date()): RunsOut {
  if (!f) return { kind: "unknown" };
  if (leftUsd !== null && f.daily_usd !== null) return runsOutAfter(f, 0, leftUsd, now);
  if (f.runs_out_on) return { kind: "date", on: f.runs_out_on };
  return f.daily_usd !== null ? { kind: "lasts" } : { kind: "unknown" };
}

export function runsOutAfter(f: Forecast | null, delta: number, leftUsd: number | null, now: Date = new Date()): RunsOut {
  if (!f || f.daily_usd === null) return { kind: "unknown" };
  const daily = f.daily_usd + delta;
  if (daily <= 0) return { kind: "lasts" };
  const daysNow = f.runs_out_on ? Math.max(0, (dayMs(f.runs_out_on) - todayMs(now)) / DAY) : null;
  const left = leftUsd ?? (daysNow !== null ? f.daily_usd * daysNow : null);
  if (left === null) return { kind: "unknown" };
  const days = Math.floor(left / daily);
  const on = new Date(todayMs(now) + days * DAY).toISOString().slice(0, 10);
  return on > monthEnd(now) ? { kind: "lasts" } : { kind: "date", on };
}

export function launchDailyUsd(totalUsd: number | null | undefined, endsAt: number | null | undefined, now: Date = new Date()): number | null {
  if (!totalUsd || totalUsd <= 0 || !endsAt || !Number.isFinite(endsAt)) return null;
  const left = daysLeftInMonth(now);
  const toEnd = Math.max(1, Math.ceil((endsAt - now.getTime()) / DAY));
  return (totalUsd * Math.min(1, left / toEnd)) / left;
}

export function runsOutText(r: RunsOut): string {
  return r.kind === "lasts" ? "lasts the month" : r.kind === "date" ? `runs out about ${day(r.on)}` : "";
}

export function shiftText(before: RunsOut, after: RunsOut, now: Date = new Date()): string {
  const end = monthEnd(now);
  const on = (r: RunsOut) => (r.kind === "date" ? r.on : r.kind === "lasts" ? end : null);
  const a = on(before);
  const b = on(after);
  if (!a || !b || a === b) return "";
  const diff = Math.round((dayMs(a) - dayMs(b)) / DAY);
  const n = Math.abs(diff);
  const span = n === 1 ? "a day" : `${n} days`;
  return diff > 0 ? `${span} sooner` : `${span} later`;
}

export function creditsText(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;
}
