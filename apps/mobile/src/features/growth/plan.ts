

export type GrowthPlanConfidence = "low" | "medium" | "high";

export type GrowthBasisEvidence = {
  kind: "founder" | "platform" | "site" | "inferred" | "gap";
  source: string;
  statement: string;
};

export type GrowthPlanRow = {
  id: string | null;
  source: "typed" | "legacy";
  pending_acceptance: boolean;
  objective: string;
  north_star_metric: string | null;
  constraint_lever_family: string | null;
  constraint_statement: string | null;
  constraint_confidence: GrowthPlanConfidence | null;
  basis_evidence: GrowthBasisEvidence[];
  version: number;
  updated_at: string | null;
};

export type GrowthBetStatus = "proposed" | "accepted" | "rejected" | "superseded" | "done";

export type GrowthBet = {
  id: string;
  channel_slug: string | null;
  intent: string;
  rationale: string | null;
  expected_effect: string | null;
  falsifier: string | null;
  status: GrowthBetStatus | string;
  rejected_reason?: string | null;
  sort_order: number | null;
};

export type GrowthGoal = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number | null;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  status: string;
  priority: number | null;
  source?: string | null;
  falsifier?: string | null;
  status_changed_by?: string | null;
  status_changed_at?: string | null;
  measurement_mode?: string | null;
  current_value_at?: string | null;
  counted_as?: string | null;
  count_failing?: boolean;
};

export type GrowthGoals = {
  max_active: number | null;
  active_count: number;
  over_cap: boolean;
  items: GrowthGoal[];
};

export type GrowthMetric = {
  key: string;
  label: string;
  unit: string | null;
  direction: string | null;
  value: number | null;
  status: "measured" | "unavailable";
  source: string | null;
  window_end: string | null;
  denominator: { spend: number; conversions: number } | null;
  caveat: string | null;
};

export type GrowthChannel = {
  slug: string;
  last_run_at: string | null;
  last_run_status: string | null;
  metric_keys?: string[];
  metric_availability?: "measured" | "unavailable" | "none";
  autorun: boolean;
  autorun_set_by?: string;
  plan_selected: boolean;
  plan_selected_set_by?: "plan" | "founder" | null;
  cgo_reason?: string | null;
  cgo_set_at?: string | null;
};

export type GrowthChange = {
  id: string;
  entity: string;
  entity_id: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  actor_kind: string | null;
  actor_ref: string | null;
  note: string | null;
  created_at: string | null;
};

export type GrowthSection =
  | "plan"
  | "bets"
  | "goals"
  | "metrics"
  | "channels"
  | "changes"
  | "goal_work"
  | "head_of_growth";

export type NoteRowUndo = { kind: "goal"; goal_id: string } | { kind: "channel"; channel_slug: string };
export type NoteSectionRow = { line: string; url: string | null; question_ordinal?: number; undo?: NoteRowUndo };
export type NoteSectionKey = "needs_you" | "changed" | "decided" | "would_change" | "working_on" | "blocked";
export type NoteSection = {
  key: NoteSectionKey;
  title: string;
  rows: NoteSectionRow[];
  more: { count: number; url: string; line: string } | null;
};

export type HogNote = {
  saw: string[];
  changed: string[];
  would_change: string[];
  need: string[];
  questions?: string[];
  created_at: string;
  next_review_at: string;
  headline?: string | null;
  sections?: NoteSection[];
};

export type HeadOfGrowth = {
  autopilot: boolean;
  note: HogNote | null;
  undoable: Array<{ goal_id: string; why: string; at: string; prev_objective: string }>;
};

export type GoalMoveState = "waiting" | "declined" | "starting" | "running" | "done" | "blocked" | "failed";
export type GoalHypothesisStatus = "listed" | "testing" | "confirmed" | "ruled_out";

export type GoalHypothesis = {
  id: string;
  claim: string;
  status: GoalHypothesisStatus;
  problem?: string | null;
  restates_plan_constraint?: boolean;
  research_running?: boolean;
  evidence: Array<{ at: string; verdict: string | null; quote: string | null; why: string | null }>;
};

export type GoalMove = {
  decision_id: string;
  agent: string;
  intent: string;
  why: string | null;
  aims_to_move: string | null;
  state: GoalMoveState;
  run_id: string | null;
  emitted_at: string;
  hypothesis_id: string | null;
};

