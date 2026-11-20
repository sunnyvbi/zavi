"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import { lineValueAt } from "@/lib/workspace/goalTrajectory";
import { ReceiptChip } from "../receipts/Receipts";
import { sourceName, type ReceiptData } from "../receipts/receiptData";

export type GoalHistoryBody = {
  goal_id: string;
  metric_key: string | null;
  label?: string | null;
  source?: string | null;
  window_kind?: string | null;
  unit?: string | null;
  direction?: string | null;
  points: Array<{ at: string; value: number }>;
  last_measured_at: string | null;
};

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; body: GoalHistoryBody };

const DAY = 86_400_000;

export type GoalPace = {
  expected: number;
  onPace: boolean;
  gap: number;
  perWeek: number;
  daysLeft: number;
  from?: string;
  asOf?: string;
};

export function goalPace(
  points: GoalHistoryBody["points"],
  goal: Pick<GrowthGoal, "target_value" | "due_date" | "trajectory">,
  now: number,
  current: number | null,
): GoalPace | null {
  if (goal.target_value === null || !goal.due_date || points.length === 0) return null;
  if (goal.trajectory) {
    const t = goal.trajectory;
    const line = t.line;
    if (!line || !t.pace_usable) return null;
    const dueEnd = Date.parse(`${line.due_day}T23:59:59Z`);
    const nowValue = current ?? points[points.length - 1].value;
    const expected = lineValueAt(line, Date.parse(`${t.reading_day}T12:00:00Z`));
    const daysLeft = Math.max(0, Math.ceil((dueEnd - now) / DAY));
    const weeksLeft = Math.max(daysLeft / 7, 1 / 7);
    return {
      expected,
      onPace: !t.behind_required,
      gap: Math.abs(expected - nowValue),
      perWeek: (line.target - nowValue) / weeksLeft,
      daysLeft,
      from: line.start_day,
      asOf: t.reading_day,
    };
  }
  const due = Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`);
  const t0 = Date.parse(points[0].at);
  if (!Number.isFinite(due) || !Number.isFinite(t0) || due <= t0) return null;
  const v0 = points[0].value;
  const target = goal.target_value;
  const nowValue = current ?? points[points.length - 1].value;
  const frac = Math.min(1, Math.max(0, (now - t0) / (due - t0)));
  const expected = v0 + (target - v0) * frac;
  const up = target >= v0;
  const onPace = up ? nowValue >= expected : nowValue <= expected;
  const daysLeft = Math.max(0, Math.ceil((due - now) / DAY));
  const weeksLeft = Math.max(daysLeft / 7, 1 / 7);
  return { expected, onPace, gap: Math.abs(expected - nowValue), perWeek: (target - nowValue) / weeksLeft, daysLeft };
}

function targetLine(points: GoalHistoryBody["points"], goal: Pick<GrowthGoal, "target_value" | "due_date" | "trajectory">): number[] | null {
  if (goal.target_value === null || !goal.due_date || points.length === 0) return null;
  if (goal.trajectory) {
    const line = goal.trajectory.line;
    return line ? points.map((p) => lineValueAt(line, Date.parse(p.at))) : null;
  }
  const due = Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`);
  const t0 = Date.parse(points[0].at);
  if (!Number.isFinite(due) || !Number.isFinite(t0) || due <= t0) return null;
  const v0 = points[0].value;
  const target = goal.target_value;
  return points.map((p) => v0 + (target - v0) * Math.min(1, Math.max(0, (Date.parse(p.at) - t0) / (due - t0))));
}

const W = 280;
const H = 92;

function Sparkline({ values, target, behind }: { values: number[]; target: number[] | null; behind: boolean }) {
  const all = [...values, ...(target ?? [])];
  const max = Math.max(...all);
  const min = Math.min(...all);
  const pad = (max - min) * 0.08 || Math.abs(max) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * (W - 8) + 4 : W / 2);
  const y = (v: number) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const stroke = behind ? "#CB2029" : "rgb(var(--c-ink))";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-[92px] w-full" preserveAspectRatio="none" role="img" aria-label="Measured history against the goal line">
      {target && <path d={path(target)} fill="none" stroke="rgb(var(--c-ink-muted))" strokeWidth={1.25} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
      {n > 1 && <path d={path(values)} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      <circle cx={x(n - 1)} cy={y(values[n - 1])} r={2.75} fill={stroke} />
    </svg>
  );
}

