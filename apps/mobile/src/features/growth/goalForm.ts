
import { dataSourceForMetric, findMetricOption, formatGoalValue, type GoalDataSource, type GrowthGoal } from "./plan";

export const CUSTOM_METRIC = "__custom__";

export type GoalFields = {
  objective: string;
  metricChoice: string;
  customMetric: string;
  currentValue: string;
  targetValue: string;
  dueDate: string;
};

export type GoalFormErrors = Partial<Record<"objective" | "metric" | "currentValue" | "targetValue" | "dueDate", string>>;

export function goalFieldsStart(goal: GrowthGoal | null, initialObjective?: string): GoalFields {
  if (!goal) {
    return { objective: initialObjective ?? "", metricChoice: "", customMetric: "", currentValue: "", targetValue: "", dueDate: "" };
  }
  const known = findMetricOption(goal.target_metric) !== undefined;
  return {
    objective: goal.objective,
    metricChoice: known ? goal.target_metric : CUSTOM_METRIC,
    customMetric: known ? "" : goal.target_metric,
    currentValue: goal.current_value === null ? "" : String(goal.current_value),
    targetValue: goal.target_value === null ? "" : String(goal.target_value),
    dueDate: goal.due_date?.slice(0, 10) ?? "",
  };
}

export function effectiveMetric(f: Pick<GoalFields, "metricChoice" | "customMetric">): string {
  return f.metricChoice === CUSTOM_METRIC ? f.customMetric.trim() : f.metricChoice;
}

export function currentRequired(metric: string): boolean {
  return metric.length > 0 && !dataSourceForMetric(metric).automatic;
}

const VOWEL_RE = /[aeiou]/i;

function isAllSameChar(s: string): boolean {
  const squashed = s.toLowerCase().replace(/\s+/g, "");
  return squashed.length >= 2 && new Set(squashed).size === 1;
}

export function detectGoalJunk(input: { objective?: string; target_metric?: string; target_value?: number }): string | null {
  if (input.objective !== undefined) {
    const obj = input.objective.trim();
    if (obj.length < 8) return 'Objective is too short — describe a real goal, e.g. "Grow MRR to $50k by Q3".';
    if (isAllSameChar(obj)) return "Objective looks like placeholder text — write a real goal your team can work toward.";
    const letters = obj.replace(/[^a-z]/gi, "");
    if (!/\d/.test(obj) && letters.length >= 3 && !VOWEL_RE.test(letters)) {
      return "Objective doesn't look like real words — write a real goal your team can work toward.";
    }
  }
  if (input.target_metric !== undefined) {
    const metric = input.target_metric.trim();
    if (metric.length < 2) return 'Target metric is too short — name a measurable metric, e.g. "mrr" or "signups".';
    if (isAllSameChar(metric)) return 'Target metric looks like placeholder text — name a measurable metric, e.g. "mrr" or "signups".';
  }
  if (input.target_value !== undefined && (!Number.isFinite(input.target_value) || input.target_value <= 0)) {
    return "Target value must be a number greater than zero.";
  }
  return null;
}

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
  else if (objective.length < 8) errors.objective = "Use at least 8 characters so the goal is clear.";
  else if (objective.length > 500) errors.objective = "Goal names can be up to 500 characters.";

  if (!metric) errors.metric = "Select or enter a metric.";
  else if (metric.length < 2) errors.metric = "Use at least 2 characters.";
  else if (metric.length > 120) errors.metric = "Metrics can be up to 120 characters.";

  if (!input.targetValue.trim()) errors.targetValue = "Enter a target value.";
  else if (!Number.isFinite(target) || target <= 0) errors.targetValue = "Target value must be greater than zero.";

  if (input.currentRequired || input.currentValue.trim()) {
    if (!input.currentValue.trim()) errors.currentValue = "Enter the current value.";
    else if (!Number.isFinite(Number(input.currentValue))) errors.currentValue = "Current value must be a number.";
  }

  if (!input.dueDate) errors.dueDate = "Choose a due date.";
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || !Number.isFinite(Date.parse(input.dueDate))) {
    errors.dueDate = "Choose a valid due date.";
  }

  if (!errors.objective && !errors.metric && !errors.targetValue) {
    const junk = detectGoalJunk({ objective, target_metric: metric, target_value: target });
    if (junk) errors.objective = junk;
  }
  return errors;
}

