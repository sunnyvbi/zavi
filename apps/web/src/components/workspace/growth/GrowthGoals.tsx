"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, Target, Trash2 } from "lucide-react";
import type {
  GoalWork as GoalWorkData,
  GrowthGoal,
  GrowthGoals as Goals,
  GrowthPlanDetail,
  GrowthPlanRow,
} from "@/lib/workspace/useGrowthPlan";
import { TargetAndFirstSteps } from "./GrowthPlanDetail";
import { GoalWork, SuggestedGoal } from "./GoalWork";
import { GoalHistory } from "./GoalHistory";
import { MoneySourcePicker } from "./MoneySourcePicker";
import { apiFetch } from "@/lib/api";
import { goalCreateBody, parseGoal } from "../home/calm/parseGoal";
import { errorMessageOf } from "../personalization/shared";
import { dataSourceForMetric, formatGoalValue, metricLabel } from "../AutopilotGoalsPanel";
import { goalProgress, humanize, shortDate } from "./growthPresentation";
import { LOADING, type MeasurementNeed } from "./growthHeadline";
import {
  InlineAdd,
  MemoBlock,
  SecondaryButton,
  SectionAction,
  SubLabel,
  SuggestionChip,
} from "./GrowthSection";

export function formatGoalNumber(metric: string, value: number): string {
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  const text = formatGoalValue({ target_metric: metric }, rounded);
  return /\brate\b|percent|%/i.test(metric.replace(/[_-]+/g, " ")) ? `${text}%` : text;
}

export type LiveReadState = "loading" | "measured" | "unmeasured" | "failed";

export type LiveGoalValues = {
  values: ReadonlyMap<string, number>;
  states: ReadonlyMap<string, LiveReadState>;
};

export function liveKey(goal: GrowthGoal): string {
  return goal.measure_source ? `${goal.target_metric}@${goal.measure_source}` : goal.target_metric;
}

export function readsLive(goal: GrowthGoal): boolean {
  return goal.measurement_mode === "auto" && dataSourceForMetric(goal.target_metric).automatic;
}

