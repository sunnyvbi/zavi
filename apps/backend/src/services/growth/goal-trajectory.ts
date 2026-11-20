
import { confirmedRule } from "./goal-count-rule";
import { classifyTargetMetric } from "@/services/autopilot/goal-metric-vocab";

export const VALUE_KINDS = ["gauge", "period_total"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export type TrajectoryGoal = {
  target_metric?: string | null;
  target_value: number | null;
  current_value: number | null;
  current_value_at?: string | null;
  baseline_value?: number | null;
  created_at?: string | null;
  due_date: string | null;
  measurement_mode: string | null;
  count_rule?: unknown;
  value_kind?: string | null;
  value_period_start?: string | null;
};

export type GoalKind = ValueKind | "ambiguous";

export type PaceLine = { start_value: number; start_day: string; target: number; due_day: string };

export type Trajectory = {
  kind: GoalKind;
  line: PaceLine | null;
  projected: number | null;
  behind_required: boolean;
  progress: number | null;
  reading_day: string;
  pace_usable: boolean;
};

const DAY_MS = 86_400_000;
export const MIN_FORECAST_DAYS = 3;

const isDay = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}`;
};
const dayOf = (s: string) => s.slice(0, 10);
const dayMs = (s: string) => Date.parse(`${dayOf(s)}T00:00:00Z`);
export function daysInclusive(a: string, b: string): number {
  return Math.round((dayMs(b) - dayMs(a)) / DAY_MS) + 1;
}
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

const NOT_COUNTED_UP = /\b(cost|costs|cpa|cac|cpc|cpm|cpl|spend|spent|spending|budget|churn|churned|bounce|refunds?|cancell?ations?|complaints?|latency|burn)\b/i;

const FOOTPRINT_COUNT = /\b(states|cities|countries|markets|regions|locations|stores|branches|offices|languages|launches)\b/i;

const MONEY_METRIC = /\b(revenue|gmv|mrr|arr|spend|spent|budget|costs?|cac|cpa|cpc|cpl|cpm|income|profit|payouts?|earnings|dollars?|usd|aov|arpu|ltv)\b/i;
const NOT_MONEY_METRIC = /%|\b(rates?|ratio|percent|percentage|roas|ctr|cvr|margin)\b/i;
export function goalMoneyMetric(metric: string | null | undefined): boolean {
  const raw = String(metric ?? "").replace(/[_\-.]+/g, " ").trim();
  if (NOT_MONEY_METRIC.test(raw)) return false;
  if (/^(?:[a-z]+\s+){0,2}\$\s?\d/i.test(raw)) return true;
  const m = raw.replace(/\$\s?\d[\d,]*(?:\s?[kmb])?(?:\s*\/\s*\w+)?/gi, " ");
  const k = classifyTargetMetric(m).kind;
  return k === "booking_value" || k === "stripe_mrr" || k === "stripe_gross_revenue" || MONEY_METRIC.test(m);
}

export function notCountedUp(metric: string | null | undefined, direction?: "up" | "down" | "context" | null): boolean {
  return direction === "down" || direction === "context" || (!!metric && NOT_COUNTED_UP.test(metric));
}

export function goalKind(g: TrajectoryGoal): GoalKind {
  if (g.measurement_mode === "auto") return "gauge";
  if (g.value_kind === "period_total" && isDay(g.value_period_start) && !notCountedUp(g.target_metric)) return "period_total";
  if (g.value_kind === "gauge") return "gauge";
  if (confirmedRule(g.count_rule)) return "gauge";
  const base = num(g.baseline_value);
  const target = num(g.target_value);
  const current = num(g.current_value);
  if (!goalMoneyMetric(g.target_metric)) {
    if (g.target_metric && FOOTPRINT_COUNT.test(g.target_metric)) return "gauge";
    if (current != null && base != null && current === base) return "gauge";
  }
  if (base != null && target != null && base > 0 && target !== base && target > 0 && !notCountedUp(g.target_metric)) return "ambiguous";
  return "gauge";
}

const monthOf = (d: string) => dayOf(d).slice(0, 7);
const monthsSpanned = (a: string, b: string) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
const WHOLE_PERIOD_MONTHS = new Set([1, 3, 6, 12]);

export function periodStartStale(start: string | null | undefined, due: string | null | undefined): boolean {
  if (!isDay(start) || !isDay(due) || !dayOf(start).endsWith("-01")) return false;
  const months = monthsSpanned(dayOf(start), dayOf(due));
  return months > 1 && !WHOLE_PERIOD_MONTHS.has(months);
}

export function rolledPeriodStart(
  g: { value_kind?: string | null; value_period_start?: string | null; due_date?: string | null },
  nextDue: string | null | undefined,
): string | null {
  const start = g.value_period_start;
  if (g.value_kind !== "period_total" || !isDay(start) || !isDay(nextDue) || !dayOf(start).endsWith("-01")) return null;
  if (!(monthOf(nextDue) > monthOf(start))) return null;
  const monthly = isDay(g.due_date) && monthOf(g.due_date) === monthOf(start);
  if (!monthly && !periodStartStale(start, g.due_date)) return null;
  return `${monthOf(nextDue)}-01`;
}

export function proposedPeriodStart(g: Pick<TrajectoryGoal, "created_at" | "due_date" | "current_value_at">, today: string): string | null {
  if (!isDay(g.created_at)) return null;
  const created = dayOf(g.created_at);
  const read = readingDay(g, today);
  const month = (d: string) => d.slice(0, 7);
  if (isDay(g.due_date) && month(created) === month(read) && month(read) === month(g.due_date)) return `${month(created)}-01`;
  return created;
}

function gaugeLine(g: TrajectoryGoal): PaceLine | null {
  const target = num(g.target_value);
  if (target == null || !isDay(g.created_at) || !isDay(g.due_date)) return null;
  return { start_value: num(g.baseline_value) ?? 0, start_day: dayOf(g.created_at), target, due_day: dayOf(g.due_date) };
}

function periodLine(g: TrajectoryGoal, start: string | null | undefined): PaceLine | null {
  const target = num(g.target_value);
  if (target == null || !isDay(start) || !isDay(g.due_date)) return null;
  return { start_value: 0, start_day: dayOf(start), target, due_day: dayOf(g.due_date) };
}

export function paceLines(g: TrajectoryGoal, today: string): PaceLine[] {
  const kind = goalKind(g);
  const lines =
    kind === "period_total"
      ? [periodStartStale(g.value_period_start, g.due_date) ? null : periodLine(g, g.value_period_start)]
      : kind === "ambiguous"
        ? [gaugeLine(g), periodLine(g, proposedPeriodStart(g, today))]
        : [gaugeLine(g)];
  return lines.filter((l): l is PaceLine => l !== null && dayMs(l.due_day) >= dayMs(l.start_day));
}

export function readingDay(g: Pick<TrajectoryGoal, "current_value_at">, today: string): string {
  if (isDay(g.current_value_at) && dayMs(g.current_value_at) < dayMs(today)) return dayOf(g.current_value_at);
  return dayOf(today);
}

export function expectedOn(line: PaceLine, day: string): number {
  const total = daysInclusive(line.start_day, line.due_day);
  const fraction = Math.min(1, Math.max(0, daysInclusive(line.start_day, day) / total));
  return line.start_value + (line.target - line.start_value) * fraction;
}

export function behindLine(line: PaceLine, current: number, day: string): boolean {
  const lowerIsBetter = line.target < line.start_value;
  const remaining = lowerIsBetter ? current - line.target : line.target - current;
  if (!(remaining > 0) || dayMs(day) < dayMs(line.start_day)) return false;
  const expected = expectedOn(line, day);
  return lowerIsBetter ? current > expected : current < expected;
}

export function projectOnLine(line: PaceLine, current: number, day: string): number | null {
  const elapsed = daysInclusive(line.start_day, day);
  const total = daysInclusive(line.start_day, line.due_day);
  if (!(elapsed >= MIN_FORECAST_DAYS) || !(total > elapsed)) return null;
  const projected = line.start_value + ((current - line.start_value) / elapsed) * total;
  return Math.max(0, Math.round(projected));
}

export function goalTrajectory(
  g: TrajectoryGoal,
  today: string,
  opts: { paceUsable: boolean; progressUsable: boolean },
): Trajectory {
  const kind = goalKind(g);
  const lines = paceLines(g, today);
  const line = kind === "ambiguous" ? null : (lines[0] ?? null);
  const current = num(g.current_value);
  const day = readingDay(g, today);

  let projected: number | null = null;
  let behind_required = false;
  if (current != null && opts.paceUsable && lines.length > 0) {
    if (line) projected = projectOnLine(line, current, day);
    behind_required = lines.every((l) => behindLine(l, current, day));
  }

  let progress: number | null = null;
  if (current != null && opts.progressUsable && kind !== "ambiguous") {
    const target = num(g.target_value);
    const start = kind === "period_total" ? 0 : (num(g.baseline_value) ?? 0);
    if (target != null && target !== start) progress = Math.max(0, Math.min(1, (current - start) / (target - start)));
  }
  return { kind, line, projected, behind_required, progress, reading_day: day, pace_usable: opts.paceUsable && current != null };
}

export function goalMet(g: TrajectoryGoal): boolean {
  const current = num(g.current_value);
  const target = num(g.target_value);
  if (current == null || target == null) return false;
  const base = num(g.baseline_value);
  const down = base != null && target < base;
  const kind = goalKind(g);
  if (kind === "period_total") return current >= target;
  if (kind === "ambiguous") return down ? current <= target && current >= target : current >= target;
  return down ? current <= target : current >= target;
}

export function valueKindRefusal(g: {
  value_kind: string | null;
  value_period_start: string | null;
  target_value: number | null;
  baseline_value: number | null;
  measurement_mode: string | null;
  due_date: string | null;
  direction?: "up" | "down" | "context" | null;
  target_metric?: string | null;
}): string | null {
  if (g.value_kind == null) return g.value_period_start == null ? null : "value_period_start needs value_kind period_total";
  if (!(VALUE_KINDS as readonly string[]).includes(g.value_kind)) return "value_kind must be gauge, period_total or null";
  if (g.measurement_mode === "auto") return "only a number you type in can say how it counts; a connected source counts its own way";
  if (g.value_kind === "gauge") return g.value_period_start == null ? null : "value_period_start is only for period_total";
  if (!isDay(g.value_period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(g.value_period_start)) return "period_total needs value_period_start as a YYYY-MM-DD date";
  if (g.due_date && dayMs(g.value_period_start) > dayMs(g.due_date)) return "value_period_start must be on or before the due date";
  if (g.target_value == null || !(g.target_value > 0)) return "a period total needs a target above 0";
  if (notCountedUp(g.target_metric, g.direction)) return "this metric is not one you count up to, so it cannot be a period total";
  return null;
}