export function validateFields(f: GoalFields): GoalFormErrors {
  const metric = effectiveMetric(f);
  return validateGoalForm({
    objective: f.objective,
    metric,
    currentValue: f.currentValue,
    targetValue: f.targetValue,
    dueDate: f.dueDate,
    currentRequired: currentRequired(metric),
  });
}

export type GoalPayload = {
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  due_date: string;
  priority: number;
  current_value?: number;
  measurement_mode?: "auto" | "manual_reported";
};

export function buildGoalPayload(input: { fields: GoalFields; goal: GrowthGoal | null; pulledValue: number | null }): GoalPayload {
  const { fields, goal, pulledValue } = input;
  const isEdit = goal !== null;
  const metric = effectiveMetric(fields);
  const typed = fields.currentValue.trim();
  const initialCurrent = goal?.current_value === null || !goal ? "" : String(goal.current_value);
  const usedSource = pulledValue !== null && typed !== "" && Number(typed) === pulledValue;
  const changed = typed !== initialCurrent;
  const metricChanged = isEdit && metric !== goal.target_metric;
  const reported =
    typed !== "" && Number.isFinite(Number(typed)) && (usedSource || changed || metricChanged || currentRequired(metric) || !isEdit)
      ? Number(typed)
      : null;
  const mode = usedSource ? "auto" : reported !== null || metricChanged ? "manual_reported" : undefined;
  return {
    objective: fields.objective.trim(),
    target_metric: metric,
    target_value: Number(fields.targetValue),
    baseline_value: goal?.baseline_value ?? (reported !== null ? reported : null),
    due_date: fields.dueDate,
    priority: goal?.priority ?? 50,
    ...(reported !== null ? { current_value: reported } : {}),
    ...(mode ? { measurement_mode: mode } : {}),
  };
}

export function warningsOf(body: unknown): string[] {
  const w = (body as { warnings?: unknown } | null)?.warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export type LiveRead = { loading: boolean; measured: boolean; value?: number; sourceLabel: string; failed?: boolean };

export function liveReadLine(read: LiveRead | null, metric: string, source: GoalDataSource): { text: string; use: boolean } {
  if (read?.loading) return { text: `Reading from ${read.sourceLabel}…`, use: false };
  if (read?.measured && read.value !== undefined) {
    return { text: `${read.sourceLabel} reads ${formatGoalValue(metric, read.value)}. `, use: true };
  }
  if (read?.failed) return { text: `Could not reach ${read.sourceLabel} right now. You can type the number.`, use: false };
  return { text: `${read?.sourceLabel ?? source.label} can read this once it is connected. Until then, type the number.`, use: false };
}

export const MANUAL_NUMBER_NOTE =
  "Nothing Zavi is connected to can count this, so it will ask you for it. Update it here whenever you know a newer number.";

export function dataSourceNote(metric: string): string {
  if (!metric) return "The source is determined by the metric you choose.";
  return dataSourceForMetric(metric).automatic ? "Matched automatically to the selected metric." : "This metric is updated manually.";
}

export function reorderWrites(
  shown: ReadonlyArray<Pick<GrowthGoal, "id" | "priority">>,
  index: number,
  by: -1 | 1,
): Array<{ id: string; priority: number }> | null {
  const to = index + by;
  if (to < 0 || to >= shown.length) return null;
  const next = [...shown];
  [next[index], next[to]] = [next[to], next[index]];
  return next.map((g, i) => ({ g, priority: Math.max(0, 100 - i) })).filter(({ g, priority }) => g.priority !== priority).map(({ g, priority }) => ({ id: g.id, priority }));
}

export const REORDER_ERROR = "Could not save the new goal order. Try again.";
export const DELETE_ERROR = "Could not delete that goal. Try again.";
export const DELETE_CONFIRM = "Delete this goal? Zavi stops working on it. This can't be undone.";
export const ACCEPT_ERROR = "Could not add that goal. Try again.";
export const ACCEPT_GONE = "That suggestion is no longer open.";
export const PAUSE_ERROR = "Could not pause that goal.";

export function capLine(cap: number): string {
  return `${cap} goals is the most this plan chases at once. Pause one to add another.`;
}

export function serverMessage(e: { code?: string; message?: string } | null | undefined, fallback: string): string {
  return e?.code && !e.code.startsWith("http_") && e.message ? e.message : fallback;
}

export function saveErrorText(e: { status?: number; code?: string; message?: string } | null | undefined): string {
  if (e?.status !== undefined) return e.code && !e.code.startsWith("http_") && e.message ? e.message : `HTTP ${e.status}`;
  return e?.message || "Unknown error";
}
