"use client";

import { dataSourceForMetric, formatGoalValue, goalProgress, metricLabel } from "../../AutopilotGoalsPanel";
import type { HomeGoal } from "./calmTypes";

function GoalCard({ goal }: { goal: HomeGoal }) {
  const progress = goalProgress(goal);
  const percentage = progress === null ? null : Math.round(progress * 100);
  const current = goal.current_value ?? (goal.status === "met" ? goal.target_value : null);
  const dataSource = dataSourceForMetric(goal.target_metric);
  const sourceLabel = goal.measurement_mode === "auto" ? dataSource.label : "From you";

  return (
    <article
      aria-label={goal.objective}
      className="rounded-[20px] border border-rule bg-bone px-4 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold leading-6 text-ink">{goal.objective}</h3>
          <p className="mt-1 text-[13px] leading-5 text-inkMuted">
            {metricLabel(goal.target_metric)}
            {goal.due_date ? ` · due ${goal.due_date}` : ""}
            {goal.status !== "active" ? ` · ${goal.status}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="text-[16px] leading-5 text-ink">
            <b className="font-semibold">{current === null ? "-" : formatGoalValue(goal, current)}</b>{" "}
            <span className="text-inkMuted">of {formatGoalValue(goal, goal.target_value)}</span>
          </p>
          <p className="text-[13px] font-medium leading-5 text-inkMuted">
            {percentage === null ? "-%" : `${percentage}%`}
          </p>
        </div>
      </div>
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-creamDeep"
        role="progressbar"
        aria-label={`Progress for ${goal.objective}`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percentage === null ? {} : { "aria-valuenow": percentage })}
      >
        <div className="h-full rounded-full bg-ink" style={{ width: `${percentage ?? 0}%` }} />
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px] leading-[18px]">
        <div className="flex gap-2">
          <dt className="text-inkLight">Data source</dt>
          <dd className="text-inkMuted">{sourceLabel}</dd>
        </div>
      </dl>
    </article>
  );
}

export function GoalsSection({
  goals,
  onAddGoal,
}: {
  goals: HomeGoal[];
  onAddGoal?: () => void;
}) {
  const activeCount = goals.filter((g) => g.status === "active").length;

  return (
    <section className="mt-9" aria-label="Goals">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[20px] font-semibold leading-7 text-ink">
          {goals.length === 0 ? "Goals" : `Goals · ${activeCount} active`}
        </h2>
        {onAddGoal && (
          <button
            type="button"
            onClick={onAddGoal}
            className="inline-flex h-10 items-center gap-2 rounded-cta border border-rule bg-bone pl-4 pr-5 text-[16px] font-semibold text-ink transition-colors hover:border-ink/25 hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New goal
          </button>
        )}
      </div>

      {goals.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[20px] border border-dashed border-ink/[0.15] bg-bone px-4 py-8 text-center">
          <p className="text-[16px] text-inkMuted">
            {onAddGoal
              ? "No goals yet. Set your first goal and your team starts tracking it."
              : "No goals yet. An owner or admin sets them."}
          </p>
          {onAddGoal && (
            <button
              type="button"
              onClick={onAddGoal}
              className="cursor-pointer rounded-cta bg-ink px-4 py-2 text-[16px] font-semibold text-cream transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
            >
              + Set your first goal
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} />
          ))}
        </div>
      )}
    </section>
  );
}
