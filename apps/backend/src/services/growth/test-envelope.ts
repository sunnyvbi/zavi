import type { MoveTest } from "./cgo-test-shape";

export const SERVER_ENVELOPE = "server" as const;

const DAY = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const usableBaseline = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function isServerEnvelope(t: Pick<MoveTest, "envelope">): boolean {
  return t.envelope === SERVER_ENVELOPE;
}

export function legacyTestTotalUsd(t: Pick<MoveTest, "envelope" | "budget_usd">): number | null {
  return !isServerEnvelope(t) && usable(t.budget_usd) ? t.budget_usd : null;
}

export function testEndsOn(emittedAt: string, test: Pick<MoveTest, "readout_on">, launchedAt: string): string {
  const window = Math.max(1, daysBetween(dayOf(emittedAt), test.readout_on));
  const fromLaunch = addDays(dayOf(launchedAt), window);
  return fromLaunch > test.readout_on ? fromLaunch : test.readout_on;
}

export function envelopeDays(startedAt: string, endsOn: string): number {
  return Math.max(0, daysBetween(dayOf(startedAt), endsOn));
}

export type NewObjectEnvelope = { kind: "gross_since_start"; daily_usd: number; days: number; amount_usd: number; started_at: string; ends_on: string };
export type RaiseEnvelope = {
  kind: "extra_over_baseline";
  baseline_daily_usd: number;
  daily_usd: number;
  extra_daily_usd: number;
  days: number;
  amount_usd: number;
  started_at: string;
  ends_on: string;
};

export function newObjectEnvelope(a: { daily_usd: unknown; activated_at: string; ends_on: string }): NewObjectEnvelope | null {
  if (!usable(a.daily_usd)) return null;
  const days = envelopeDays(a.activated_at, a.ends_on);
  if (days <= 0) return null;
  return { kind: "gross_since_start", daily_usd: a.daily_usd, days, amount_usd: (Math.round(a.daily_usd * 100) * days) / 100, started_at: a.activated_at, ends_on: a.ends_on };
}

export function raiseEnvelope(a: { daily_usd: unknown; baseline_daily_usd: unknown; launched_at: string; ends_on: string }): RaiseEnvelope | null {
  if (!usable(a.daily_usd) || !usableBaseline(a.baseline_daily_usd)) return null;
  const extraCents = Math.round(a.daily_usd * 100) - Math.round(a.baseline_daily_usd * 100);
  if (extraCents <= 0) return null;
  const days = envelopeDays(a.launched_at, a.ends_on);
  if (days <= 0) return null;
  return {
    kind: "extra_over_baseline",
    baseline_daily_usd: a.baseline_daily_usd,
    daily_usd: a.daily_usd,
    extra_daily_usd: extraCents / 100,
    days,
    amount_usd: (extraCents * days) / 100,
    started_at: a.launched_at,
    ends_on: a.ends_on,
  };
}

export function steppedRaiseStopUsd(baselineUsd: unknown, steps: ReadonlyArray<{ daily_usd: unknown; executed_at: string }>, endsOn: string): number | null {
  if (!usableBaseline(baselineUsd) || steps.length === 0) return null;
  const ordered = [...steps].sort((a, b) => Date.parse(a.executed_at) - Date.parse(b.executed_at));
  let cents = 0;
  for (const [i, s] of ordered.entries()) {
    if (!usable(s.daily_usd)) return null;
    const until = i + 1 < ordered.length ? dayOf(ordered[i + 1]!.executed_at) : endsOn;
    const days = Math.max(0, daysBetween(dayOf(s.executed_at), until < endsOn ? until : endsOn));
    cents += Math.max(0, Math.round(s.daily_usd * 100) - Math.round(baselineUsd * 100)) * days;
  }
  return cents > 0 ? cents / 100 : null;
}