export function useLiveGoalValues(
  goals: GrowthGoal[],
  retryFailed?: unknown,
  refetchAll?: unknown,
): LiveGoalValues {
  const metrics = Array.from(new Set(goals.filter(readsLive).map(liveKey))).sort();
  const key = metrics.join("|");
  const [result, setResult] = useState<{ key: string; values: Map<string, number>; states: Map<string, LiveReadState> } | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  const lastFull = useRef<{ key: string; all: unknown } | null>(null);
  useEffect(() => {
    if (!key) {
      lastFull.current = null;
      setResult(null);
      return;
    }
    const held = resultRef.current;
    const full =
      held === null ||
      held.key !== key ||
      lastFull.current === null ||
      lastFull.current.key !== key ||
      lastFull.current.all !== refetchAll;
    const settled = (m: string) => {
      const state = held?.states.get(m);
      return state === "measured" || state === "unmeasured";
    };
    const parts = key.split("|").map((p) => {
      const at = p.lastIndexOf("@");
      return at > 0 ? { metric: p.slice(0, at), source: p.slice(at + 1) } : { metric: p, source: null };
    });
    const toRead = parts.filter((p) => full || !settled(p.source ? `${p.metric}@${p.source}` : p.metric));
    if (toRead.length === 0) return;
    let cancelled = false;
    void (async () => {
      const values = new Map<string, number>(full ? [] : held?.values ?? []);
      const states = new Map<string, LiveReadState>(full ? [] : held?.states ?? []);
      await Promise.all(
        toRead.map(async ({ metric: metricText, source }) => {
          const metric = source ? `${metricText}@${source}` : metricText;
          values.delete(metric);
          try {
            const res = await apiFetch(
              `/api/workspace/autopilot/goals/current-value?metric=${encodeURIComponent(metricText)}${source ? `&source=${encodeURIComponent(source)}` : ""}`,
            );
            if (!res.ok) {
              states.set(metric, "failed");
              return;
            }
            const body = (await res.json().catch(() => null)) as {
              measured?: boolean;
              value?: number | null;
            } | null;
            if (body?.measured && typeof body.value === "number") {
              values.set(metric, body.value);
              states.set(metric, "measured");
            } else {
              states.set(metric, body?.measured === false ? "unmeasured" : "failed");
            }
          } catch {
            states.set(metric, "failed");
          }
        }),
      );
      if (cancelled) return;
      if (full) lastFull.current = { key, all: refetchAll };
      setResult({ key, values, states });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, retryFailed, refetchAll]);
  if (result && result.key === key) return result;
  return {
    values: new Map(),
    states: new Map(metrics.map((m) => [m, "loading" as const])),
  };
}

const SOURCE_CONNECTOR: Partial<Record<string, { slug: string; name: string }>> = {
  connected_database: { slug: "operator_db", name: "Your database" },
  stripe: { slug: "stripe", name: "Stripe" },
};

export function goalFix(
  goal: GrowthGoal,
  live: LiveGoalValues,
  connected: readonly string[] | null | undefined,
): MeasurementNeed | null | typeof LOADING {
  const source = dataSourceForMetric(goal.target_metric);
  if (readsLive(goal)) {
    const state = live.states.get(liveKey(goal)) ?? "loading";
    if (state === "loading") return LOADING;
    if (state === "failed") return null;
    if (state === "measured") return { kind: "none" };
  } else {
    if (goal.current_value !== null) return { kind: "none" };
    return { kind: "manual", goalId: goal.id };
  }
  const connector = SOURCE_CONNECTOR[source.key];
  if (!connector) return { kind: "other" };
  if (connected === undefined) return LOADING;
  if (connected === null) return null;
  const has = connected.some((s) => s.replace(/^(?:pipedream|composio)\./, "") === connector.slug);
  return has ? { kind: "other" } : { kind: "connect", ...connector };
}

export function measurementNeed(
  ranked: GrowthGoal[],
  live: LiveGoalValues,
  connected: readonly string[] | null | undefined,
): MeasurementNeed | null | typeof LOADING {
  for (const goal of ranked) {
    const fix = goalFix(goal, live, connected);
    if (fix === LOADING || fix === null) return fix;
    if (fix.kind !== "none") return fix;
  }
  return { kind: "none" };
}

export function withLiveValue(goal: GrowthGoal, live: ReadonlyMap<string, number>): GrowthGoal {
  if (!readsLive(goal)) return goal;
  return { ...goal, current_value: live.get(liveKey(goal)) ?? goal.current_value };
}

export function rankGoals(goals: GrowthGoal[]): GrowthGoal[] {
  return goals
    .map((goal, index) => ({ goal, index }))
    .sort(
      (a, b) =>
        (b.goal.priority ?? Number.NEGATIVE_INFINITY) - (a.goal.priority ?? Number.NEGATIVE_INFINITY) ||
        a.index - b.index,
    )
    .map((x) => x.goal);
}

export function goalTitle(
  goal: GrowthGoal,
  now: Date = new Date(),
  { date = true }: { date?: boolean } = {},
): string | null {
  const metric = goal.target_metric?.trim() ?? "";
  if (goal.target_value === null || !metric) return null;
  const label = humanize(metric);
  const target = formatGoalNumber(metric, goal.target_value);
  const numbers =
    goal.current_value !== null
      ? `${formatGoalNumber(metric, goal.current_value)} / ${target}`
      : `→ ${target}`;
  const due = date && goal.due_date ? ` · by ${shortDate(goal.due_date, now)}` : "";
  return `${label} ${numbers}${due}`;
}

function goalMeta(goal: GrowthGoal, measured: boolean): string {
  const progress = measured ? goalProgress(goal) : null;
  const notCounted = !measured && !goal.counted_as ? NOT_COUNTED_YET : null;
  return [notCounted, progress !== null ? `${progress}%` : null, goal.due_date ? `by ${shortDate(goal.due_date)}` : null, goalNumberSource(goal)]
    .filter(Boolean)
    .join(" · ");
}

export function goalNumberSource(goal: GrowthGoal, now: Date = new Date()): string | null {
  if (goal.counted_as) return `counted daily: ${goal.counted_as}${goal.count_failing ? " (last count failed)" : ""}`;
  if (goal.current_value === null || goal.measurement_mode === "auto") return null;
  const at = goal.current_value_at ? Date.parse(goal.current_value_at) : NaN;
  if (!Number.isFinite(at)) return "entered by you";
  const days = Math.max(0, Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate())) / 86_400_000));
  return days === 0 ? "entered today by you" : `entered ${days} day${days === 1 ? "" : "s"} ago by you`;
}