function EmptySpark() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-[92px] w-full" preserveAspectRatio="none" aria-hidden>
      <path d={`M2 ${H - 10} L${W - 2} ${H - 10}`} stroke="rgb(var(--c-rule))" strokeWidth={1.25} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-xl bg-creamDeep px-3 py-2.5">
      <p className="text-[12px] font-medium text-inkMuted">{label}</p>
      <p className={`mt-0.5 text-[14px] font-semibold tabular-nums ${value === null ? "text-inkLight" : "text-ink"}`}>{value ?? "No data"}</p>
    </div>
  );
}

function shortDay(iso: string): string {
  const t = Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : iso;
}

export function GoalHistory({
  goal,
  format,
  onAsk,
  now = Date.now(),
}: {
  goal: GrowthGoal;
  format: (v: number) => string;
  onAsk?: (text: string) => void;
  now?: number;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setLoad({ state: "loading" });
    void (async () => {
      try {
        const res = await apiFetch(`/api/workspace/autopilot/goals/${encodeURIComponent(goal.id)}/history`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as GoalHistoryBody;
        if (alive) setLoad({ state: "ready", body: { ...body, points: Array.isArray(body.points) ? body.points : [] } });
      } catch {
        if (alive) setLoad({ state: "failed" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [goal.id, goal.current_value, goal.current_value_at, goal.target_value, goal.due_date, goal.measurement_mode]);

  const body = load.state === "ready" ? load.body : null;
  const points = body?.points ?? [];
  const has = points.length > 0;
  const pace = has ? goalPace(points, goal, now, goal.current_value) : null;
  const target = has ? targetLine(points, goal) : null;
  const behind = pace ? !pace.onPace && format(pace.gap) !== format(0) : false;

  const source = body?.source ?? null;
  const receipt: ReceiptData | null =
    has && body
      ? {
          kind: source === "founder_reported" ? "reported" : "catalog",
          sourceSlug: source ?? undefined,
          label: body.label ?? undefined,
          definition:
            source === "founder_reported"
              ? "The numbers you entered for this goal, each dated when you entered it."
              : `${body.label ?? "This metric"}, measured by Zavi from ${sourceName(source) ?? "the connected source"} once a day${
                  body.window_kind === "rolling_7d" ? " over the last 7 days" : ""
                }.`,
          window: { since: points[0].at.slice(0, 10), until: points[points.length - 1].at.slice(0, 10) },
          fetchedAt: body.last_measured_at ?? undefined,
        }
      : null;

  let verdict: { tone: string; title: string; detail: string };
  if (load.state === "failed") {
    verdict = { tone: "border-rule bg-creamDeep text-inkMuted", title: "History could not be loaded.", detail: "The goal itself is unaffected. Reload the page to try again." };
  } else if (!has) {
    verdict = {
      tone: "border-rule bg-creamDeep text-inkMuted",
      title: "No history yet.",
      detail:
        goal.measurement_mode === "auto"
          ? "Zavi records this goal once a day once its source can read it."
          : "Each number you enter from Edit is dated and drawn here.",
    };
  } else if (goal.trajectory?.kind === "ambiguous") {
    verdict = {
      tone: "border-rule bg-creamDeep text-inkMuted",
      title: "No pace yet.",
      detail: "Zavi can't tell if this number is this period's total or a running level. Say which under Edit, \"How does this number count?\"",
    };
  } else if (goal.trajectory && !goal.trajectory.pace_usable && goal.trajectory.line) {
    verdict = {
      tone: "border-rule bg-creamDeep text-inkMuted",
      title: "No pace from an old number.",
      detail:
        goal.measurement_mode === "auto"
          ? "The connected source has not measured it recently. Zavi judges pace again once it does."
          : "Enter today's number under Edit to see whether it is on pace.",
    };
  } else if (goal.trajectory && !goal.trajectory.line && goal.target_value !== null && goal.due_date) {
    verdict = {
      tone: "border-rule bg-creamDeep text-inkMuted",
      title: "No pace line.",
      detail:
        goal.trajectory.kind === "period_total"
          ? "The due date is before the day this total starts counting. Edit the goal to fix the dates."
          : "The due date is before the day this goal was set. Edit the goal to set a later date.",
    };
  } else if (!pace) {
    verdict = {
      tone: "border-rule bg-creamDeep text-inkMuted",
      title: `${points.length} ${points.length === 1 ? "reading" : "readings"} since ${shortDay(points[0].at)}.`,
      detail: "Add a target and a due date to see whether it is on pace.",
    };
  } else if (pace.daysLeft === 0) {
    verdict = { tone: "border-rule bg-creamDeep text-inkMuted", title: "The due date has passed.", detail: "Edit the goal to set a new date." };
  } else if (!behind) {
    verdict = {
      tone: "border-success/25 bg-successBg text-success",
      title: "On track to hit the goal.",
      detail: `The line from ${shortDay(pace.from ?? points[0].at)} to the goal says ${format(pace.expected)} ${pace.asOf ? `on ${shortDay(pace.asOf)}` : "today"}.`,
    };
  } else {
    verdict = {
      tone: "border-danger/25 bg-dangerBg text-danger",
      title: `Behind pace: about ${format(pace.gap)} short.`,
      detail: `The line from ${shortDay(pace.from ?? points[0].at)} to the goal says ${format(pace.expected)} ${pace.asOf ? `on ${shortDay(pace.asOf)}` : "today"}.`,
    };
  }

  return (
    <div className="mt-4 [container-type:inline-size]" data-testid="goal-history">
    <div className="grid gap-3 [@container(min-width:640px)]:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        {load.state === "loading" ? (
          <div role="status" className="flex h-[62px] items-center gap-2 rounded-xl border border-rule px-3.5 text-[13px] text-inkMuted">
            <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />
            Loading history
          </div>
        ) : (
          <div className={`rounded-xl border px-3.5 py-2.5 ${verdict.tone}`}>
            <p className="text-[14px] font-semibold">{verdict.title}</p>
            <p className="mt-0.5 text-[13px] leading-5">{verdict.detail}</p>
          </div>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Where the line says today" value={pace ? format(pace.expected) : null} />
          <Stat
            label="Needed a week to finish"
            value={pace && pace.daysLeft > 0 ? `${pace.perWeek >= 0 ? "+" : "-"}${format(Math.abs(pace.perWeek))}` : null}
          />
          <Stat label="Days left" value={pace ? String(pace.daysLeft) : null} />
        </div>
      </div>
      <div className="rounded-xl border border-rule p-3">
        <p className="text-[13px] font-semibold text-ink">History</p>
        <div className="mt-2">{has ? <Sparkline values={points.map((p) => p.value)} target={target} behind={behind} /> : <EmptySpark />}</div>
        <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-inkMuted">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className={`h-0.5 w-4 rounded ${behind ? "bg-danger" : "bg-ink"}`} />
            Actual
          </span>
          <span className="inline-flex items-center gap-2">
            <svg width="16" height="4" aria-hidden>
              <path d="M0 2 H16" stroke="rgb(var(--c-ink-muted))" strokeWidth="1.5" strokeDasharray="2 3" />
            </svg>
            Goal line
          </span>
        </div>
        <div className="mt-2 min-h-[22px]">
          {receipt ? (
            <ReceiptChip r={receipt} className="!mx-0" />
          ) : load.state === "loading" ? null : (
            <span className="text-[12px] text-inkMuted">The source appears once there is a reading.</span>
          )}
        </div>
        {onAsk && pace && pace.daysLeft > 0 && (
          <button
            type="button"
            onClick={() =>
              onAsk(behind ? `How do I close the gap on "${goal.objective}"?` : `What is driving "${goal.objective}"?`)
            }
            className="mt-2 inline-flex h-8 items-center rounded-cta bg-ink px-3 text-[13px] font-semibold text-cream hover:bg-inkSoft"
          >
            {behind ? "Ask Zavi how to close the gap" : "Ask Zavi what is driving it"}
          </button>
        )}
      </div>
    </div>
    </div>
  );
}