export type GoalWork = {
  status_line: string | null;
  status_at: string | null;
  moves: GoalMove[];
  hypotheses?: GoalHypothesis[];
  hypotheses_unavailable?: boolean;
};

export type ConstraintConflict = { goal_id: string; hypothesis_id: string; claim: string; kept_at?: string | null };

export type GrowthPlanDetail = {
  company_facts?: Array<{ fact: string; source_url: string }>;
  growth_moves?: Array<{
    title: string;
    lever: string;
    action: string;
    rationale: string;
    expected_effect: string;
    falsifier: string;
  }>;
  first_steps?: Array<{ when: string; step: string }>;
  target_rationale?: string;
  would_change_plan?: string[];
  summary?: string;
  also_fix?: string;
};

export type GrowthPlan = {
  plan: GrowthPlanRow | null;
  bets: GrowthBet[];
  goals: GrowthGoals;
  metrics: GrowthMetric[];
  channels: GrowthChannel[];
  changes: GrowthChange[];
  detail: GrowthPlanDetail;
  goal_work: Record<string, GoalWork>;
  head_of_growth: HeadOfGrowth;
  constraint_conflicts: ConstraintConflict[];
  unreadable: GrowthSection[];
};

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

const NOTE_SECTION_KEYS: ReadonlySet<string> = new Set(["needs_you", "changed", "decided", "would_change", "working_on", "blocked"]);

export const relUrl = (v: unknown): string | null => (typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : null);

function undoOf(v: unknown): NoteRowUndo | undefined {
  const u = (v ?? {}) as Record<string, unknown>;
  if (u.kind === "goal" && typeof u.goal_id === "string" && u.goal_id) return { kind: "goal", goal_id: u.goal_id };
  if (u.kind === "channel" && typeof u.channel_slug === "string" && u.channel_slug) {
    return { kind: "channel", channel_slug: u.channel_slug };
  }
  return undefined;
}

export function noteSectionsOf(v: unknown): NoteSection[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NoteSection[] = [];
  for (const raw of v) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s.key !== "string" || !NOTE_SECTION_KEYS.has(s.key) || typeof s.title !== "string") continue;
    const rows = (Array.isArray(s.rows) ? s.rows : []).flatMap((r): NoteSectionRow[] => {
      const x = (r ?? {}) as Record<string, unknown>;
      if (typeof x.line !== "string" || !x.line.trim()) return [];
      const undo = undoOf(x.undo);
      return [
        {
          line: x.line,
          url: relUrl(x.url),
          ...(typeof x.question_ordinal === "number" && Number.isInteger(x.question_ordinal)
            ? { question_ordinal: x.question_ordinal }
            : {}),
          ...(undo ? { undo } : {}),
        },
      ];
    });
    const m = (s.more ?? null) as Record<string, unknown> | null;
    const moreUrl = m ? relUrl(m.url) : null;
    const more =
      m && typeof m.count === "number" && m.count > 0 && typeof m.line === "string" && moreUrl
        ? { count: m.count, url: moreUrl, line: m.line }
        : null;
    if (rows.length === 0 && !more) continue;
    out.push({ key: s.key as NoteSectionKey, title: s.title, rows, more });
  }
  return out;
}

export function headOfGrowthOf(raw: unknown): HeadOfGrowth {
  const h = (raw ?? {}) as Record<string, unknown>;
  const n = h.note as Record<string, unknown> | null | undefined;
  const sections = n && typeof n === "object" ? noteSectionsOf(n.sections) : undefined;
  return {
    autopilot: h.autopilot === true,
    note:
      n && typeof n === "object"
        ? {
            saw: strs(n.saw),
            changed: strs(n.changed),
            would_change: strs(n.would_change),
            need: strs(n.need),
            ...(Array.isArray(n.questions) ? { questions: strs(n.questions) } : {}),
            created_at: String(n.created_at ?? ""),
            next_review_at: String(n.next_review_at ?? ""),
            ...(typeof n.headline === "string" && n.headline.trim() ? { headline: n.headline } : {}),
            ...(sections ? { sections } : {}),
          }
        : null,
    undoable: (Array.isArray(h.undoable) ? h.undoable : [])
      .map((u) => (u ?? {}) as Record<string, unknown>)
      .filter((u) => typeof u.goal_id === "string")
      .map((u) => ({
        goal_id: String(u.goal_id),
        why: String(u.why ?? ""),
        at: String(u.at ?? ""),
        prev_objective: String(u.prev_objective ?? ""),
      })),
  };
}