export const NOT_COUNTED_YET = "Not counted yet";

function FounderEstimate({ goal }: { goal: GrowthGoal }) {
  return goal.founder_estimate ? <span className="mt-1 block text-[12.5px] text-inkMuted">{goal.founder_estimate}.</span> : null;
}

const OTHERS_SHOWN = 2;

export function goalCountLabel(activeCount: number): string {
  return `${activeCount} active`;
}

function chipFor(value: string): string | null {
  const label = metricLabel(value.trim()).trim();
  if (label.length === 0) return null;
  const lowered = /^[A-Z]{2,}/.test(label)
    ? label
    : `${label.slice(0, 1).toLowerCase()}${label.slice(1)}`;
  return `Improve ${lowered}`;
}

export function goalSuggestions(plan: GrowthPlanRow | null): string[] {
  const chips: string[] = [];
  for (const value of [plan?.north_star_metric, plan?.constraint_lever_family]) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const chip = chipFor(value);
    if (chip !== null && !chips.includes(chip)) chips.push(chip);
  }
  return chips;
}

export function GrowthGoals({
  goals,
  plan,
  detail,
  unavailable,
  live,
  connected,
  onEdit,
  onCreate,
  onChanged,
  onAsk,
  work,
  workUnavailable = false,
  building = false,
  canEdit = true,
  removed: removedProp,
  onRemovedChange,
}: {
  goals: Goals;
  work?: Record<string, GoalWorkData>;
  workUnavailable?: boolean;
  building?: boolean;
  plan: GrowthPlanRow | null;
  detail?: GrowthPlanDetail;
  unavailable: boolean;
  live: LiveGoalValues;
  connected: readonly string[] | null | undefined;
  onEdit: (goal: GrowthGoal) => void;
  onCreate: (initialObjective?: string) => void;
  onChanged: () => Promise<void>;
  onAsk?: (text: string) => void;
  canEdit?: boolean;
  removed?: ReadonlySet<string>;
  onRemovedChange?: (id: string, gone: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const del = useGoalDelete({ onChanged, removed: removedProp, onRemovedChange, onError: setError });
  const removed = del.removed;

  const actions = (goal: GrowthGoal) => (
    <div className="flex shrink-0 items-center">
      {canEdit && <GoalEditButton onClick={() => onEdit(goal)} />}
      {canEdit && <GoalDeleteControl goal={goal} del={del} part="button" />}
    </div>
  );

  const confirmRow = (goal: GrowthGoal) => <GoalDeleteControl goal={goal} del={del} part="confirm" />;

  const active = rankGoals(goals.items.filter((goal) => goal.status === "active" && !removed.has(goal.id))).map((g) =>
    withLiveValue(g, live.values),
  );
  const [main, ...rest] = active;
  const suggested = goals.items.find((g) => g.status === "proposed" && g.source === "agent_proposed") ?? null;
  const cap = goals.max_active;
  const atCap = cap !== null && active.length >= cap;
  const suggestions = goalSuggestions(plan);
  const hasWhy = Boolean(detail?.target_rationale?.trim()) || (detail?.first_steps?.length ?? 0) > 0;
  const fixOf = (goal: GrowthGoal) => {
    const fix = goalFix(goal, live, connected);
    return fix === LOADING ? null : fix;
  };
  const isMeasured = (goal: GrowthGoal) => {
    const fix = fixOf(goal);
    return fix ? fix.kind === "none" : goal.current_value !== null;
  };

  const addFromText = async () => {
    const parsed = parseGoal(text);
    if (parsed.target_value === null || parsed.objective.length < 4) {
      onCreate(parsed.objective);
      setText("");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch("/api/home/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goalCreateBody(parsed)),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(errorMessageOf(body, "Could not add that goal."));
        return;
      }
      const body = (await res.json().catch(() => null)) as { warnings?: unknown } | null;
      const warnings = Array.isArray(body?.warnings)
        ? body.warnings.filter((w): w is string => typeof w === "string" && w.length > 0)
        : [];
      setText("");
      await onChanged();
      if (warnings.length > 0) setError(warnings.join(" "));
    } catch (e) {
      setError((e as Error).message || "Could not add that goal.");
    } finally {
      setAdding(false);
    }
  };

  const shown = showAll ? rest : rest.slice(0, OTHERS_SHOWN);
  const hidden = rest.length - OTHERS_SHOWN;

  return (
    <MemoBlock
      n={1}
      title="Goals"
      aside={
        unavailable ? undefined : (
          <span className="text-sm tabular-nums text-inkMuted">{goalCountLabel(active.length)}</span>
        )
      }
    >
      {unavailable ? (
        <p className="text-sm text-inkMuted">Goals could not be loaded.</p>
      ) : (
        <>
          {main ? (
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => onEdit(main)}
                disabled={!canEdit}
                aria-label={`Edit ${main.objective}`}
                title={main.objective}
                className="group block min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default"
              >
                <span className="block break-words text-[26px] font-semibold leading-8 tracking-[-0.015em] text-ink decoration-rule underline-offset-4 group-hover:underline">
                  <GoalLabel goal={main} />
                </span>
                <GoalBar goal={main} measured={isMeasured(main)} size="lead" />
                {goalMeta(main, isMeasured(main)) && (
                  <span className="mt-1.5 block text-[13px] text-inkMuted">{goalMeta(main, isMeasured(main))}</span>
                )}
                <FounderEstimate goal={main} />
              </button>
              {actions(main)}
            </div>
          ) : null}
          {main ? confirmRow(main) : null}
          {main ? <MoneySourcePicker goal={main} canEdit={canEdit} onChanged={onChanged} /> : null}
          {}
          {main ? <GoalHistory goal={main} format={(v) => formatGoalNumber(main.target_metric, v)} onAsk={onAsk} /> : null}
          {main ? (
            <GoalWork work={work?.[main.id]} unavailable={workUnavailable} building={building} onChanged={onChanged} />
          ) : (
            <p className="text-[26px] font-semibold leading-8 tracking-[-0.015em] text-inkMuted">
              No goal yet.
            </p>
          )}

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

          {rest.length > 0 && (
            <ul className="mt-4">
              {shown.map((goal) => (
                <li key={goal.id} className="border-t border-rule">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => onEdit(goal)}
                      disabled={!canEdit}
                      aria-label={`Edit ${goal.objective}`}
                      title={goal.objective}
                      className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 text-left disabled:cursor-default"
                    >
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink decoration-rule underline-offset-4 group-hover:underline">
                        <GoalLabel goal={goal} />
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-[13px] tabular-nums text-inkMuted">
                        {goalMeta(goal, isMeasured(goal))}
                      </span>
                    </button>
                    {actions(goal)}
                  </div>
                  {confirmRow(goal)}
                  <div className="pb-1">
                    <GoalBar goal={goal} measured={isMeasured(goal)} size="row" />
                    <FounderEstimate goal={goal} />
                  </div>
                  <MoneySourcePicker goal={goal} canEdit={canEdit} onChanged={onChanged} />
                  <div className="pb-3">
                    <GoalWork work={work?.[goal.id]} unavailable={workUnavailable} building={building} onChanged={onChanged} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {hidden > 0 && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 text-[13px] font-medium text-inkSoft underline underline-offset-2 hover:text-ink"
            >
              {showAll ? "Show less" : "Show more"}
            </button>
          )}

          {suggested && canEdit && (
            <SuggestedGoal goalId={suggested.id} objective={suggested.objective} onChanged={onChanged} />
          )}

          {canEdit && (
          <div className="mt-5">
            {atCap ? (
              <p className="text-[13px] text-inkMuted">
                {`${cap} goals is the most this plan chases at once. Pause one to add another.`}
              </p>
            ) : (
              <>
                <InlineAdd
                  icon={<Target className="h-4 w-4" />}
                  placeholder="Add a goal, e.g. Lift the repeat rate to 40%"
                  label="Add a goal"
                  value={text}
                  onChange={setText}
                  onSubmit={() => void addFromText()}
                  busy={adding}
                />
                {suggestions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {suggestions.map((s) => (
                      <SuggestionChip key={s} onClick={() => onCreate(s)}>
                        {s}
                      </SuggestionChip>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-warn dark:text-marigold">
              {error}
            </p>
          )}
        </>
      )}
    </MemoBlock>
  );
}

export type GoalDelete = {
  removed: ReadonlySet<string>;
  confirming: string | null;
  setConfirming: (id: string | null) => void;
  remove: (goal: GrowthGoal) => Promise<void>;
};

export function useGoalDelete({
  onChanged,
  removed: removedProp,
  onRemovedChange,
  onError,
}: {
  onChanged: () => Promise<void>;
  removed?: ReadonlySet<string>;
  onRemovedChange?: (id: string, gone: boolean) => void;
  onError: (message: string | null) => void;
}): GoalDelete {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [ownRemoved, setOwnRemoved] = useState<ReadonlySet<string>>(new Set());
  const removed = removedProp ?? ownRemoved;
  const markRemoved = (id: string, gone: boolean) => {
    if (onRemovedChange) return onRemovedChange(id, gone);
    setOwnRemoved((prev) => {
      const next = new Set(prev);
      if (gone) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const remove = async (goal: GrowthGoal) => {
    setConfirming(null);
    onError(null);
    markRemoved(goal.id, true);
    const restore = (message: string) => {
      markRemoved(goal.id, false);
      onError(message);
    };
    try {
      const res = await apiFetch(`/api/workspace/autopilot/goals/${goal.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const body = await res.json().catch(() => null);
        restore(errorMessageOf(body, "Could not delete that goal. Try again."));
        return;
      }
    } catch (e) {
      restore((e as Error).message || "Could not delete that goal. Try again.");
      return;
    }
    void onChanged();
  };
  return { removed, confirming, setConfirming, remove };
}

export function GoalDeleteControl({ goal, del, part }: { goal: GrowthGoal; del: GoalDelete; part: "button" | "confirm" }) {
  if (part === "button") {
    return (
      <button
        type="button"
        aria-label={`Delete ${goal.objective}`}
        title="Delete goal"
        onClick={() => del.setConfirming(goal.id)}
        className="rounded-cta p-1.5 text-inkMuted hover:bg-creamDeep hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:opacity-40"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }
  if (del.confirming !== goal.id) return null;
  return (
    <div
      role="alertdialog"
      aria-label="Delete this goal?"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-danger/30 bg-dangerBg px-3 py-2 dark:bg-danger/10"
    >
      <span className="min-w-0 flex-1 text-[13px] text-ink">
        Delete this goal? Zavi stops working on it. This can&apos;t be undone.
      </span>
      <button
        type="button"
        onClick={() => void del.remove(goal)}
        className="rounded-cta bg-danger px-3 py-1 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        Delete
      </button>
      <SecondaryButton onClick={() => del.setConfirming(null)} className="!px-3 !py-1 text-[13px]">
        Cancel
      </SecondaryButton>
    </div>
  );
}

export function goalBarPercent(goal: GrowthGoal, measured: boolean): number | null {
  if (!measured) return null;
  if (goal.trajectory) return goalProgress(goal);
  const fromBaseline = goalProgress(goal);
  if (fromBaseline !== null) return Math.max(0, Math.min(100, fromBaseline));
  if (goal.current_value === null || goal.target_value === null || goal.target_value <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((goal.current_value / goal.target_value) * 100)));
}

export function GoalBar({ goal, measured, size }: { goal: GrowthGoal; measured: boolean; size: "lead" | "row" }) {
  const pct = goalBarPercent(goal, measured);
  return (
    <span
      role="progressbar"
      aria-label={`${goal.objective} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={pct === null ? (goal.trajectory?.kind === "ambiguous" && goal.current_value !== null ? "No pace yet: how this number counts is not set" : NOT_COUNTED_YET) : `${pct}%`}
      className={`block w-full overflow-hidden rounded-full bg-creamDeep ${size === "lead" ? "mt-3 h-2" : "h-1.5"}`}
    >
      {pct !== null && (
        <span
          className="block h-full rounded-full bg-mintDeep transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      )}
    </span>
  );
}

function GoalEditButton({ onClick }: { onClick: () => void }) {
  return (
    <SectionAction onClick={onClick}>
      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      Edit
    </SectionAction>
  );
}

function GoalLabel({ goal }: { goal: GrowthGoal }) {
  return <>{goalTitle(goal, new Date(), { date: false }) ?? goal.objective}</>;
}

