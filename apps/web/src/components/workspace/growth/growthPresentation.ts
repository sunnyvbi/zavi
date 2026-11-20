import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import type { Goal } from "../AutopilotGoalsPanel";

export function humanize(value: string): string {
  return value
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\b(Seo|Sms|Ugc|Aso|Cpa|Cac|Mrr|Arr|Gmv|Pr|Ai)\b/g, (word) =>
      word.toUpperCase(),
    );
}

export function formatValue(
  value: number | null,
  unit?: string | null,
): string {
  if (value === null) return "-";
  const number = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value);
  if (["usd", "dollars", "currency"].includes(unit?.toLowerCase() ?? ""))
    return `$${number}`;
  return ["percent", "percentage", "pct"].includes(unit?.toLowerCase() ?? "")
    ? `${number}%`
    : number;
}

export function goalProgress(goal: GrowthGoal): number | null {
  if (goal.trajectory) return goal.trajectory.progress == null ? null : Math.round(goal.trajectory.progress * 100);
  const {
    current_value: current,
    target_value: target,
    baseline_value: baseline,
  } = goal;
  if (
    current === null ||
    target === null ||
    baseline === null ||
    target === baseline
  )
    return null;
  return Math.round(
    Math.max(
      0,
      Math.min(100, ((current - baseline) / (target - baseline)) * 100),
    ),
  );
}

export function editableGoal(goal: GrowthGoal): Goal {
  const status =
    goal.status === "paused" ||
    goal.status === "met" ||
    goal.status === "missed"
      ? goal.status
      : "active";
  return {
    ...goal,
    status,
    target_value: goal.target_value ?? 0,
    priority: goal.priority ?? 50,
    source: goal.source ?? "founder",
    created_at: "",
    updated_at: "",
  };
}

export type GoalPace = {
  remaining: number;
  weeks: number;
  perWeek: number;
  perWeekExact: number;
  met: boolean;
  direction: "up" | "down";
};

export function goalPace(
  goal: GrowthGoal,
  now: Date = new Date(),
): GoalPace | null {
  const { current_value: current, target_value: target, due_date: due } = goal;
  if (current === null || target === null || due === null) return null;

  const deadline = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(deadline)) return null;

  const from = goal.baseline_value ?? current;
  const direction: "up" | "down" = target >= from ? "up" : "down";
  const sign = direction === "up" ? 1 : -1;

  const remaining = (target - current) * sign;
  if (remaining <= 0)
    return { remaining: 0, weeks: 0, perWeek: 0, perWeekExact: 0, met: true, direction };

  const msLeft = deadline - now.getTime();
  if (msLeft <= 0) return null;

  const exactWeeks = msLeft / (7 * 24 * 60 * 60 * 1000);
  const weeks = Math.max(1, Math.floor(exactWeeks));
  return {
    remaining,
    weeks,
    perWeek: remaining / weeks,
    perWeekExact: remaining / Math.max(1, exactWeeks),
    met: false,
    direction,
  };
}

export function shortDate(value: string, now: Date = new Date()): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}

export const FORM_CONNECTORS = new Set(["stripe", "operator_db"]);
export function connectorSetupHref(slug: string): string {
  return `/workspace?tab=brain#connector-${slug}`;
}