export function constraintConflictsOf(raw: unknown): ConstraintConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const x = c as Record<string, unknown>;
    if (typeof x.goal_id !== "string" || typeof x.hypothesis_id !== "string" || typeof x.claim !== "string") return [];
    const kept_at = typeof x.kept_at === "string" && !Number.isNaN(Date.parse(x.kept_at)) ? x.kept_at : null;
    return [{ goal_id: x.goal_id, hypothesis_id: x.hypothesis_id, claim: x.claim, kept_at }];
  });
}

const HYP_STATUSES = new Set<string>(["listed", "testing", "confirmed", "ruled_out"]);

export function hypothesesOf(raw: unknown): GoalHypothesis[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((h) => {
    if (!h || typeof h !== "object") return [];
    const x = h as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.claim !== "string" || !HYP_STATUSES.has(x.status as string)) return [];
    const evidence = (Array.isArray(x.evidence) ? x.evidence : []).flatMap((e) => {
      if (!e || typeof e !== "object") return [];
      const y = e as Record<string, unknown>;
      return [{ at: typeof y.at === "string" ? y.at : "", verdict: strOrNull(y.verdict), quote: strOrNull(y.quote), why: strOrNull(y.why) }];
    });
    return [
      {
        id: x.id,
        claim: x.claim,
        status: x.status as GoalHypothesisStatus,
        problem: strOrNull(x.problem),
        restates_plan_constraint: x.restates_plan_constraint === true,
        research_running: x.research_running === true,
        evidence,
      },
    ];
  });
}

const MOVE_STATES = new Set<string>(["waiting", "declined", "starting", "running", "done", "blocked", "failed"]);

export function goalWorkOf(raw: unknown): Record<string, GoalWork> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, GoalWork> = {};
  for (const [goalId, w] of Object.entries(raw as Record<string, unknown>)) {
    if (!w || typeof w !== "object") continue;
    const v = w as Record<string, unknown>;
    const moves = Array.isArray(v.moves) ? v.moves : [];
    out[goalId] = {
      status_line: typeof v.status_line === "string" ? v.status_line : null,
      status_at: typeof v.status_at === "string" ? v.status_at : null,
      moves: moves.flatMap((m): GoalMove[] => {
        if (!m || typeof m !== "object") return [];
        const x = m as Record<string, unknown>;
        if (typeof x.decision_id !== "string" || typeof x.agent !== "string" || typeof x.intent !== "string") return [];
        if (!MOVE_STATES.has(x.state as string)) return [];
        return [
          {
            decision_id: x.decision_id,
            agent: x.agent,
            intent: x.intent,
            why: typeof x.why === "string" ? x.why : null,
            aims_to_move: typeof x.aims_to_move === "string" && x.aims_to_move.trim() ? x.aims_to_move : null,
            state: x.state as GoalMoveState,
            run_id: typeof x.run_id === "string" ? x.run_id : null,
            emitted_at: typeof x.emitted_at === "string" ? x.emitted_at : "",
            hypothesis_id: typeof x.hypothesis_id === "string" ? x.hypothesis_id : null,
          },
        ];
      }),
      hypotheses: hypothesesOf(v.hypotheses),
      ...(v.hypotheses_unavailable === true ? { hypotheses_unavailable: true } : {}),
    };
  }
  return out;
}

export function normalizePlan(raw: unknown): GrowthPlan {
  const body = (raw ?? {}) as Record<string, unknown>;
  const rawPlan = body.plan as Partial<GrowthPlanRow> | null | undefined;
  const goals = (body.goals ?? null) as Partial<GrowthGoals> | null;
  const items = list<GrowthGoal>(goals?.items);
  const detail = body.detail && typeof body.detail === "object" ? (body.detail as GrowthPlanDetail) : {};
  return {
    plan: rawPlan
      ? ({ ...rawPlan, basis_evidence: list<GrowthBasisEvidence>(rawPlan.basis_evidence) } as GrowthPlanRow)
      : null,
    bets: list<GrowthBet>(body.bets),
    goals: goals
      ? {
          max_active: typeof goals.max_active === "number" ? goals.max_active : null,
          active_count:
            typeof goals.active_count === "number"
              ? goals.active_count
              : items.filter((g) => g.status === "active").length,
          over_cap: goals.over_cap === true,
          items,
        }
      : { max_active: null, active_count: 0, over_cap: false, items: [] },
    metrics: list<GrowthMetric>(body.metrics),
    channels: list<GrowthChannel>(body.channels),
    changes: list<GrowthChange>(body.changes),
    detail,
    goal_work: goalWorkOf(body.goal_work),
    head_of_growth: headOfGrowthOf(body.head_of_growth),
    constraint_conflicts: constraintConflictsOf(body.constraint_conflicts),
    unreadable: list<GrowthSection>(body.unreadable),
  };
}

