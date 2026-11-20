"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { GrowthGoal, GrowthGoals as Goals, GrowthPlanDetail, GrowthPlanRow } from "@/lib/workspace/useGrowthPlan";
import { goalPace as historyPace, type GoalHistoryBody } from "./GoalHistory";
import { SuggestedGoal } from "./GoalWork";
import {
  GoalBar,
  GoalDeleteControl,
  goalNumberSource,
  goalSuggestions,
  goalTitle,
  useGoalDelete,
} from "./GrowthGoals";
import { TargetAndFirstSteps } from "./GrowthPlanDetail";
import { LOADING, type MeasurementNeed } from "./growthHeadline";
import { goalProgress, shortDate } from "./growthPresentation";
import { StatusChip, SuggestionChip, type ChipTone } from "./GrowthSection";
import { StoryBox, StoryRow } from "./StoryStep";

const DAY = 86_400_000;

export type HistoryRead = "loading" | "failed" | GoalHistoryBody["points"];

export function useGoalHistories(goals: GrowthGoal[], recheck: unknown): ReadonlyMap<string, HistoryRead> {
  const keyOf = (g: GrowthGoal) => `${g.id}:${g.current_value ?? ""}:${g.target_value ?? ""}:${g.due_date ?? ""}`;
  const keys = goals.map(keyOf);
  const [cache, setCache] = useState<{ recheck: unknown; reads: ReadonlyMap<string, HistoryRead> }>({ recheck, reads: new Map() });
  const valid = cache.recheck === recheck ? cache.reads : new Map<string, HistoryRead>();
  const missing = keys.filter((k) => !valid.has(k)).sort().join("|");
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    const wanted = missing.split("|");
    void (async () => {
      const got = new Map<string, HistoryRead>();
      await Promise.all(
        wanted.map(async (k) => {
          const id = k.split(":")[0];
          try {
            const res = await apiFetch(`/api/workspace/autopilot/goals/${encodeURIComponent(id)}/history`);
            if (!res.ok) {
              got.set(k, "failed");
              return;
            }
            const body = (await res.json().catch(() => null)) as Partial<GoalHistoryBody> | null;
            const points = body?.points;
            got.set(k, Array.isArray(points) ? points : []);
          } catch {
            got.set(k, "failed");
          }
        }),
      );
      if (cancelled) return;
      setCache((prev) => {
        const base = prev.recheck === recheck ? prev.reads : new Map<string, HistoryRead>();
        const next = new Map(base);
        for (const [k, v] of got) next.set(k, v);
        return { recheck, reads: next };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [missing, recheck]);
  return new Map(goals.map((g) => [g.id, valid.get(keyOf(g)) ?? ("loading" as const)]));
}

export type GoalPill = { label: "Met" | "On pace" | "Behind" | "Not counted yet" | "Past due"; tone: ChipTone };

export function goalPill(
  goal: GrowthGoal,
  fix: MeasurementNeed | null | typeof LOADING,
  history: HistoryRead | undefined,
  now: number = Date.now(),
): GoalPill | null | typeof LOADING {
  if (fix === LOADING) return LOADING;
  if (fix !== null && fix.kind !== "none" && goal.current_value === null) return { label: "Not counted yet", tone: "quiet" };
  if (fix === null || goal.current_value === null) return null;
  if (goalProgress(goal) === 100) return { label: "Met", tone: "good" };
  const due = goal.due_date ? Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`) : NaN;
  if (Number.isFinite(due) && due < now) return { label: "Past due", tone: "quiet" };
  if (history === undefined || history === "loading") return LOADING;
  if (history === "failed") return null;
  const pace = historyPace(history, goal, now, goal.current_value);
  if (!pace || pace.daysLeft === 0) return null;
  return pace.onPace ? { label: "On pace", tone: "good" } : { label: "Behind", tone: "bad" };
}

export function goalStatusLine(pills: Array<GoalPill | null>): string | null {
  if (pills.length === 0) return null;
  const count = (label: GoalPill["label"]) => pills.filter((p) => p?.label === label).length;
  const parts: Array<{ n: number; one: string; many: string }> = [
    { n: count("On pace"), one: "on pace", many: "on pace" },
    { n: count("Behind"), one: "behind", many: "behind" },
    { n: count("Met"), one: "met", many: "met" },
    { n: count("Past due"), one: "past due", many: "past due" },
    { n: count("Not counted yet"), one: "is not counted yet", many: "are not counted yet" },
  ].filter((p) => p.n > 0);
  if (parts.length === 0) return null;
  return parts
    .map((p, i) => {
      const noun = i === 0 ? ` ${p.n === 1 ? "goal" : "goals"}` : "";
      return `${p.n}${noun} ${p.n === 1 ? p.one : p.many}.`;
    })
    .join(" ");
}

function daysLeft(goal: GrowthGoal, now: number): string | null {
  if (!goal.due_date) return null;
  const due = Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`);
  if (!Number.isFinite(due) || due < now) return null;
  const n = Math.max(0, Math.ceil((due - now) / DAY));
  return `${n} ${n === 1 ? "day" : "days"} left`;
}

export function useGoalReorder({
  onChanged,
  onError,
}: {
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const arrange = (active: GrowthGoal[]): GrowthGoal[] => {
    if (!order) return active;
    const at = new Map(order.map((id, i) => [id, i]));
    return active
      .map((goal, index) => ({ goal, index }))
      .sort((a, b) => (at.get(a.goal.id) ?? order.length + a.index) - (at.get(b.goal.id) ?? order.length + b.index))
      .map((x) => x.goal);
  };
  const move = async (shown: GrowthGoal[], index: number, by: -1 | 1) => {
    const to = index + by;
    if (saving || to < 0 || to >= shown.length) return;
    const next = [...shown];
    [next[index], next[to]] = [next[to], next[index]];
    onError(null);
    setOrder(next.map((g) => g.id));
    setSaving(true);
    const writes = next
      .map((goal, i) => ({ goal, priority: Math.max(0, 100 - i) }))
      .filter(({ goal, priority }) => goal.priority !== priority);
    try {
      const results = await Promise.all(
        writes.map(({ goal, priority }) =>
          apiFetch(`/api/workspace/autopilot/goals/${encodeURIComponent(goal.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ priority }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) onError("Could not save the new goal order. Try again.");
    } catch {
      onError("Could not save the new goal order. Try again.");
    }
    try {
      await onChanged();
    } finally {
      setOrder(null);
      setSaving(false);
    }
  };
  return { arrange, move, saving };
}

export function StoryGoals({
  goals,
  active,
  pills,
  fixes,
  plan,
  detail,
  unavailable,
  canEdit,
  onEdit,
  onCreate,
  onChanged,
  removed,
  onRemovedChange,
  j6 = false,
}: {
  goals: Goals;
  active: GrowthGoal[];
  pills: ReadonlyMap<string, GoalPill | null>;
  fixes: ReadonlyMap<string, MeasurementNeed | null>;
  plan: GrowthPlanRow | null;
  detail?: GrowthPlanDetail;
  unavailable: boolean;
  canEdit: boolean;
  onEdit: (goal: GrowthGoal) => void;
  onCreate: (initialObjective?: string) => void;
  onChanged: () => Promise<void>;
  removed: ReadonlySet<string>;
  onRemovedChange: (id: string, gone: boolean) => void;
  j6?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const del = useGoalDelete({ onChanged, removed, onRemovedChange, onError: setError });
  const reorder = useGoalReorder({ onChanged, onError: setError });
  const shown = reorder.arrange(active);
  const canReorder = canEdit && shown.length > 1;
  const now = Date.now();
  const suggested = goals.items.find((g) => g.status === "proposed" && g.source === "agent_proposed") ?? null;
  const cap = goals.max_active;
  const atCap = cap !== null && active.length >= cap;
  const suggestions = goalSuggestions(plan);
  const hasWhy = Boolean(detail?.target_rationale?.trim()) || (detail?.first_steps?.length ?? 0) > 0;

  if (unavailable) {
    return (
      <StoryBox>
        <StoryRow>
          <p className="text-sm text-inkMuted">Goals could not be loaded.</p>
        </StoryRow>
      </StoryBox>
    );
  }

  return (
    <>
      <StoryBox>
        {active.length === 0 && (
          <StoryRow>
            <p className="text-[14px] font-semibold text-inkMuted">No goal yet.</p>
          </StoryRow>
        )}
        {shown.map((goal, index) => {
          const fix = fixes.get(goal.id) ?? null;
          const measured = fix ? fix.kind === "none" : goal.current_value !== null;
          const noNumber = fix !== null && fix.kind !== "none";
          const pill = pills.get(goal.id) ?? null;
          const meta = [goalNumberSource(goal), daysLeft(goal, now)].filter(Boolean).join(" · ");
          return (
            <StoryRow key={goal.id}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                {canReorder && (
                  <div className="-ml-1.5 flex shrink-0 flex-col">
                    <button
                      type="button"
                      onClick={() => void reorder.move(shown, index, -1)}
                      disabled={index === 0 || reorder.saving}
                      aria-label={`Move ${goal.objective} up`}
                      title="Move up"
                      className="rounded p-0.5 text-inkMuted hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void reorder.move(shown, index, 1)}
                      disabled={index === shown.length - 1 || reorder.saving}
                      aria-label={`Move ${goal.objective} down`}
                      title="Move down"
                      className="rounded p-0.5 text-inkMuted hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => onEdit(goal)}
                  disabled={!canEdit}
                  aria-label={`Edit ${goal.objective}`}
                  title={goal.objective}
                  className="group min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <span className={`${j6 ? "text-[16px] font-semibold leading-6" : "text-[14px] font-bold"} text-ink decoration-rule underline-offset-4 group-hover:underline`}>
                    {goalTitle(goal, new Date(now), { date: false }) ?? goal.objective}
                  </span>
                  {goal.due_date && (
                    <span className={j6 ? "ml-1 text-[16px] leading-6 text-inkMuted" : "ml-1.5 text-[13px] text-inkMuted"}>{`by ${shortDate(goal.due_date)}`}</span>
                  )}
                </button>
                <div className={`flex shrink-0 items-center ${j6 ? "gap-3" : "gap-2"}`}>
                  {pill && <StatusChip tone={pill.tone}>{pill.label}</StatusChip>}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(goal)}
                      className={
                        j6
                          ? "inline-flex min-h-9 items-center gap-1.5 rounded-full border border-ink/15 bg-cream px-3.5 text-[14px] font-semibold leading-5 text-ink hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted"
                          : "inline-flex items-center gap-1 rounded-full border border-rule px-3 py-1 text-[13px] font-semibold text-ink hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted"
                      }
                    >
                      {noNumber ? (
                        "Enter today's number"
                      ) : (
                        <>
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                          Edit
                        </>
                      )}
                    </button>
                  )}
                  {canEdit && <GoalDeleteControl goal={goal} del={del} part="button" />}
                </div>
              </div>
              <div className={j6 ? "mt-3" : "mt-2.5"}>
                <GoalBar goal={goal} measured={measured} size="row" />
              </div>
              {meta && <p className={j6 ? "mt-2 text-[14px] leading-5 text-inkMuted" : "mt-1.5 text-[13px] text-inkMuted"}>{meta}</p>}
              {goal.current_value === null && goal.founder_estimate && (
                <p className="mt-1 text-[12.5px] text-inkMuted">{goal.founder_estimate}.</p>
              )}
              <GoalDeleteControl goal={goal} del={del} part="confirm" />
            </StoryRow>
          );
        })}
        {canEdit && (
          <StoryRow className={j6 ? "py-3" : "py-2.5"}>
            {atCap ? (
              <p className="text-[13px] text-inkMuted">
                {`${cap} goals is the most this plan chases at once. Pause one to add another.`}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onCreate()}
                  className={
                    j6
                      ? "inline-flex min-h-9 items-center gap-1.5 rounded-full border border-transparent px-3.5 text-[14px] font-semibold leading-5 text-ink hover:bg-creamDeep"
                      : "inline-flex items-center gap-1 text-[13px] font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
                  }
                >
                  <Plus className={j6 ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
                  Add a goal
                </button>
                {suggestions.map((s) =>
                  j6 ? (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onCreate(s)}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-ink/15 px-3.5 text-[14px] font-medium leading-5 text-inkSoft hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted"
                    >
                      <Plus className="h-4 w-4 text-inkMuted" aria-hidden="true" />
                      {s}
                    </button>
                  ) : (
                    <SuggestionChip key={s} onClick={() => onCreate(s)}>
                      {s}
                    </SuggestionChip>
                  ),
                )}
              </div>
            )}
          </StoryRow>
        )}
      </StoryBox>
      {hasWhy && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={whyOpen}
            onClick={() => setWhyOpen((v) => !v)}
            className="text-[13px] text-inkMuted underline-offset-2 hover:text-ink hover:underline"
          >
            {whyOpen ? "Hide why" : "Why this target"}
          </button>
          {whyOpen && (
            <div className="mt-2">
              <TargetAndFirstSteps detail={detail} />
            </div>
          )}
        </div>
      )}
      {suggested && canEdit && <SuggestedGoal goalId={suggested.id} objective={suggested.objective} onChanged={onChanged} />}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger dark:text-coral">
          {error}
        </p>
      )}
    </>
  );
}

