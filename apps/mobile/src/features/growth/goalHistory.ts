
import { historyPace, type HistoryPace, type HistoryPoint } from "./story";
import { type GrowthGoal } from "./plan";

export type GoalHistoryBody = {
  label?: string | null;
  source?: string | null;
  window_kind?: string | null;
  points: HistoryPoint[];
  last_measured_at: string | null;
};

export function historyBodyOf(raw: unknown): GoalHistoryBody {
  const b = (raw ?? {}) as Record<string, unknown>;
  return {
    label: typeof b.label === "string" ? b.label : null,
    source: typeof b.source === "string" ? b.source : null,
    window_kind: typeof b.window_kind === "string" ? b.window_kind : null,
    points: Array.isArray(b.points) ? (b.points as HistoryPoint[]) : [],
    last_measured_at: typeof b.last_measured_at === "string" ? b.last_measured_at : null,
  };
}

export function shortDay(iso: string): string {
  const t = Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isFinite(t)
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(t))
    : iso;
}

export type Verdict = { tone: "quiet" | "good" | "bad"; title: string; detail: string };

export function historyVerdict(input: {
  failed: boolean;
  points: HistoryPoint[];
  pace: HistoryPace | null;
  behind: boolean;
  measurementMode: string | null | undefined;
  format: (v: number) => string;
}): Verdict {
  const { failed, points, pace, behind, measurementMode, format } = input;
  if (failed) {
    return { tone: "quiet", title: "History could not be loaded.", detail: "The goal itself is unaffected. Pull down on the page to try again." };
  }
  if (points.length === 0) {
    return {
      tone: "quiet",
      title: "No history yet.",
      detail:
        measurementMode === "auto"
          ? "Zavi records this goal once a day once its source can read it."
          : "Each number you enter from Edit is dated and drawn here.",
    };
  }
  if (!pace) {
    return {
      tone: "quiet",
      title: `${points.length} ${points.length === 1 ? "reading" : "readings"} since ${shortDay(points[0].at)}.`,
      detail: "Add a target and a due date to see whether it is on pace.",
    };
  }
  if (pace.daysLeft === 0) return { tone: "quiet", title: "The due date has passed.", detail: "Edit the goal to set a new date." };
  const line = `The line from ${shortDay(points[0].at)} to the goal says ${format(pace.expected)} today.`;
  if (!behind) return { tone: "good", title: "On track to hit the goal.", detail: line };
  return { tone: "bad", title: `Behind pace: about ${format(pace.gap)} short.`, detail: line };
}

export function isBehind(pace: HistoryPace | null, format: (v: number) => string): boolean {
  return pace ? !pace.onPace && format(pace.gap) !== format(0) : false;
}

export function historyStats(pace: HistoryPace | null, format: (v: number) => string): Array<{ label: string; value: string | null }> {
  return [
    { label: "Where the line says today", value: pace ? format(pace.expected) : null },
    {
      label: "Needed a week to finish",
      value: pace && pace.daysLeft > 0 ? `${pace.perWeek >= 0 ? "+" : "-"}${format(Math.abs(pace.perWeek))}` : null,
    },
    { label: "Days left", value: pace ? String(pace.daysLeft) : null },
  ];
}

export function targetLine(points: HistoryPoint[], goal: Pick<GrowthGoal, "target_value" | "due_date">): number[] | null {
  if (goal.target_value === null || !goal.due_date || points.length === 0) return null;
  const due = Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`);
  const t0 = Date.parse(points[0].at);
  if (!Number.isFinite(due) || !Number.isFinite(t0) || due <= t0) return null;
  const v0 = points[0].value;
  return points.map((p) => v0 + (goal.target_value! - v0) * Math.min(1, Math.max(0, (Date.parse(p.at) - t0) / (due - t0))));
}

export const SPARK_W = 280;
export const SPARK_H = 92;

export function sparkPaths(values: number[], target: number[] | null): { actual: string; goal: string | null; last: { x: number; y: number } } {
  const all = [...values, ...(target ?? [])];
  const max = Math.max(...all);
  const min = Math.min(...all);
  const pad = (max - min) * 0.08 || Math.abs(max) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * (SPARK_W - 8) + 4 : SPARK_W / 2);
  const y = (v: number) => SPARK_H - 4 - ((v - lo) / (hi - lo)) * (SPARK_H - 8);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return { actual: n > 1 ? path(values) : "", goal: target ? path(target) : null, last: { x: x(n - 1), y: y(values[n - 1]) } };
}

const SOURCE_NAME: Record<string, string> = {
  stripe: "Stripe",
  stripe_mrr: "Stripe",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  google_analytics: "Google Analytics",
  ga4: "Google Analytics",
  google_search_console: "Search Console",
  search_console: "Search Console",
  gsc: "Search Console",
  operator_db: "Your database",
  posthog: "PostHog",
  derived: "Worked out from two metrics",
  compute: "Worked out by Zavi",
  metric: "Metric catalog",
  founder_reported: "From you",
};

export function sourceName(slug: string | undefined | null): string | null {
  if (!slug) return null;
  if (SOURCE_NAME[slug]) return SOURCE_NAME[slug];
  const words = slug.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

export function receiptLine(body: GoalHistoryBody): string | null {
  if (body.points.length === 0) return null;
  if (body.source === "founder_reported") return "The numbers you entered for this goal, each dated when you entered it.";
  return `${body.label ?? "This metric"}, measured by Zavi from ${sourceName(body.source) ?? "the connected source"} once a day${
    body.window_kind === "rolling_7d" ? " over the last 7 days" : ""
  }.`;
}

export { historyPace };