export function planKey(plan: GrowthPlanRow | null): string | null {
  return plan ? `${plan.source}:${plan.id}:${plan.version}:${plan.updated_at}` : null;
}

export function humanize(value: string): string {
  return value
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\b(Seo|Sms|Ugc|Aso|Cpa|Cac|Mrr|Arr|Gmv|Pr|Ai)\b/g, (word) => word.toUpperCase());
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

export const CONFIDENCE_LABEL: Record<GrowthPlanConfidence, string> = {
  low: "Best guess",
  medium: "Fairly sure",
  high: "Data backed",
};

export const GOAL_METRIC_OPTIONS: ReadonlyArray<{ value: string; label: string; measurable: boolean; unit: "usd" | "count" }> = [
  { value: "mrr", label: "MRR (monthly recurring revenue)", measurable: true, unit: "usd" },
  { value: "arr", label: "ARR (annual recurring revenue)", measurable: true, unit: "usd" },
  { value: "signups", label: "Signups", measurable: true, unit: "count" },
  { value: "bookings", label: "Bookings", measurable: true, unit: "count" },
  { value: "rentals", label: "Rentals", measurable: true, unit: "count" },
  { value: "activations", label: "Activations", measurable: true, unit: "count" },
  { value: "purchases", label: "Purchases", measurable: true, unit: "count" },
  { value: "gmv", label: "GMV (gross merchandise value)", measurable: false, unit: "usd" },
  { value: "suppliers", label: "Suppliers / hosts", measurable: false, unit: "count" },
  { value: "active users", label: "Active users", measurable: false, unit: "count" },
  { value: "retention", label: "Retention rate", measurable: false, unit: "count" },
];

export function findMetricOption(value: string) {
  return GOAL_METRIC_OPTIONS.find((o) => o.value === value);
}

export function metricLabel(metric: string): string {
  const option = findMetricOption(metric);
  if (option?.value === "mrr") return "Monthly recurring revenue";
  if (option?.value === "arr") return "Annual recurring revenue";
  const label = option?.label.replace(/\s*\(.*\)$/, "") ?? metric.replace(/_/g, " ");
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : metric;
}

export type GoalDataSource = {
  key: "stripe" | "connected_data" | "connected_database" | "product_analytics" | "manual";
  label: string;
  automatic: boolean;
};

export function dataSourceForMetric(metric: string): GoalDataSource {
  const n = (metric ?? "").toLowerCase().replace(/[_\-./]+/g, " ");
  if (/book|rental|reservation|\btrip/.test(n)) return { key: "connected_database", label: "Connected database", automatic: true };
  if (/\b(?:mrr|arr)\b/.test(n)) return { key: "stripe", label: "Stripe", automatic: true };
  if (/sign\s?up/.test(n)) return { key: "connected_data", label: "Connected data", automatic: true };
  if (/activat|purchase|order|sale|key\s?action/.test(n)) {
    return { key: "product_analytics", label: "Product analytics", automatic: true };
  }
  return { key: "manual", label: "Manual", automatic: false };
}

const SOURCE_CONNECTOR: Partial<Record<GoalDataSource["key"], { slug: string; name: string }>> = {
  connected_database: { slug: "operator_db", name: "Your database" },
  stripe: { slug: "stripe", name: "Stripe" },
};

