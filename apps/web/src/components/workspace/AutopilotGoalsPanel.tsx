"use client";

import {
  CalendarDays,
  Check,
  Filter,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { detectGoalJunk } from "@/lib/goal-junk";
import { Skeleton } from "./Skeleton";
import styles from "./AutopilotGoalsPanel.module.css";
import type { GoalTrajectory } from "@/lib/workspace/goalTrajectory";
import {
  CUSTOM_METRIC,
  GOAL_METRIC_OPTIONS,
  findMetricOption,
} from "./goalMetricOptions";

type GoalStatus = "active" | "paused" | "met" | "missed";

export type Goal = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  status: GoalStatus;
  priority: number;
  source: string;
  created_at: string;
  updated_at: string;
  measurement_mode?: string | null;
  value_kind?: string | null;
  value_period_start?: string | null;
  trajectory?: GoalTrajectory;
};

type GoalsResponse = { enabled: boolean; goals: Goal[] };
type GoalFilter = "active" | "completed" | "all";

const MAX_ACTIVE_GOALS = 20;

const FILTER_LABEL: Record<GoalFilter, string> = {
  active: "Active",
  completed: "Completed",
  all: "All",
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function goalProgress(
  goal: Pick<Goal, "status" | "current_value" | "target_value" | "trajectory">,
): number | null {
  if (goal.status === "met") return 1;
  if (goal.trajectory) return goal.trajectory.progress;
  if (goal.current_value === null) return null;
  if (goal.target_value === 0) return null;
  return clamp(goal.current_value / goal.target_value);
}

function isCurrencyMetric(metric: string) {
  const option = findMetricOption(metric);
  if (option) return option.unit === "usd";
  return /\b(mrr|arr|gmv|revenue|sales|income|earnings)\b/i.test(metric) || isMoneyMetric(metric);
}

export function formatGoalValue(
  goal: Pick<Goal, "target_metric">,
  value: number,
) {
  return new Intl.NumberFormat("en-US", {
    ...(isCurrencyMetric(goal.target_metric)
      ? { style: "currency" as const, currency: "USD" }
      : {}),
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function formatDueDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function metricLabel(metric: string) {
  const option = findMetricOption(metric);
  if (option?.value === "mrr") return "Monthly recurring revenue";
  if (option?.value === "arr") return "Annual recurring revenue";
  const label =
    option?.label.replace(/\s*\(.*\)$/, "") ?? metric.replaceAll("_", " ");
  return label.length > 0
    ? `${label[0].toUpperCase()}${label.slice(1)}`
    : metric;
}

export type GoalDataSource = {
  key:
    | "stripe"
    | "connected_data"
    | "connected_database"
    | "product_analytics"
    | "money"
    | "manual";
  label: string;
  automatic: boolean;
};

export function isMoneyMetric(metric: string): boolean {
  const m = (metric ?? "").toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\brates?\b|%|\bpercent|\bratio\b|\baverage\b|\bavg\b|\baov\b|\barpu\b|\bltv\b/.test(m)) return false;
  return /\bgmv\b|\bgross merchandise\b|\bgross bookings?\b|\b(booked|booking|bookings|order|orders|sales|rental|rentals|reservation|reservations|trip|trips) (value|volume|amount|revenue|dollars?)\b/.test(m);
}

export function dataSourceForMetric(metric: string): GoalDataSource {
  const normalized = (metric ?? "").toLowerCase().replace(/[_\-./]+/g, " ");
  if (isMoneyMetric(metric)) {
    return { key: "money", label: "Bookings database or Stripe", automatic: true };
  }
  if (/book|rental|reservation|\btrip/.test(normalized)) {
    return {
      key: "connected_database",
      label: "Connected database",
      automatic: true,
    };
  }
  if (/\b(?:mrr|arr)\b/.test(normalized)) {
    return { key: "stripe", label: "Stripe", automatic: true };
  }
  if (/sign\s?up/.test(normalized)) {
    return { key: "connected_data", label: "Connected data", automatic: true };
  }
  if (/activat|purchase|order|sale|key\s?action/.test(normalized)) {
    return {
      key: "product_analytics",
      label: "Product analytics",
      automatic: true,
    };
  }
  return { key: "manual", label: "Manual", automatic: false };
}

function errorMessage(body: unknown, fallback: string) {
  const value = body as { error?: { message?: string } } | null;
  return value?.error?.message ?? fallback;
}

function GoalCard({
  goal,
  busy,
  error,
  onEdit,
  onMutate,
}: {
  goal: Goal;
  busy: boolean;
  error: string | null;
  onEdit: () => void;
  onMutate: (method: "PATCH" | "DELETE", patch?: object) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menu = useDismissableMenu(menuRef, menuButtonRef);
  const menuOpen = menu.open;
  const runAction = (fn: () => void) => {
    menu.close(false);
    fn();
  };
  const progress = goalProgress(goal);
  const percentage = progress === null ? null : Math.round(progress * 100);
  const displayedCurrent =
    goal.current_value ?? (goal.status === "met" ? goal.target_value : null);
  const dataSource = dataSourceForMetric(goal.target_metric);

  return (
    <article className={styles.card} aria-label={goal.objective}>
      <div className={styles.cardHeading}>
        <h3 className={styles.goalTitle}>{goal.objective}</h3>
        <div ref={menuRef} className={styles.cardMenuAnchor}>
          <button
            ref={menuButtonRef}
            type="button"
            aria-label={`Actions for ${goal.objective}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={menu.toggle}
            className={styles.cardMenuButton}
          >
            <MoreHorizontal aria-hidden size={20} strokeWidth={1.8} />
          </button>

          {menuOpen && (
            <div className={styles.cardMenu} role="menu">
              {goal.status === "active" && (
                <>
                  <button type="button" role="menuitem" onClick={() => runAction(onEdit)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => runAction(() => onMutate("PATCH", { status: "paused" }))}
                  >
                    Pause
                  </button>
                </>
              )}
              {goal.status === "paused" && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => runAction(() => onMutate("PATCH", { status: "active" }))}
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete this goal? This cannot be undone.")) {
                    runAction(() => onMutate("DELETE"));
                  } else {
                    menu.close();
                  }
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={styles.metricBlock}>
        <p className={styles.detailLabel}>Metric</p>
        <p className={styles.detailValue}>{metricLabel(goal.target_metric)}</p>
      </div>

      <div className={styles.progressHeader}>
        <p className={styles.currentAndTarget}>
          <strong>
            {displayedCurrent === null
              ? "-"
              : formatGoalValue(goal, displayedCurrent)}
          </strong>{" "}
          <span>of {formatGoalValue(goal, goal.target_value)}</span>
        </p>
        <p className={styles.percentage}>
          {percentage === null ? "-%" : `${percentage}%`}
        </p>
      </div>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-label={`Progress for ${goal.objective}`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percentage === null ? {} : { "aria-valuenow": percentage })}
      >
        <div
          className={styles.progressFill}
          style={{ width: `${percentage ?? 0}%` }}
        />
      </div>

      <dl className={styles.cardFooter}>
        <div>
          <dt>Data source</dt>
          <dd>{dataSource.label}</dd>
        </div>
        <div className={styles.dueDate}>
          <div>
            <dt>Due date</dt>
            <dd>
              {goal.due_date ? formatDueDate(goal.due_date) : "No due date"}
            </dd>
          </div>
          <CalendarDays aria-hidden size={21} strokeWidth={1.7} />
        </div>
      </dl>

      {error && (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export function AutopilotGoalsPanel() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GoalFilter>("active");
  const [editorGoal, setEditorGoal] = useState<Goal | null | "new">(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const mounted = useRef(true);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const filterMenu = useDismissableMenu(filterRef, filterButtonRef);
  const filterOpen = filterMenu.open;

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiFetch("/api/workspace/autopilot/goals");
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setLoadError(errorMessage(body, `HTTP ${response.status}`));
        return;
      }
      const payload = (await response.json()) as GoalsResponse;
      if (mounted.current) setGoals(payload.goals ?? []);
    } catch (error) {
      if (mounted.current) {
        setLoadError((error as Error).message || "Unknown error");
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeCount = goals.filter((goal) => goal.status === "active").length;
  const visibleGoals = useMemo(
    () =>
      goals.filter((goal) => {
        if (filter === "all") return true;
        if (filter === "completed") {
          return goal.status === "met" || goal.status === "missed";
        }
        return goal.status === "active";
      }),
    [filter, goals],
  );

  async function mutateGoal(
    id: string,
    method: "PATCH" | "DELETE",
    patch?: object,
  ) {
    if (rowBusy) return false;
    setRowBusy(id);
    setRowError(null);
    try {
      const response = await apiFetch(`/api/workspace/autopilot/goals/${id}`, {
        method,
        ...(patch
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            }
          : {}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setRowError({
          id,
          message: errorMessage(body, `HTTP ${response.status}`),
        });
        return false;
      }
      window.dispatchEvent(new Event("autopilot:goals-changed"));
      await load();
      return true;
    } catch (error) {
      setRowError({
        id,
        message: (error as Error).message || "Unknown error",
      });
      return false;
    } finally {
      if (mounted.current) setRowBusy(null);
    }
  }

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <h1>Goals</h1>
        <div className={styles.headerActions} ref={filterRef}>
          <button
            ref={filterButtonRef}
            type="button"
            aria-label={`Filter goals. ${FILTER_LABEL[filter]} selected`}
            aria-expanded={filterOpen}
            aria-haspopup="menu"
            title={`${FILTER_LABEL[filter]} goals`}
            onClick={filterMenu.toggle}
            className={styles.iconButton}
          >
            <Filter aria-hidden size={20} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="Create goal"
            title="Create goal"
            onClick={() => {
              filterMenu.close(false);
              setEditorGoal("new");
            }}
            disabled={activeCount >= MAX_ACTIVE_GOALS}
            className={styles.iconButton}
          >
            <Plus aria-hidden size={23} strokeWidth={1.8} />
          </button>

          {filterOpen && (
            <div
              className={styles.filterMenu}
              role="menu"
              aria-label="Goal status"
            >
              {(["active", "completed", "all"] as GoalFilter[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filter === item}
                  onClick={() => {
                    setFilter(item);
                    filterMenu.close();
                  }}
                >
                  <span>{FILTER_LABEL[item]}</span>
                  {filter === item && (
                    <Check aria-hidden size={18} strokeWidth={1.8} />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {loading ? (
        <div
          aria-label="Loading goals"
          aria-busy="true"
          className={styles.cards}
        >
          {[0, 1].map((item) => (
            <div key={item} className={styles.skeletonCard}>
              <Skeleton className="h-6 w-3/5" />
              <Skeleton className="mt-5 h-4 w-2/5" />
              <Skeleton className="mt-8 h-3 w-full" rounded="rounded-full" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <div className={styles.messageCard} role="alert">
          <p>Couldn&apos;t load goals: {loadError}</p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : visibleGoals.length === 0 ? (
        <div className={styles.emptyState}>
          <p>
            {filter === "active"
              ? "No active goals yet."
              : filter === "completed"
                ? "No completed goals yet."
                : "No goals yet."}
          </p>
          <span>
            {filter === "active"
              ? "Create a measurable goal for your team to work toward."
              : "Choose another filter to see your goals."}
          </span>
        </div>
      ) : (
        <div className={styles.cards}>
          {visibleGoals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              busy={rowBusy === goal.id}
              error={rowError?.id === goal.id ? rowError.message : null}
              onEdit={() => setEditorGoal(goal)}
              onMutate={(method, patch) =>
                void mutateGoal(goal.id, method, patch)
              }
            />
          ))}
        </div>
      )}

      {activeCount >= MAX_ACTIVE_GOALS && (
        <p className={styles.limitMessage}>
          You have reached the limit of {MAX_ACTIVE_GOALS} active goals. Pause
          one before creating another.
        </p>
      )}

      {editorGoal !== null && (
        <GoalEditor
          goal={editorGoal === "new" ? null : editorGoal}
          onClose={() => setEditorGoal(null)}
          onSaved={async () => {
            setEditorGoal(null);
            window.dispatchEvent(new Event("autopilot:goals-changed"));
            await load();
          }}
        />
      )}
    </div>
  );
}

type LiveValue = {
  metric: string;
  loading: boolean;
  measured: boolean;
  value?: number;
  source_label: string;
  reason?: string;
  failed?: boolean;
};

type GoalFormErrors = Partial<
  Record<
    "objective" | "metric" | "currentValue" | "targetValue" | "dueDate",
    string
  >
>;

export function validateGoalForm(input: {
  objective: string;
  metric: string;
  currentValue: string;
  targetValue: string;
  dueDate: string;
  currentRequired: boolean;
}): GoalFormErrors {
  const errors: GoalFormErrors = {};
  const objective = input.objective.trim();
  const metric = input.metric.trim();
  const target = Number(input.targetValue);

  if (!objective) errors.objective = "Enter a goal name.";
  else if (objective.length < 8) {
    errors.objective = "Use at least 8 characters so the goal is clear.";
  } else if (objective.length > 500) {
    errors.objective = "Goal names can be up to 500 characters.";
  }

  if (!metric) errors.metric = "Select or enter a metric.";
  else if (metric.length < 2) errors.metric = "Use at least 2 characters.";
  else if (metric.length > 120) {
    errors.metric = "Metrics can be up to 120 characters.";
  }

  if (!input.targetValue.trim()) errors.targetValue = "Enter a target value.";
  else if (!Number.isFinite(target) || target <= 0) {
    errors.targetValue = "Target value must be greater than zero.";
  }

  if (input.currentRequired || input.currentValue.trim()) {
    const current = Number(input.currentValue);
    if (!input.currentValue.trim()) {
      errors.currentValue = "Enter the current value.";
    } else if (!Number.isFinite(current)) {
      errors.currentValue = "Current value must be a number.";
    }
  }

  if (!input.dueDate) errors.dueDate = "Choose a due date.";
  else if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ||
    !Number.isFinite(Date.parse(input.dueDate))
  ) {
    errors.dueDate = "Choose a valid due date.";
  }

  if (!errors.objective && !errors.metric && !errors.targetValue) {
    const junkReason = detectGoalJunk({
      objective,
      target_metric: metric,
      target_value: target,
    });
    if (junkReason) errors.objective = junkReason;
  }

  return errors;
}

function FieldError({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return (
    <p id={id} className={styles.fieldError} role="alert">
      {children}
    </p>
  );
}

export function GoalEditor({
  goal,
  onClose,
  onSaved,
  initialObjective,
  onPause,
  history,
}: {
  goal: Goal | null;
  history?: ReactNode;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onPause?: () => Promise<void>;
  initialObjective?: string;
}) {
  const isEdit = goal !== null;
  const existingOption = goal
    ? findMetricOption(goal.target_metric)
    : undefined;
  const [objective, setObjective] = useState(
    goal?.objective ?? initialObjective ?? "",
  );
  const [metricChoice, setMetricChoice] = useState(
    goal ? (existingOption ? goal.target_metric : CUSTOM_METRIC) : "",
  );
  const [customMetric, setCustomMetric] = useState(
    goal && !existingOption ? goal.target_metric : "",
  );
  const [currentValue, setCurrentValue] = useState(
    goal?.current_value === null || !goal ? "" : String(goal.current_value),
  );
  const [targetValue, setTargetValue] = useState(
    goal ? String(goal.target_value) : "",
  );
  const [dueDate, setDueDate] = useState(goal?.due_date?.slice(0, 10) ?? "");
  const [valueKind, setValueKind] = useState<"" | "gauge" | "period_total">(
    goal?.value_kind === "gauge" || goal?.value_kind === "period_total" ? goal.value_kind : "",
  );
  const [periodStart, setPeriodStart] = useState(goal?.value_period_start?.slice(0, 10) ?? "");
  const [kindMetric, setKindMetric] = useState<string | null>(goal?.target_metric ?? null);
  const [errors, setErrors] = useState<GoalFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const savingRef = useRef(saving);
  savingRef.current = saving;

  const effectiveMetric =
    metricChoice === CUSTOM_METRIC ? customMetric.trim() : metricChoice;
  const dataSource = dataSourceForMetric(effectiveMetric);
  const currentRequired = effectiveMetric.length > 0 && !dataSource.automatic;
  const shownKind: "" | "gauge" | "period_total" = kindMetric !== effectiveMetric ? "" : valueKind;
  useEffect(() => {
    if (!goal || effectiveMetric !== goal.target_metric || kindMetric === effectiveMetric) return;
    setValueKind(goal.value_kind === "gauge" || goal.value_kind === "period_total" ? goal.value_kind : "");
    setPeriodStart(goal.value_period_start?.slice(0, 10) ?? "");
    setKindMetric(goal.target_metric);
  }, [goal, effectiveMetric, kindMetric]);
  const [liveValue, setLiveValue] = useState<LiveValue | null>(null);
  const [pulledValue, setPulledValue] = useState<number | null>(null);
  useEffect(() => {
    setPulledValue(null);
  }, [effectiveMetric]);
  const [savedWarning, setSavedWarning] = useState<string | null>(null);
  const dismiss = useCallback(() => {
    if (savedWarning) void onSaved();
    else onClose();
  }, [savedWarning, onSaved, onClose]);
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const initialCurrent =
    goal?.current_value === null || !goal ? "" : String(goal.current_value);

  useEffect(() => {
    if (!effectiveMetric || !dataSource.automatic) {
      setLiveValue(null);
      return;
    }
    let cancelled = false;
    setLiveValue({ metric: effectiveMetric, loading: true, measured: false, source_label: dataSource.label });
    const timer = setTimeout(async () => {
      try {
        const response = await apiFetch(
          `/api/workspace/autopilot/goals/current-value?metric=${encodeURIComponent(effectiveMetric)}`,
        );
        const body = (await response.json().catch(() => null)) as
          | { measured?: boolean; value?: number; source_label?: string; reason?: string }
          | null;
        if (cancelled) return;
        if (!response.ok || !body) {
          setLiveValue({ metric: effectiveMetric, loading: false, measured: false, source_label: dataSource.label, failed: true });
          return;
        }
        setLiveValue({
          metric: effectiveMetric,
          loading: false,
          measured: body.measured === true && typeof body.value === "number",
          value: typeof body.value === "number" ? body.value : undefined,
          source_label: body.source_label ?? dataSource.label,
          reason: body.reason,
        });
      } catch {
        if (!cancelled) {
          setLiveValue({ metric: effectiveMetric, loading: false, measured: false, source_label: dataSource.label, failed: true });
        }
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [effectiveMetric, dataSource.automatic, dataSource.label]);

  useEffect(() => {
    if (currentRequired) return;
    setErrors((current) => {
      if (!current.currentValue) return current;
      const next = { ...current };
      delete next.currentValue;
      return next;
    });
  }, [currentRequired]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => firstInputRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      requestAnimationFrame(() => {
        if (!dialogRef.current?.isConnected) previousFocus?.focus();
      });
    };
  }, []);

  function clearError(field: keyof GoalFormErrors) {
    setServerError(null);
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function validateOne(field: keyof GoalFormErrors) {
    const next = validateGoalForm({
      objective,
      metric: effectiveMetric,
      currentValue,
      targetValue,
      dueDate,
      currentRequired,
    });
    setErrors((current) => ({ ...current, [field]: next[field] }));
  }

  async function save() {
    if (saving) return;
    if (savedWarning) {
      await onSaved();
      return;
    }
    const nextErrors = validateGoalForm({
      objective,
      metric: effectiveMetric,
      currentValue,
      targetValue,
      dueDate,
      currentRequired,
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      requestAnimationFrame(() => {
        dialogRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus();
      });
      return;
    }

    setSaving(true);
    setServerError(null);
    const typed = currentValue.trim();
    const usedSource = pulledValue !== null && typed !== "" && Number(typed) === pulledValue;
    const changed = typed !== initialCurrent;
    const metricChanged = isEdit && effectiveMetric !== goal.target_metric;
    const reported =
      typed !== "" &&
      Number.isFinite(Number(typed)) &&
      (usedSource || changed || metricChanged || currentRequired || !isEdit)
        ? Number(typed)
        : null;
    const measurementMode = usedSource
      ? "auto"
      : reported !== null || metricChanged
        ? "manual_reported"
        : undefined;
    const baseline =
      goal?.baseline_value ?? (reported !== null ? reported : null);
    const payload = {
      objective: objective.trim(),
      target_metric: effectiveMetric,
      target_value: Number(targetValue),
      baseline_value: baseline,
      due_date: dueDate,
      priority: goal?.priority ?? 50,
      ...(reported !== null ? { current_value: reported } : {}),
      ...(measurementMode ? { measurement_mode: measurementMode } : {}),
      ...(measurementMode === "auto" || (!measurementMode && goal?.measurement_mode === "auto") || kindMetric !== effectiveMetric
        ? {}
        : isEdit || valueKind
          ? {
              value_kind: valueKind || null,
              value_period_start: valueKind === "period_total" ? periodStart || null : null,
            }
          : {}),
    };

    try {
      const response = await apiFetch(
        isEdit
          ? `/api/workspace/autopilot/goals/${goal.id}`
          : "/api/workspace/autopilot/goals",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setServerError(errorMessage(body, `HTTP ${response.status}`));
        return;
      }
      const saved = (await response.json().catch(() => null)) as { warnings?: unknown } | null;
      const warnings = Array.isArray(saved?.warnings)
        ? saved.warnings.filter((w): w is string => typeof w === "string" && w.length > 0)
        : [];
      if (warnings.length > 0) {
        setSavedWarning(warnings.join(" "));
        return;
      }
      await onSaved();
    } catch (saveError) {
      setServerError((saveError as Error).message || "Unknown error");
    } finally {
      if (dialogRef.current?.isConnected) setSaving(false);
    }
  }

  const describedBy = (field: keyof GoalFormErrors) =>
    errors[field] ? `${field}-error` : undefined;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) dismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-editor-title"
        aria-describedby="goal-editor-description"
        className={styles.drawer}
      >
        <div className={styles.drawerHeader}>
          <div>
            <h2 id="goal-editor-title">
              {isEdit ? "Edit goal" : "Create goal"}
            </h2>
            <p id="goal-editor-description">
              Set a clear outcome and the number that defines success.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={dismiss}
            disabled={saving}
            className={styles.closeButton}
          >
            <X aria-hidden size={20} strokeWidth={1.8} />
          </button>
        </div>

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className={styles.formBody}>
            <label className={styles.field}>
              <span>
                Goal name <i aria-hidden>*</i>
              </span>
              <input
                ref={firstInputRef}
                type="text"
                value={objective}
                onChange={(event) => {
                  setObjective(event.target.value);
                  clearError("objective");
                }}
                onBlur={() => validateOne("objective")}
                placeholder="e.g. Reach $100K MRR"
                maxLength={500}
                required
                aria-label="Goal name"
                aria-invalid={Boolean(errors.objective)}
                aria-describedby={describedBy("objective")}
                className={styles.control}
              />
              <FieldError id="objective-error">{errors.objective}</FieldError>
            </label>

            <label className={styles.field}>
              <span>
                Metric <i aria-hidden>*</i>
              </span>
              <select
                value={metricChoice}
                onChange={(event) => {
                  setMetricChoice(event.target.value);
                  clearError("metric");
                }}
                onBlur={() => validateOne("metric")}
                required
                aria-label="Metric"
                aria-invalid={Boolean(errors.metric)}
                aria-describedby={describedBy("metric")}
                className={styles.control}
              >
                <option value="">Select a metric</option>
                {GOAL_METRIC_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                <option value={CUSTOM_METRIC}>Something else…</option>
              </select>
              {metricChoice !== CUSTOM_METRIC && (
                <FieldError id="metric-error">{errors.metric}</FieldError>
              )}
            </label>

            {metricChoice === CUSTOM_METRIC && (
              <label className={styles.field}>
                <span>
                  Metric name <i aria-hidden>*</i>
                </span>
                <input
                  type="text"
                  value={customMetric}
                  onChange={(event) => {
                    setCustomMetric(event.target.value);
                    clearError("metric");
                  }}
                  onBlur={() => validateOne("metric")}
                  placeholder="e.g. Verified hosts"
                  maxLength={120}
                  required
                  aria-label="Metric name"
                  aria-invalid={Boolean(errors.metric)}
                  aria-describedby={describedBy("metric")}
                  className={styles.control}
                />
                <FieldError id="metric-error">{errors.metric}</FieldError>
              </label>
            )}

            <label className={styles.field}>
              <span>Data source</span>
              <input
                type="text"
                value={
                  effectiveMetric ? dataSource.label : "Select a metric first"
                }
                readOnly
                aria-label="Data source"
                aria-readonly="true"
                className={`${styles.control} ${styles.readOnlyControl}`}
              />
              <small>
                {effectiveMetric
                  ? dataSource.automatic
                    ? "Matched automatically to the selected metric."
                    : "This metric is updated manually."
                  : "The source is determined by the metric you choose."}
              </small>
            </label>

            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>
                  Current value{currentRequired ? <i aria-hidden> *</i> : null}
                </span>
                <input
                  type="number"
                  value={currentValue}
                  placeholder={!effectiveMetric ? "Select a metric first" : undefined}
                  onChange={(event) => {
                    setCurrentValue(event.target.value);
                    clearError("currentValue");
                  }}
                  onBlur={() => validateOne("currentValue")}
                  required={currentRequired}
                  aria-label="Current value"
                  aria-invalid={Boolean(errors.currentValue)}
                  aria-describedby={describedBy("currentValue")}
                  className={styles.control}
                />
                <FieldError id="currentValue-error">
                  {errors.currentValue}
                </FieldError>
                {dataSource.automatic ? (
                  <small>
                    {liveValue?.loading ? (
                      `Reading from ${liveValue.source_label}…`
                    ) : liveValue?.measured && liveValue.value !== undefined ? (
                      <>
                        {`${liveValue.source_label} reads ${formatGoalValue({ target_metric: effectiveMetric }, liveValue.value)}. `}
                        <button
                          type="button"
                          onClick={() => {
                            const v = liveValue.value as number;
                            setCurrentValue(String(v));
                            setPulledValue(v);
                            clearError("currentValue");
                          }}
                          style={{ textDecoration: "underline", textUnderlineOffset: 2 }}
                        >
                          Use it
                        </button>
                      </>
                    ) : liveValue?.failed ? (
                      `Could not reach ${liveValue.source_label} right now. You can type the number.`
                    ) : (
                      `${liveValue?.source_label ?? dataSource.label} can read this once it is connected. Until then, type the number.`
                    )}
                  </small>
                ) : currentRequired ? (
                  <small>
                    Nothing Zavi is connected to can count this, so it will ask
                    you for it. Update it here whenever you know a newer number.
                  </small>
                ) : null}
              </label>

              <label className={styles.field}>
                <span>
                  Target value <i aria-hidden>*</i>
                </span>
                <input
                  type="number"
                  value={targetValue}
                  onChange={(event) => {
                    setTargetValue(event.target.value);
                    clearError("targetValue");
                  }}
                  onBlur={() => validateOne("targetValue")}
                  placeholder="100000"
                  required
                  aria-label="Target value"
                  aria-invalid={Boolean(errors.targetValue)}
                  aria-describedby={describedBy("targetValue")}
                  className={styles.control}
                />
                <FieldError id="targetValue-error">
                  {errors.targetValue}
                </FieldError>
              </label>
            </div>

            <label className={styles.field}>
              <span>
                Due date <i aria-hidden>*</i>
              </span>
              <input
                type="date"
                value={dueDate}
                onChange={(event) => {
                  setDueDate(event.target.value);
                  clearError("dueDate");
                }}
                onBlur={() => validateOne("dueDate")}
                required
                aria-label="Due date"
                aria-invalid={Boolean(errors.dueDate)}
                aria-describedby={describedBy("dueDate")}
                className={styles.control}
              />
              <FieldError id="dueDate-error">{errors.dueDate}</FieldError>
            </label>

            {!(pulledValue !== null && currentValue.trim() !== "" && Number(currentValue) === pulledValue) &&
            !(isEdit && goal?.measurement_mode === "auto" && effectiveMetric === goal.target_metric) ? (
              <label className={styles.field}>
                <span>How does this number count?</span>
                <select
                  value={shownKind}
                  onChange={(event) => {
                    const next = event.target.value as "" | "gauge" | "period_total";
                    setKindMetric(effectiveMetric);
                    setValueKind(next);
                    if (next === "period_total" && !periodStart) setPeriodStart(`${new Date().toISOString().slice(0, 7)}-01`);
                  }}
                  aria-label="How does this number count?"
                  className={styles.control}
                >
                  <option value="">Not said yet</option>
                  <option value="gauge">A running number (it started at the baseline)</option>
                  <option value="period_total">A total that starts again at 0 (for example, this month)</option>
                </select>
                {shownKind === "period_total" ? (
                  <input
                    type="date"
                    value={periodStart}
                    onChange={(event) => setPeriodStart(event.target.value)}
                    aria-label="Counted from"
                    className={styles.control}
                  />
                ) : null}
                <small>
                  {shownKind === "period_total"
                    ? "Counted from 0 on this day. Pace runs from 0 to the target by the due date."
                    : shownKind === "gauge"
                      ? "Pace runs from the baseline to the target by the due date."
                      : "Zavi shows no pace for a number that could be either, so it is never wrong about it."}
                </small>
              </label>
            ) : null}

            {serverError && (
              <p className={styles.formAlert} role="alert">
                {serverError}
              </p>
            )}
            {savedWarning && (
              <p className={styles.formAlert} role="alert">
                {savedWarning}
              </p>
            )}
            {isEdit && history ? <div data-testid="goal-editor-history">{history}</div> : null}
          </div>

          <div className={styles.drawerActions}>
            {isEdit && onPause && goal?.status === "active" && (
              <button
                type="button"
                onClick={() => {
                  setSaving(true);
                  setServerError(null);
                  onPause()
                    .catch((e: unknown) =>
                      setServerError((e as Error).message || "Could not pause that goal."),
                    )
                    .finally(() => setSaving(false));
                }}
                disabled={saving}
                className={styles.cancelButton}
                style={{ marginRight: "auto" }}
              >
                Pause goal
              </button>
            )}
            <button
              type="button"
              onClick={dismiss}
              disabled={saving}
              className={styles.cancelButton}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className={styles.saveButton}
            >
              {saving ? "Saving…" : savedWarning ? "Done" : isEdit ? "Save changes" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