export function readsLive(goal: GrowthGoal): boolean {
  return goal.measurement_mode === "auto" && dataSourceForMetric(goal.target_metric).automatic;
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

export function activeGoals(plan: GrowthPlan): GrowthGoal[] {
  return rankGoals(plan.goals.items.filter((g) => g.status === "active"));
}

export type LiveReadState = "loading" | "measured" | "unmeasured" | "failed";
export type LiveGoalValues = {
  values: ReadonlyMap<string, number>;
  states: ReadonlyMap<string, LiveReadState>;
};

export function liveReadOf(body: unknown): { state: LiveReadState; value: number | null } {
  const b = (body ?? null) as { measured?: unknown; value?: unknown } | null;
  if (b?.measured === true && typeof b.value === "number" && Number.isFinite(b.value)) {
    return { state: "measured", value: b.value };
  }
  return { state: b?.measured === false ? "unmeasured" : "failed", value: null };
}

export function withLiveValue(goal: GrowthGoal, live: LiveGoalValues): GrowthGoal {
  if (!readsLive(goal)) return goal;
  return { ...goal, current_value: live.values.get(goal.target_metric) ?? goal.current_value };
}

export function goalProgress(goal: GrowthGoal): number | null {
  const { current_value: current, target_value: target, baseline_value: baseline } = goal;
  if (current === null || target === null || baseline === null || target === baseline) return null;
  const pct = ((current - baseline) / (target - baseline)) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.round(Math.max(0, Math.min(100, pct)));
}

function isCurrencyMetric(metric: string): boolean {
  const option = findMetricOption(metric);
  if (option) return option.unit === "usd";
  return /\b(mrr|arr|gmv|revenue|sales|income|earnings)\b/i.test(metric);
}

export function formatGoalValue(metric: string, value: number): string {
  return new Intl.NumberFormat("en-US", {
    ...(isCurrencyMetric(metric) ? { style: "currency" as const, currency: "USD" } : {}),
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function formatGoalNumber(metric: string, value: number): string {
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  const text = formatGoalValue(metric, rounded);
  return /\brate\b|percent|%/i.test(metric.replace(/[_-]+/g, " ")) ? `${text}%` : text;
}

export function goalTitle(goal: GrowthGoal, now: Date = new Date(), { date = true }: { date?: boolean } = {}): string | null {
  const metric = goal.target_metric?.trim() ?? "";
  if (goal.target_value === null || !metric) return null;
  const target = formatGoalNumber(metric, goal.target_value);
  const numbers =
    goal.current_value !== null ? `${formatGoalNumber(metric, goal.current_value)} / ${target}` : `→ ${target}`;
  const due = date && goal.due_date ? ` · by ${shortDate(goal.due_date, now)}` : "";
  return `${humanize(metric)} ${numbers}${due}`;
}

export const LOADING = "loading" as const;
export type Loadable<T> = T | null | typeof LOADING;

export type MeasurementNeed =
  | { kind: "none" }
  | { kind: "manual"; goalId: string }
  | { kind: "connect"; slug: string; name: string }
  | { kind: "other" };

export const bareSlug = (s: string) => s.replace(/^(?:pipedream|composio)\./, "");

export function goalFix(
  goal: GrowthGoal,
  live: LiveGoalValues,
  connected: readonly string[] | null | undefined,
): MeasurementNeed | null | typeof LOADING {
  const source = dataSourceForMetric(goal.target_metric);
  if (readsLive(goal)) {
    const state = live.states.get(goal.target_metric) ?? "loading";
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
  const has = connected.some((s) => bareSlug(s) === connector.slug);
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

export type HeadlineInputs = {
  pending: Loadable<number>;
  pendingCapped?: boolean;
  activeGoals: number | null;
  measurement: Loadable<MeasurementNeed>;
  channels: Loadable<Array<{ slug: string; name: string; ranAt: string | null; running: boolean }>>;
  rivals: Loadable<number>;
  brandVoiceSet: Loadable<boolean>;
  noGoalFirst?: boolean;
};

export type HeadlineAction =
  | { kind: "review"; label: string }
  | { kind: "add_goal"; label: string }
  | { kind: "connect"; label: string; slug: string }
  | { kind: "enter_number"; label: string; goalId: string }
  | { kind: "start_run"; label: string; slug: string }
  | { kind: "add_rivals"; label: string }
  | { kind: "set_voice"; label: string }
  | { kind: "ask"; label: string; question: string }
  | { kind: "recheck"; label: string };

export type ReadyHeadline = {
  kind: "review" | "no_goal" | "unmeasured" | "nothing_ran" | "no_rivals" | "no_voice" | "waiting" | "clear" | "unknown";
  text: string;
  action: HeadlineAction;
};
export type Headline = { kind: "loading" } | ReadyHeadline;

const noGoal = (): ReadyHeadline => ({
  kind: "no_goal",
  text: "I have no goal to work toward yet.",
  action: { kind: "add_goal", label: "Add a goal" },
});

export function growthHeadline(i: HeadlineInputs): Headline {
  const loading = { kind: "loading" } as const;
  if (i.noGoalFirst && i.activeGoals === 0) return noGoal();
  if (i.pending === LOADING) return loading;
  if (i.pending !== null && i.pending > 0) {
    const n = i.pendingCapped ? `${i.pending}+` : String(i.pending);
    return {
      kind: "review",
      text: `${n} ${n === "1" ? "action waits" : "actions wait"} for your OK.`,
      action: { kind: "review", label: `Review ${n}` },
    };
  }
  if (i.activeGoals === 0) return noGoal();
  const m = i.measurement;
  if (m === LOADING) return loading;
  if (m?.kind === "manual") {
    return {
      kind: "unmeasured",
      text: "I need this week's number for your goal.",
      action: { kind: "enter_number", label: "Enter this week's number", goalId: m.goalId },
    };
  }
  if (m?.kind === "connect") {
    return {
      kind: "unmeasured",
      text: "I can't measure your goal yet.",
      action: { kind: "connect", label: `Connect ${m.name}`, slug: m.slug },
    };
  }
  if (m?.kind === "other") {
    return {
      kind: "unmeasured",
      text: "I can't measure your goal yet.",
      action: { kind: "ask", label: "Ask how to measure it", question: "How can you start measuring my goal?" },
    };
  }
  const channels = i.channels;
  if (channels === LOADING) return loading;
  const nothingRan = channels !== null && channels.every((c) => c.ranAt === null && !c.running);
  const firstIdle = nothingRan ? channels[0] : undefined;
  if (firstIdle) {
    return {
      kind: "nothing_ran",
      text: `Nothing has run yet. Start ${firstIdle.name}?`,
      action: { kind: "start_run", label: `Start ${firstIdle.name}`, slug: firstIdle.slug },
    };
  }
  if (i.rivals === LOADING) return loading;
  if (i.rivals === 0) {
    return { kind: "no_rivals", text: "I don't know your rivals yet.", action: { kind: "add_rivals", label: "Add rivals" } };
  }
  if (i.brandVoiceSet === LOADING) return loading;
  if (i.brandVoiceSet === false) {
    return { kind: "no_voice", text: "I don't know how you sound yet.", action: { kind: "set_voice", label: "Set brand voice" } };
  }
  if (Object.values(i).some((v) => v === null)) {
    return { kind: "unknown", text: "I couldn't check everything just now.", action: { kind: "recheck", label: "Check again" } };
  }
  const known = channels ?? [];
  if (known.some((c) => c.running) || known.every((c) => c.ranAt === null)) {
    return {
      kind: "waiting",
      text: "Waiting for the first run. Nothing else needs you.",
      action: { kind: "ask", label: "Ask what happens next", question: "What will you do first, and when?" },
    };
  }
  return {
    kind: "clear",
    text: "Nothing needs you right now.",
    action: { kind: "ask", label: "Ask what happens next", question: "What will you do next, and when?" },
  };
}

export const SETUP_KINDS: ReadonlySet<ReadyHeadline["kind"]> = new Set([
  "no_goal",
  "unmeasured",
  "nothing_ran",
  "no_rivals",
  "no_voice",
  "unknown",
]);

export const EDIT_ACTIONS: ReadonlySet<HeadlineAction["kind"]> = new Set([
  "add_goal",
  "connect",
  "enter_number",
  "add_rivals",
  "set_voice",
]);

export function autonomyLine(channels: Array<{ name: string; autorun: boolean }>): string | null {
  if (channels.length === 0) return null;
  const alone = channels.filter((c) => c.autorun);
  if (alone.length === 0) return "Every channel asks you first.";
  if (alone.length === channels.length) return "Every channel runs on its own.";
  const who =
    alone.length === 1
      ? `${alone[0].name} runs on its own.`
      : alone.length === 2
        ? `${alone[0].name} and ${alone[1].name} run on their own.`
        : `${alone.length} channels run on their own.`;
  return `${who} The rest ask you first.`;
}

export function hasLivePlan(plan: GrowthPlan): boolean {
  const row = plan.unreadable.includes("plan") ? null : plan.plan;
  return row !== null && !row.pending_acceptance;
}

export function liveBets(plan: GrowthPlan): GrowthBet[] {
  return plan.unreadable.includes("bets") ? [] : plan.bets.filter((b) => b.status === "accepted" || b.status === "done");
}

export function orderedPlanChannels(
  channels: GrowthChannel[],
  bets: GrowthBet[],
  live: boolean,
  nameOf: (slug: string) => string,
): GrowthChannel[] {
  const order = new Map<string, number>();
  for (const b of bets) {
    if (b.channel_slug && !order.has(b.channel_slug)) order.set(b.channel_slug, b.sort_order ?? Number.MAX_SAFE_INTEGER);
  }
  return channels
    .filter((c) => c.plan_selected && (live || c.plan_selected_set_by === "founder"))
    .sort((a, b) => {
      const oa = order.get(a.slug) ?? Number.POSITIVE_INFINITY;
      const ob = order.get(b.slug) ?? Number.POSITIVE_INFINITY;
      return oa !== ob ? oa - ob : nameOf(a.slug).localeCompare(nameOf(b.slug));
    });
}

export function planChannels(plan: GrowthPlan, nameOf: (slug: string) => string): GrowthChannel[] {
  if (plan.unreadable.includes("channels")) return [];
  return orderedPlanChannels(plan.channels, liveBets(plan), hasLivePlan(plan), nameOf);
}

export type ChannelWork = { counts: Record<string, number>; running: ReadonlySet<string> };

export function channelStatus(channel: GrowthChannel, work: ChannelWork | null | undefined, now: Date = new Date()): string {
  if (work?.running.has(channel.slug)) return "Running now";
  const n = work?.counts[channel.slug] ?? 0;
  if (n > 0) return `${n} ready`;
  if (channel.last_run_at) return `Last ran ${shortDate(channel.last_run_at, now)}`;
  return "Not run yet";
}

export const APPROVALS_LIST_CAP = 100;

const GROWTH_EXACT = ["channel.recipe_step"];
const GROWTH_PREFIXES = ["social.publish", "meta_ads.", "google_ads.", "x_ads."];

export function isGrowthDecision(
  d: { decision_class?: string | null; channel_slug?: string | null },
  channelSlugs: ReadonlySet<string>,
): boolean {
  const cls = d.decision_class ?? "";
  if (GROWTH_EXACT.includes(cls)) return true;
  if (GROWTH_PREFIXES.some((p) => cls.startsWith(p))) return true;
  return !!d.channel_slug && channelSlugs.has(d.channel_slug);
}

export type Pending = { total: number; capped: boolean; toApprove: number; inChannels: Record<string, number> };

export function growthPending(
  body: {
    decisions?: Array<{ decision_class?: string | null; channel_slug?: string | null }>;
    channel_pending_counts?: Record<string, number>;
  },
  channelSlugs: ReadonlySet<string>,
): Pending | null {
  const raw = body.decisions ?? [];
  const decisions = raw.filter((d) => isGrowthDecision(d, channelSlugs));
  const listed: Record<string, number> = {};
  for (const d of decisions) if (d.channel_slug) listed[d.channel_slug] = (listed[d.channel_slug] ?? 0) + 1;
  const inChannels: Record<string, number> = {};
  let total = decisions.filter((d) => !d.channel_slug).length;
  for (const [slug, n] of Object.entries(body.channel_pending_counts ?? {})) {
    if (typeof n !== "number" || n <= 0) continue;
    total += n;
    const unlisted = n - (listed[slug] ?? 0);
    if (unlisted > 0) inChannels[slug] = unlisted;
  }
  const capped = raw.length >= APPROVALS_LIST_CAP;
  return capped && total === 0 ? null : { total, capped, toApprove: decisions.length, inChannels };
}

export function splitCompetitors(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

const CHAT_SURFACES = new Set(["whatsapp", "telegram", "discord", "teams", "msteams", "microsoft_teams"]);

export function connectedSources(rows: ReadonlyArray<{ slug: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!r?.slug || CHAT_SURFACES.has(bareSlug(r.slug)) || seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push(r.slug);
  }
  return out;
}
