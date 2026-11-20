
import { readAutopilotState, resolveChannelAutorun, type AutorunRow } from "@/services/growth/channel-autorun";
import { enteredDay, goalTimeZone, goalTrajectoryView } from "@/services/growth/goal-owner";
import { deriveHeadline, noteSections, parseNoteItems, type NoteItem, type NoteSectionView } from "@/services/growth/cgo-note-items";
import { platformNativeSlug } from "@/services/connectors/platform-slugs";
import { confirmedRule } from "@/services/growth/goal-count-rule";
import { channelAutoCapable } from "@/services/growth/channel-auto-capable";
import { RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { METRIC_REGISTRY } from "@/services/analytics/metric-registry";
import type { MetricSnapshotRow } from "@/services/analytics/record-metric-snapshot";
import { loadChannelRecipe, recipeExists } from "@/services/channels/recipe";
import { projectStrategy } from "./growth-strategy";
import { CURRENT_STRATEGY_TAG } from "@/services/growth/strategy-note";
import { MAX_ACTIVE_GOALS } from "@/services/autopilot/goal-limits";
import { sourceLabel } from "@/agents/cgo/strategy";
import { sendGoalAttention } from "@/services/growth/goal-attention";
import { founderEstimateFor, isNewCustomersGoal, readFounderCustomersAnswer } from "@/services/growth/founder-estimate";

type Sb = ReturnType<typeof serverClientFromBearer>;

export const GROWTH_PLAN_MAX_ACTIVE_GOALS = MAX_ACTIVE_GOALS;

export type GrowthPlanSummary = {
  id: string | null;
  objective: string;
  north_star_metric: string | null;
  constraint_lever_family: string | null;
  constraint_statement: string | null;
  constraint_confidence: "low" | "medium" | "high" | null;
  basis_evidence: Array<{
    kind: "founder" | "platform" | "site" | "inferred" | "gap";
    source: string;
    statement: string;
  }>;
  version: number;
  updated_at: string;
  source: "typed" | "legacy";
  founder_constraint: string | null;
  founder_constraint_at: string | null;
  constraint_agreed_at: string | null;
  pending_acceptance: boolean;
};

export type GrowthPlanBet = {
  id: string;
  channel_slug: string | null;
  intent: string;
  rationale: string | null;
  expected_effect: string | null;
  falsifier: string;
  status: "proposed" | "accepted" | "rejected" | "superseded" | "done";
  rejected_reason: string | null;
  sort_order: number;
  result: BetResult | null;
};

export type BetResult = { line: string; label: "measured" | "unmeasured" | "blocked"; source: string | null };

export type GrowthPlanGoal = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number | null;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  status: string;
  priority: number;
  source: string;
  falsifier: string | null;
  status_changed_by: string | null;
  status_changed_at: string | null;
  measurement_mode: string | null;
  measure_source: string | null;
  current_value_at: string | null;
  counted_as: string | null;
  count_failing: boolean;
  value_kind: string | null;
  value_period_start: string | null;
  trajectory: ReturnType<typeof goalTrajectoryView>;
  founder_estimate: string | null;
};

export type GrowthPlanMetric = {
  key: string;
  label: string;
  unit: string;
  direction: string;
  value: number | null;
  status: "measured" | "unavailable";
  source: string | null;
  window_end: string | null;
  denominator: { spend: number; conversions: number } | null;
  caveat: string | null;
};

export type GrowthPlanChannel = {
  slug: string;
  last_run_at: string | null;
  last_run_status: string | null;
  metric_keys: string[];
  metric_availability: "measured" | "unavailable" | "none";
  autorun: boolean;
  auto_capable: boolean;
  autorun_set_by: string;
  plan_selected: boolean;
  plan_selected_set_by: "plan" | "founder" | "founder_stopped" | null;
  cgo_reason: string | null;
  cgo_set_at: string | null;
  fit?: { value: "high" | "medium" | "low"; line: string } | null;
};

export type GrowthPlanChange = {
  id: string;
  entity: string;
  entity_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor_kind: string;
  actor_ref: string | null;
  note: string | null;
  created_at: string;
};

export type GrowthPlanDetail = Pick<
  NonNullable<ReturnType<typeof projectStrategy>>,
  "company_facts" | "growth_moves" | "first_steps" | "target_rationale" | "would_change_plan" | "summary" | "also_fix"
>;

export type GrowthPlanResponse = {
  plan: GrowthPlanSummary | null;
  bets: GrowthPlanBet[];
  goals: {
    max_active: number;
    active_count: number;
    over_cap: boolean;
    items: GrowthPlanGoal[];
  };
  metrics: GrowthPlanMetric[];
  channels: GrowthPlanChannel[];
  changes: GrowthPlanChange[];
  detail: GrowthPlanDetail;
  goal_work: Record<string, GoalWork>;
  head_of_growth: HeadOfGrowth;
  constraint_conflicts: ConstraintConflict[];
  unreadable: GrowthPlanSection[];
};

export type GrowthPlanSection =
  | "plan"
  | "bets"
  | "goals"
  | "metrics"
  | "channels"
  | "changes"
  | "goal_work"
  | "head_of_growth";

export type HeadOfGrowth = {
  autopilot: boolean;
  note: {
    saw: string[];
    changed: string[];
    would_change: string[];
    need: string[];
    questions?: string[];
    created_at: string;
    next_review_at: string;
    headline?: string | null;
    sections?: NoteSectionWire[];
  } | null;
  undoable: Array<{ goal_id: string; why: string; at: string; prev_objective: string }>;
};

export type NoteSectionWire = {
  key: string;
  title: string;
  rows: Array<{
    line: string;
    url: string | null;
    url_label?: string;
    sub?: string[];
    question_ordinal?: number;
    undo?: { kind: "goal"; goal_id: string } | { kind: "channel"; channel_slug: string };
    urgent?: true;
    fix?: NeedsYouFix;
    rid?: string;
  }>;
  more: { count: number; url: string; line: string } | null;
};

export type GoalMoveState = "waiting" | "declined" | "starting" | "running" | "done" | "blocked" | "failed";

export type GoalWork = {
  status_line: string | null;
  status_at: string | null;
  moves: Array<{
    decision_id: string;
    agent: string;
    intent: string;
    why: string | null;
    aims_to_move: string | null;
    state: GoalMoveState;
    run_id: string | null;
    emitted_at: string;
    hypothesis_id: string | null;
  }>;
  hypotheses: GoalHypothesis[];
  hypotheses_unavailable?: boolean;
};

export type GoalHypothesisStatus = "listed" | "testing" | "confirmed" | "ruled_out";

export type ConstraintConflict = { goal_id: string; hypothesis_id: string; claim: string; marked_at?: string | null; kept_at?: string | null };

export type GoalHypothesis = {
  id: string;
  claim: string;
  status: GoalHypothesisStatus;
  problem: string | null;
  segment: string | null;
  restates_plan_constraint: boolean;
  research_running: boolean;
  evidence: Array<{ at: string; verdict: string | null; quote: string | null; why: string | null }>;
};

const HYPOTHESIS_ORDER: Record<GoalHypothesisStatus, number> = { confirmed: 0, testing: 1, listed: 2, ruled_out: 3 };

export function goalHypotheses(
  rows: ReadonlyArray<{ id: string; claim: string; status: string; rank: number | null; evidence: unknown; problem?: string | null; segment?: string | null; restates_plan_constraint?: boolean | null; research_open?: boolean | null }>,
): GoalHypothesis[] {
  return rows
    .filter((r): r is typeof r & { status: GoalHypothesisStatus } => r.status in HYPOTHESIS_ORDER)
    .sort((a, b) => HYPOTHESIS_ORDER[a.status] - HYPOTHESIS_ORDER[b.status] || (a.rank ?? 5) - (b.rank ?? 5))
    .map((r) => ({
      id: r.id,
      claim: r.claim,
      status: r.status,
      problem: typeof r.problem === "string" ? r.problem : null,
      segment: typeof r.segment === "string" && r.segment ? r.segment : null,
      restates_plan_constraint: r.restates_plan_constraint === true,
      research_running: r.research_open === true,
      evidence: (Array.isArray(r.evidence) ? (r.evidence as Array<Record<string, unknown>>) : [])
        .filter((e) => typeof e.verdict === "string")
        .slice(-3)
        .reverse()
        .map((e) => ({
          at: typeof e.at === "string" ? e.at.slice(0, 10) : "",
          verdict: typeof e.verdict === "string" ? e.verdict : null,
          quote: typeof e.quote === "string" && e.quote.trim() ? e.quote : null,
          why: typeof e.why === "string" && e.why.trim() ? e.why : null,
        })),
    }));
}

export function constraintConflicts(
  goals: ReadonlyArray<{ id: string; status: string | null }>,
  hyps: ReadonlyArray<{ id: string; goal_id: string; claim: string; status: string; restates_plan_constraint?: boolean | null; plan_constraint_marked_at?: string | null; plan_kept_at?: string | null }>,
): ConstraintConflict[] {
  const active = new Set(goals.filter((g) => g.status === "active").map((g) => g.id));
  return hyps
    .filter((h) => h.restates_plan_constraint === true && h.status === "ruled_out" && active.has(h.goal_id))
    .map((h) => ({ goal_id: h.goal_id, hypothesis_id: h.id, claim: h.claim, marked_at: h.plan_constraint_marked_at ?? null, kept_at: h.plan_kept_at ?? null }));
}

export function currentConflicts(conflicts: readonly ConstraintConflict[], planUpdatedAt: string | null | undefined): ConstraintConflict[] {
  if (!planUpdatedAt) return [];
  return conflicts
    .filter((c) => !!c.marked_at && c.marked_at >= planUpdatedAt)
    .map(({ goal_id, hypothesis_id, claim, kept_at }) => ({
      goal_id,
      hypothesis_id,
      claim,
      kept_at: kept_at && kept_at >= planUpdatedAt ? kept_at : null,
    }));
}

const GOAL_WORK_DAYS = 30;
const GOAL_WORK_MOVES_PER_GOAL = 8;
const CGO_CARD_CLASS = "cgo.dispatch-specialist";

const CHANGE_LOG_LIMIT = 20;

const CPA_ATTRIBUTION: Record<string, string> = {
  ads_cpa_7d: "Meta-attributed",
  google_ads_cpa_7d: "Google-attributed",
};

const ALL_SOURCE_METRIC = "weekly_signups";

function readBasisEvidence(
  v: unknown,
): GrowthPlanSummary["basis_evidence"] {
  if (!Array.isArray(v)) return [];
  const kinds = ["founder", "platform", "site", "inferred", "gap"];
  const s = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
  return v
    .map((e) => {
      const ee = (e ?? {}) as Record<string, unknown>;
      return {
        kind: s(ee.kind) as GrowthPlanSummary["basis_evidence"][number]["kind"],
        source: sourceLabel(s(ee.source)),
        statement: s(ee.statement),
      };
    })
    .filter((e) => {
      if (e.statement.length === 0 || !kinds.includes(e.kind)) return false;
      if ((e.kind === "platform" || e.kind === "site") && e.source.length === 0) {
        return false;
      }
      return true;
    })
    .slice(0, 24);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function warn(
  failed: Set<GrowthPlanSection>,
  section: GrowthPlanSection,
  tenant_id: string,
  message: string,
): void {
  failed.add(section);
  console.warn(`[growth-plan] ${section} read failed for tenant=${tenant_id}: ${message}`);
}

export async function readPlan(
  sb: Sb,
  tenant_id: string,
  failed: Set<GrowthPlanSection>,
): Promise<GrowthPlanSummary | null> {
  const { data, error } = await sb
    .from("growth_plan")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("status", "live")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    const legacy = await readLegacyPlan(sb, tenant_id, failed);
    if (legacy) {
      console.warn(
        `[growth-plan] typed plan read failed for tenant=${tenant_id}, served legacy: ${error.message}`,
      );
      return legacy;
    }
    warn(failed, "plan", tenant_id, error.message);
    return null;
  }
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return readLegacyPlan(sb, tenant_id, failed);

  const conf = str(row.constraint_confidence);
  return {
    id: String(row.id),
    objective: String(row.objective ?? ""),
    north_star_metric: str(row.north_star_metric),
    constraint_lever_family: await readLeverFamily(sb, tenant_id),
    constraint_statement: str(row.constraint_statement),
    constraint_confidence:
      conf === "low" || conf === "medium" || conf === "high" ? conf : null,
    basis_evidence: readBasisEvidence(row.basis_evidence),
    version: num(row.version) ?? 1,
    updated_at: String(row.updated_at ?? ""),
    founder_constraint: str(row.founder_constraint),
    founder_constraint_at: str(row.founder_constraint_at),
    constraint_agreed_at: str(row.constraint_agreed_at),
    source: "typed",
    pending_acceptance: false,
  };
}

type StrategyProjection = {
  strategy: NonNullable<ReturnType<typeof projectStrategy>>;
  updated_at: string;
  accepted: boolean;
};

async function readStrategyProjection(
  sb: Sb,
  tenant_id: string,
): Promise<
  { ok: true; value: StrategyProjection | null } | { ok: false; message: string }
> {
  const { data, error } = await sb
    .from("memory_note")
    .select("metadata, updated_at")
    .eq("tenant_id", tenant_id)
    .eq("note_type", "growth_strategy")
    .contains("tags", [CURRENT_STRATEGY_TAG])
    .is("superseded_by", null)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) return { ok: false, message: error.message };
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return { ok: true, value: null };

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const strategy = projectStrategy(meta.strategy ?? null);
  if (!strategy) return { ok: true, value: null };
  return {
    ok: true,
    value: {
      strategy,
      updated_at: String(row.updated_at ?? ""),
      accepted: meta.accepted === true,
    },
  };
}

async function readPlanDetail(sb: Sb, tenant_id: string): Promise<GrowthPlanDetail> {
  const projected = await readStrategyProjection(sb, tenant_id);
  if (!projected.ok || !projected.value) return {};
  const { company_facts, growth_moves, first_steps, target_rationale, would_change_plan, summary, also_fix } =
    projected.value.strategy;
  return {
    ...(company_facts ? { company_facts } : {}),
    ...(growth_moves ? { growth_moves } : {}),
    ...(first_steps ? { first_steps } : {}),
    ...(target_rationale ? { target_rationale } : {}),
    ...(would_change_plan ? { would_change_plan } : {}),
    ...(summary ? { summary } : {}),
    ...(also_fix ? { also_fix } : {}),
  };
}

async function readLeverFamily(sb: Sb, tenant_id: string): Promise<string | null> {
  const projected = await readStrategyProjection(sb, tenant_id);
  if (!projected.ok) return null;
  const lever = (projected.value?.strategy.constraint.lever_family ?? "").trim();
  return lever.length > 0 ? lever : null;
}

async function readLegacyPlan(
  sb: Sb,
  tenant_id: string,
  failed: Set<GrowthPlanSection>,
): Promise<GrowthPlanSummary | null> {
  const projected = await readStrategyProjection(sb, tenant_id);
  if (!projected.ok) {
    warn(failed, "plan", tenant_id, `legacy: ${projected.message}`);
    return null;
  }
  if (!projected.value) return null;
  const { strategy, updated_at, accepted } = projected.value;

  const conf = strategy.constraint.confidence;
  const lever = strategy.constraint.lever_family.trim();
  return {
    id: null,
    objective: strategy.north_star.metric,
    north_star_metric: strategy.north_star.metric,
    constraint_lever_family: lever.length > 0 ? lever : null,
    constraint_statement: strategy.constraint.statement,
    constraint_confidence:
      conf === "low" || conf === "medium" || conf === "high" ? conf : null,
    version: 0,
    updated_at,
    source: "legacy",
    basis_evidence: [],
    founder_constraint: null,
    founder_constraint_at: null,
    constraint_agreed_at: null,
    pending_acceptance: !accepted,
  };
}

async function readBets(
  sb: Sb,
  tenant_id: string,
  plan_id: string | null,
  failed: Set<GrowthPlanSection>,
): Promise<GrowthPlanBet[]> {
  if (!plan_id) return [];
  const { data, error } = await sb
    .from("growth_plan_bets")
    .select(
      "id, channel_slug, intent, rationale, expected_effect, falsifier, status, rejected_reason, sort_order",
    )
    .eq("tenant_id", tenant_id)
    .eq("plan_id", plan_id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    warn(failed, "bets", tenant_id, error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((b) => ({
    id: String(b.id),
    channel_slug: str(b.channel_slug),
    intent: String(b.intent ?? ""),
    rationale: str(b.rationale),
    expected_effect: str(b.expected_effect),
    falsifier: String(b.falsifier ?? ""),
    status: (str(b.status) ?? "proposed") as GrowthPlanBet["status"],
    rejected_reason: str(b.rejected_reason),
    sort_order: num(b.sort_order) ?? 100,
    result: null,
  }));
}

export async function readPlanChannelSlugs(
  sb: Sb,
  tenant_id: string,
  plan_id: string | null,
  failed: Set<GrowthPlanSection>,
): Promise<string[]> {
  const bets = await readBets(sb, tenant_id, plan_id, failed);
  const out: string[] = [];
  for (const b of bets) {
    if (b.status !== "proposed" && b.status !== "accepted") continue;
    if (b.channel_slug && !out.includes(b.channel_slug)) out.push(b.channel_slug);
  }
  return out;
}

async function readGoals(
  sb: Sb,
  tenant_id: string,
  failed: Set<GrowthPlanSection>,
): Promise<GrowthPlanResponse["goals"]> {
  const empty = {
    max_active: GROWTH_PLAN_MAX_ACTIVE_GOALS,
    active_count: 0,
    over_cap: false,
    items: [] as GrowthPlanGoal[],
  };

  const { data, error } = await sb
    .from("autopilot_goals")
    .select(
      "id, objective, target_metric, target_value, baseline_value, current_value, due_date, status, priority, source, falsifier, status_changed_by, status_changed_at, measurement_mode, current_value_at, count_rule, measure_source, created_at, value_kind, value_period_start",
    )
    .eq("tenant_id", tenant_id)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    warn(failed, "goals", tenant_id, error.message);
    return empty;
  }

  const items: GrowthPlanGoal[] = ((data ?? []) as Array<Record<string, unknown>>).map((g) => ({
    id: String(g.id),
    objective: decodeXmlEntities(String(g.objective ?? "")),
    target_metric: decodeXmlEntities(String(g.target_metric ?? "")),
    target_value: num(g.target_value),
    baseline_value: num(g.baseline_value),
    current_value: num(g.current_value),
    due_date: str(g.due_date),
    status: String(g.status ?? ""),
    priority: num(g.priority) ?? 0,
    source: String(g.source ?? ""),
    falsifier: g.falsifier === null || g.falsifier === undefined
      ? null
      : decodeXmlEntities(String(g.falsifier)),
    status_changed_by: str(g.status_changed_by),
    status_changed_at: str(g.status_changed_at),
    measurement_mode: str(g.measurement_mode),
    measure_source: str(g.measure_source),
    current_value_at: str(g.current_value_at),
    counted_as: confirmedRule(g.count_rule)?.definition ?? null,
    count_failing: Boolean(confirmedRule(g.count_rule)?.stale_reason),
    value_kind: str(g.value_kind),
    value_period_start: str(g.value_period_start),
    trajectory: goalTrajectoryView({
      id: String(g.id),
      target_metric: String(g.target_metric ?? ""),
      target_value: num(g.target_value),
      baseline_value: num(g.baseline_value),
      current_value: num(g.current_value),
      current_value_at: str(g.current_value_at),
      due_date: str(g.due_date),
      measurement_mode: str(g.measurement_mode),
      created_at: str(g.created_at),
      count_rule: g.count_rule,
      value_kind: str(g.value_kind),
      value_period_start: str(g.value_period_start),
    }),
    founder_estimate: null,
  }));

  const uncounted = items.filter((g) => g.current_value === null && isNewCustomersGoal(g));
  if (uncounted.length) {
    const answer = await readFounderCustomersAnswer(tenant_id);
    for (const g of uncounted) g.founder_estimate = founderEstimateFor(g, answer);
  }

  const active_count = items.filter((g) => g.status === "active").length;
  return {
    max_active: GROWTH_PLAN_MAX_ACTIVE_GOALS,
    active_count,
    over_cap: active_count > GROWTH_PLAN_MAX_ACTIVE_GOALS,
    items,
  };
}

async function readLatestSnapshots(
  sb: Sb,
  tenant_id: string,
  failed: Set<GrowthPlanSection>,
): Promise<Map<string, MetricSnapshotRow>> {
  const out = new Map<string, MetricSnapshotRow>();
  const defs = Object.values(METRIC_REGISTRY);

  const results = await Promise.all(
    defs.map(async (def) => {
      const { data, error } = await sb
        .from("tenant_metric_snapshots")
        .select("metric_key, value, status, source, window_kind, window_end, meta")
        .eq("tenant_id", tenant_id)
        .eq("metric_key", def.key)
        .eq("window_kind", def.window_kind)
        .order("window_end", { ascending: false })
        .limit(1);
      if (error) {
        warn(failed, "metrics", tenant_id, `${def.key}: ${error.message}`);
        return null;
      }
      return ((data ?? [])[0] ?? null) as MetricSnapshotRow | null;
    }),
  );

  for (const row of results) {
    if (row) out.set(row.metric_key, row);
  }
  return out;
}

function denominatorOf(row: MetricSnapshotRow | undefined): {
  spend: number;
  conversions: number;
} | null {
  const meta = (row?.meta ?? null) as Record<string, unknown> | null;
  if (!meta) return null;
  const spend = num(meta.spend);
  const conversions = num(meta.conversions);
  if (spend === null || conversions === null) return null;
  return { spend, conversions };
}

function buildMetrics(snapshots: Map<string, MetricSnapshotRow>): GrowthPlanMetric[] {
  const metrics: GrowthPlanMetric[] = Object.values(METRIC_REGISTRY).map((def) => {
    const row = snapshots.get(def.key);
    const status: "measured" | "unavailable" =
      row?.status === "measured" ? "measured" : "unavailable";
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      direction: def.direction,
      value: status === "measured" ? num(row?.value) : null,
      status,
      source: row?.source ? String(row.source) : null,
      window_end: row?.window_end ? String(row.window_end) : null,
      denominator: denominatorOf(row),
      caveat: null,
    };
  });

  const byKey = new Map(metrics.map((m) => [m.key, m]));
  const allSource = byKey.get(ALL_SOURCE_METRIC);
  if (!allSource || allSource.status !== "measured") return metrics;

  for (const [key, attribution] of Object.entries(CPA_ATTRIBUTION)) {
    const cpa = byKey.get(key);
    if (!cpa || cpa.status !== "measured") continue;
    const conv = cpa.denominator ? ` (${cpa.denominator.conversions})` : "";
    const signups = allSource.value === null ? "" : ` (${allSource.value})`;
    cpa.caveat =
      `${cpa.label} counts only ${attribution} conversions${conv}; ` +
      `${allSource.label} counts every source${signups}. ` +
      `The two do not divide into each other.`;
  }

  return metrics;
}

function metricKeysFor(slug: string): string[] {
  if (!recipeExists(slug)) return [];
  try {
    return (loadChannelRecipe(slug).meta.watch?.signals ?? []).map((s) => s.key);
  } catch {
    return [];
  }
}

async function readChannels(
  sb: Sb,
  tenant_id: string,
  measured: ReadonlySet<string>,
  failed: Set<GrowthPlanSection>,
): Promise<GrowthPlanChannel[]> {
  const { data, error } = await sb
    .from("tenant_channels")
    .select("*")
    .eq("tenant_id", tenant_id)
    .limit(200);

  if (error) {
    warn(failed, "channels", tenant_id, error.message);
    return [];
  }
  const autopilot = await readAutopilotState(tenant_id).catch((e: Error) => {
    console.warn(`[growth-plan] autopilot state unreadable for ${tenant_id}: ${e.message}`);
    return null;
  });

  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((c) => !RETIRED_CHANNEL_SLUGS.has(String(c.channel_slug ?? "")))
    .map((c) => {
      const slug = String(c.channel_slug ?? "");
      const metric_keys = metricKeysFor(slug);
      const metric_availability: GrowthPlanChannel["metric_availability"] =
        metric_keys.length === 0
          ? "none"
          : metric_keys.some((k) => measured.has(k))
            ? "measured"
            : "unavailable";
      return {
        slug,
        last_run_at: str(c.last_run_at),
        last_run_status: str(c.work_state),
        metric_keys,
        metric_availability,
        autorun: autopilot
          ? resolveChannelAutorun(autopilot, slug, c as AutorunRow).display
          : c.autorun === true && (slug !== "chatgpt_ads" || !!c.chatgpt_autopilot_consent_at),
        auto_capable: channelAutoCapable(slug),
        autorun_set_by: str(c.autorun_set_by) ?? "",
        plan_selected: c.plan_selected === true,
        plan_selected_set_by:
          c.plan_selected_set_by === "founder"
            ? ("founder" as const)
            : c.plan_selected_set_by === "plan"
              ? ("plan" as const)
              : c.plan_selected_set_by === "founder_stopped"
                ? ("founder_stopped" as const)
                : null,
        cgo_reason: str(c.cgo_reason),
        cgo_set_at: str(c.cgo_set_at),
      };
    })
    .sort((a, b) => {
      const at = a.last_run_at ? Date.parse(a.last_run_at) : -1;
      const bt = b.last_run_at ? Date.parse(b.last_run_at) : -1;
      return bt - at || a.slug.localeCompare(b.slug);
    });
}

async function readChanges(
  sb: Sb,
  tenant_id: string,
  failed: Set<GrowthPlanSection>,
): Promise<GrowthPlanChange[]> {
  const { data, error } = await sb
    .from("growth_plan_changes")
    .select(
      "id, entity, entity_id, field, old_value, new_value, actor_kind, actor_ref, note, created_at",
    )
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(CHANGE_LOG_LIMIT);

  if (error) {
    warn(failed, "changes", tenant_id, error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((c) => ({
    id: String(c.id),
    entity: String(c.entity ?? ""),
    entity_id: str(c.entity_id),
    field: String(c.field ?? ""),
    old_value: str(c.old_value),
    new_value: str(c.new_value),
    actor_kind: String(c.actor_kind ?? ""),
    actor_ref: str(c.actor_ref),
    note: str(c.note),
    created_at: String(c.created_at ?? ""),
  }));
}

export function noteView(n: {
  saw: string[] | null;
  changed: string[] | null;
  would_change: string[] | null;
  need: string[] | null;
  questions?: string[] | null;
  created_at: string;
  next_review_at: string;
  items?: unknown;
  headline?: string | null;
}): NonNullable<HeadOfGrowth["note"]> {
  const base = { saw: n.saw ?? [], changed: n.changed ?? [], would_change: n.would_change ?? [], created_at: n.created_at, next_review_at: n.next_review_at };
  const items = parseNoteItems(n.items);
  const built =
    items && items.length > 0
      ? {
          headline: n.headline?.trim() || deriveHeadline(items),
          sections: noteSections(items, {
            wouldChange: n.would_change ?? [],
            link: (i) =>
              i.plans
                ? "/pricing"
                : i.section === "needs_you" && i.locations && i.channel_slug
                ? `/workspace?tab=channels&channel=${encodeURIComponent(i.channel_slug)}&locations=1`
                : i.section === "needs_you" && i.action_id && i.channel_slug
                  ? `/workspace?tab=channels&channel=${encodeURIComponent(i.channel_slug)}&action=${encodeURIComponent(i.action_id)}`
                  : null,
            moreUrl: "/workspace?tab=growth-strategy",
            needsLimit: Infinity,
            channelLink: (slug) => `/workspace?tab=channels&channel=${encodeURIComponent(slug)}`,
          }).map(withUndo),
        }
      : {};
  if (!Array.isArray(n.questions)) return { ...base, need: n.need ?? [], ...built };
  return { ...base, need: (n.need ?? []).slice(n.questions.length), questions: n.questions, ...built };
}

export type NeedsYouFix =
  | { kind: "reconnect"; slug: string }
  | { kind: "budget" }
  | { kind: "check"; decision_id: string }
  | { kind: "locations"; channel_slug: string }
  | { kind: "action"; channel_slug: string; action_id: string };

export function needsYouFix(i: NoteItem): NeedsYouFix | null {
  if (i.section !== "needs_you" || i.question_ordinal != null) return null;
  const b = i.blocker_id ?? "";
  const conn = /^connector:([a-z0-9_.]+)$/.exec(b);
  if (conn) return { kind: "reconnect", slug: conn[1] };
  const account = /^account:([a-z0-9_.]+)$/.exec(b);
  if (account) return /^Reconnect\b/.test(i.text ?? "") ? { kind: "reconnect", slug: account[1] } : null;
  const read = /^ad_read_failed:[^:]+:([a-z0-9_]+):/.exec(b);
  if (read) {
    const slug = platformNativeSlug(read[1]);
    return slug ? { kind: "reconnect", slug } : null;
  }
  if (/^(?:budget_brake|budget_stop):/.test(b)) return { kind: "budget" };
  const check = /^check:decision:(.+)$/.exec(b);
  if (check) return { kind: "check", decision_id: check[1] };
  if (i.locations && i.channel_slug) return { kind: "locations", channel_slug: i.channel_slug };
  if (i.action_id && i.channel_slug)
    return { kind: "action", channel_slug: i.channel_slug, action_id: i.action_id };
  return null;
}

function withUndo(s: NoteSectionView): NoteSectionWire {
  return {
    key: s.key,
    title: s.title,
    more: s.more,
    rows: s.rows.map((r) => {
      const i = r.item;
      const undo =
        i?.section === "changed" && i.undoable === true
          ? i.goal_id
            ? { kind: "goal" as const, goal_id: i.goal_id }
            : i.channel_slug
              ? { kind: "channel" as const, channel_slug: i.channel_slug }
              : undefined
          : undefined;
      return {
        line: r.line,
        url: r.url,
        ...(r.url && i?.plans ? { url_label: "See plans" } : r.url && r.label ? { url_label: r.label } : {}),
        ...(r.group ? { sub: [...r.group.lines, ...(r.group.note ? [r.group.note] : [])] } : {}),
        ...(r.question_ordinal != null ? { question_ordinal: r.question_ordinal } : {}),
        ...(undo ? { undo } : {}),
        ...(i?.blocker_severity === "urgent" ? { urgent: true as const } : {}),
        ...(() => {
          const fix = i ? needsYouFix(i) : null;
          return fix ? { fix } : {};
        })(),
        ...(() => {
          const rid = i?.blocker_id ?? i?.action_id;
          return rid ? { rid: String(rid).slice(0, 120) } : {};
        })(),
      };
    }),
  };
}

async function readHeadOfGrowth(sb: Sb, tenant_id: string, failed: Set<GrowthPlanSection>): Promise<HeadOfGrowth> {
  const empty: HeadOfGrowth = { autopilot: false, note: null, undoable: [] };
  try {
    const { getBoolSettingStrictResolved } = await import("@/services/settings");
    const { isBlockerNote, isNoteVisible } = await import("@/services/growth/goal-owner");
    const [autopilot, notes, goals] = await Promise.all([
      getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id),
      sb
        .from("cgo_notes")
        .select("kind, saw, changed, would_change, need, questions, created_at, next_review_at, items, headline, alarm_keys")
        .eq("tenant_id", tenant_id)
        .or("changed.neq.{},need.neq.{},would_change.neq.{},items.not.is.null")
        .order("created_at", { ascending: false })
        .limit(20),
      sb
        .from("autopilot_goals")
        .select("id, status, cgo_undo")
        .eq("tenant_id", tenant_id)
        .eq("status", "active")
        .not("cgo_undo", "is", null),
    ]);
    if (notes.error || goals.error) {
      warn(failed, "head_of_growth", tenant_id, (notes.error ?? goals.error)!.message);
      return { ...empty, autopilot };
    }
    type NoteRow = {
      kind: "scheduled" | "alarm" | "founder";
      saw: string[] | null;
      changed: string[] | null;
      would_change: string[] | null;
      need: string[] | null;
      questions: string[] | null;
      created_at: string;
      next_review_at: string;
      items: unknown[] | null;
      headline: string | null;
      alarm_keys?: string[] | null;
    };
    const n = ((notes.data ?? []) as NoteRow[]).find((x) => isNoteVisible(x) && !isBlockerNote(x.alarm_keys));
    let merged: NoteRow | null = n ?? null;
    try {
      const { loadBlockerSources, deriveBlockers, rankBlockers, blockerItem } = await import(
        "@/services/growth/cgo-blockers"
      );
      const now = new Date();
      const src = await loadBlockerSources(tenant_id, now, { lite: true });
      const ranked = rankBlockers(deriveBlockers(src, now), new Map());
      const live = ranked.filter((r) => r.b.who === "you");
      const liveIds = new Set(live.map((r) => r.b.id));
      const liveActionIds = new Set(live.map((r) => r.b.action_id).filter(Boolean));
      const liveItems = live.map((r) => blockerItem(r.b, r.severity, r.state, now));
      if (n) {
        const stored = parseNoteItems(n.items) ?? [];
        const LITE_ONLY = /^(ad_read_failed:|ad_read_slow:|ad_disconnected:|budget_brake:|budget_stop:|stuck:|check:decision:[0-9a-f-]{36}$)|^spend_data$/;
        const kept = stored.filter((i) => {
          if (i.section === "needs_you" && i.action_id && liveActionIds.has(i.action_id)) return false;
          if (!i.blocker_id) return true;
          if (liveIds.has(i.blocker_id)) return false;
          return !LITE_ONLY.test(i.blocker_id);
        });
        merged = { ...n, items: [...liveItems, ...kept] };
      } else if (liveItems.length) {
        merged = {
          kind: "alarm",
          saw: [],
          changed: [],
          would_change: [],
          need: [],
          questions: [],
          created_at: new Date().toISOString(),
          next_review_at: new Date().toISOString(),
          items: liveItems,
          headline: null,
        } as unknown as NoteRow;
      }
    } catch (e) {
      if (!n) {
        warn(failed, "head_of_growth", tenant_id, (e as Error).message);
        return empty;
      }
    }
    return {
      autopilot,
      note: merged ? noteView(merged) : null,
      undoable: ((goals.data ?? []) as Array<{ id: string; cgo_undo: { why?: unknown; at?: unknown; prev?: { objective?: unknown } } | null }>).map((g) => ({
        goal_id: g.id,
        why: String(g.cgo_undo?.why ?? ""),
        at: String(g.cgo_undo?.at ?? ""),
        prev_objective: String(g.cgo_undo?.prev?.objective ?? ""),
      })),
    };
  } catch (e) {
    warn(failed, "head_of_growth", tenant_id, (e as Error).message);
    return empty;
  }
}

async function readGoalWork(
  sb: Sb,
  tenant_id: string,
  failed: Set<GrowthPlanSection>,
): Promise<{ work: Record<string, GoalWork>; conflicts: ConstraintConflict[] }> {
  const conflicts: ConstraintConflict[] = [];
  try {
    return { work: await readGoalWorkUnsafe(sb, tenant_id, failed, conflicts), conflicts };
  } catch (e) {
    warn(failed, "goal_work", tenant_id, (e as Error).message);
    return { work: {}, conflicts: [] };
  }
}

async function readGoalWorkUnsafe(
  sb: Sb,
  tenant_id: string,
  failed: Set<GrowthPlanSection>,
  conflicts: ConstraintConflict[],
): Promise<Record<string, GoalWork>> {
  const out: Record<string, GoalWork> = {};
  const since = new Date(Date.now() - GOAL_WORK_DAYS * 86_400_000).toISOString();

  const [lines, waiting, history] = await Promise.all([
    sb.from("autopilot_goals").select("id, status, cgo_status_line, cgo_status_at").eq("tenant_id", tenant_id),
    sb
      .from("decisions")
      .select("id, status, body, emitted_at")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", CGO_CARD_CLASS)
      .eq("status", "proposed")
      .order("emitted_at", { ascending: false }),
    sb
      .from("decisions")
      .select("id, status, body, emitted_at")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", CGO_CARD_CLASS)
      .neq("status", "proposed")
      .gte("emitted_at", since)
      .order("emitted_at", { ascending: false })
      .limit(100),
  ]);
  if (lines.error || waiting.error || history.error) {
    warn(failed, "goal_work", tenant_id, (lines.error ?? waiting.error ?? history.error)!.message);
    return out;
  }
  const cards = { data: [...(waiting.data ?? []), ...(history.data ?? [])] };

  const ensure = (goal_id: string): GoalWork =>
    (out[goal_id] ??= { status_line: null, status_at: null, moves: [], hypotheses: [] });
  for (const g of (lines.data ?? []) as Array<{ id: string; cgo_status_line: string | null; cgo_status_at: string | null }>) {
    if (g.cgo_status_line) {
      const w = ensure(g.id);
      w.status_line = g.cgo_status_line;
      w.status_at = g.cgo_status_at;
    }
  }

  const cardRows = (cards.data ?? []) as Array<{ id: string; status: string; body: Record<string, unknown> | null; emitted_at: string }>;
  const shown = cardRows.filter((c) => c.status !== "expired" && c.status !== "superseded");

  const runsByCard = new Map<string, { id: string; status: string }>();
  const approvedIds = shown.filter((c) => c.status !== "proposed" && c.status !== "rejected").map((c) => c.id);
  if (approvedIds.length > 0) {
    const { data, error } = await sb
      .from("agent_runs")
      .select("id, status, payload")
      .eq("tenant_id", tenant_id)
      .in("payload->>source_decision_id", approvedIds);
    if (error) {
      warn(failed, "goal_work", tenant_id, error.message);
      return out;
    }
    for (const r of (data ?? []) as Array<{ id: string; status: string; payload: Record<string, unknown> | null }>) {
      const card = String(r.payload?.source_decision_id ?? "");
      if (card) runsByCard.set(card, { id: r.id, status: r.status });
    }
  }

  const execFailedRuns = new Set<string>();
  const runIds = [...runsByCard.values()].map((r) => r.id);
  if (runIds.length > 0) {
    const { data, error } = await sb
      .from("channel_actions")
      .select("run_id, exec_status")
      .eq("tenant_id", tenant_id)
      .eq("exec_status", "failed")
      .neq("status", "redone")
      .in("run_id", runIds);
    if (error) warn(failed, "goal_work", tenant_id, error.message);
    else for (const a of (data ?? []) as Array<{ run_id: string | null }>) if (a.run_id) execFailedRuns.add(a.run_id);
  }

  for (const c of shown) {
    const goal_id = String(c.body?.goal_id ?? "");
    if (!goal_id) continue;
    const w = ensure(goal_id);
    if (c.status !== "proposed" && w.moves.length >= GOAL_WORK_MOVES_PER_GOAL) continue;
    const run = runsByCard.get(c.id) ?? null;
    w.moves.push({
      decision_id: c.id,
      agent: String(c.body?.target_agent_slug ?? ""),
      intent: String(c.body?.intent ?? ""),
      why: c.body?.context_summary ? String(c.body.context_summary) : null,
      aims_to_move: typeof c.body?.moves_metric === "string" && c.body.moves_metric.trim() ? c.body.moves_metric.trim() : null,
      state: moveState(c.status, run?.status ?? null, run ? execFailedRuns.has(run.id) : false),
      run_id: run?.id ?? null,
      emitted_at: c.emitted_at,
      hypothesis_id: typeof c.body?.hypothesis_id === "string" ? c.body.hypothesis_id : null,
    });
  }

  const goalIds = ((lines.data ?? []) as Array<{ id: string }>).map((g) => g.id);
  if (goalIds.length === 0) return out;
  const { data: hyps, error: hypErr } = await sb
    .from("cgo_hypotheses")
    .select("id, goal_id, problem, segment, claim, status, rank, evidence, restates_plan_constraint, plan_constraint_marked_at, plan_kept_at, research_open")
    .eq("tenant_id", tenant_id)
    .in("goal_id", goalIds)
    .order("updated_at", { ascending: false })
    .limit(40 * goalIds.length);
  if (hypErr) {
    console.warn(`[growth-plan] hypotheses unreadable for tenant ${tenant_id}: ${hypErr.message}`);
    for (const id of goalIds) ensure(id).hypotheses_unavailable = true;
    return out;
  }
  type HypRow = { id: string; goal_id: string; problem: string | null; segment: string | null; claim: string; status: string; rank: number | null; evidence: unknown; restates_plan_constraint: boolean | null; plan_constraint_marked_at: string | null; plan_kept_at: string | null; research_open: boolean | null };
  const byGoal = new Map<string, HypRow[]>();
  for (const h of (hyps ?? []) as HypRow[]) {
    const list = byGoal.get(h.goal_id) ?? [];
    list.push(h);
    byGoal.set(h.goal_id, list);
  }
  for (const [goal_id, list] of byGoal) ensure(goal_id).hypotheses = goalHypotheses(list);
  conflicts.push(...constraintConflicts((lines.data ?? []) as Array<{ id: string; status: string | null }>, (hyps ?? []) as HypRow[]));
  return out;
}

export function moveState(cardStatus: string, runStatus: string | null, execFailed = false): GoalMoveState {
  if (cardStatus === "proposed") return "waiting";
  if (cardStatus === "rejected") return "declined";
  if (cardStatus === "dispatch_failed") return "failed";
  if (!runStatus) return "starting";
  if (runStatus === "queued" || runStatus === "running") return "running";
  if (runStatus === "success") return execFailed ? "blocked" : "done";
  return "failed";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function postAcceptSuggestedGoal(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid goal id" } });
    return;
  }
  const sb = serverClientFromBearer(auth.access_token);
  const { data: goal, error: readErr } = await sb
    .from("autopilot_goals")
    .select("status")
    .eq("id", id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<{ status: string }>();
  if (readErr) {
    res.status(500).json({ error: { code: "accept_failed", message: readErr.message } });
    return;
  }
  if (!goal || goal.status !== "proposed") {
    res.status(404).json({ error: { code: "no_suggested_goal", message: "That suggestion is no longer open." } });
    return;
  }
  const { count, error: countErr } = await sb
    .from("autopilot_goals")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", auth.tenant_id)
    .eq("status", "active");
  if (countErr) {
    res.status(500).json({ error: { code: "accept_failed", message: countErr.message } });
    return;
  }
  if ((count ?? 0) >= MAX_ACTIVE_GOALS) {
    res.status(409).json({
      error: {
        code: "goal_limit_reached",
        message: `You can have at most ${MAX_ACTIVE_GOALS} active goals. Pause or delete one first.`,
      },
    });
    return;
  }
  const { error } = await sb.rpc("confirm_proposed_goal", { p_goal_id: id });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "P0002") {
      res.status(404).json({ error: { code: "no_suggested_goal", message: "That suggestion is no longer open." } });
    } else if (code === "42501") {
      res.status(403).json({ error: { code: "forbidden", message: "not a member of this workspace" } });
    } else {
      res.status(500).json({ error: { code: "accept_failed", message: error.message } });
    }
    return;
  }
  await sendGoalAttention({ tenant_id: auth.tenant_id, reason: "goal_set", goal_id: id });
  res.json({ ok: true });
}

export async function postKeepPlanConflict(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = req.params.hypothesisId;
  const kept = (req.body as { kept?: unknown } | undefined)?.kept;
  if (typeof id !== "string" || !UUID_RE.test(id) || typeof kept !== "boolean") {
    res.status(400).json({ error: { code: "bad_request", message: "invalid hypothesis id or kept flag" } });
    return;
  }
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "set_hypothesis_plan_kept", {
    p_hypothesis_id: id,
    p_actor: auth.user_id,
    p_kept: kept,
  });
  if (error) {
    if ((error as { code?: string }).code === "P0002") {
      res.status(404).json({ error: { code: "no_conflict", message: "That conflict is no longer open." } });
    } else {
      res.status(500).json({ error: { code: "keep_failed", message: error.message } });
    }
    return;
  }
  const keptAt = (data as { kept_at?: string | null } | null)?.kept_at ?? null;
  res.json({ ok: true, kept_at: keptAt });
}

async function readChannelFits(
  tenant_id: string,
  bets: readonly GrowthPlanBet[],
): Promise<ReadonlyMap<string, { value: "high" | "medium" | "low"; line: string }>> {
  try {
    const { readStrategyFit, pinLiveBetsHigh } = await import("@/services/growth/channel-fit");
    const { fits } = await readStrategyFit(tenant_id);
    const live = new Map(
      bets.filter((b) => b.channel_slug).map((b) => [b.channel_slug!, { intent: b.intent, rationale: b.rationale, status: b.status }]),
    );
    return pinLiveBetsHigh(fits, live);
  } catch (e) {
    console.warn(`[growth-plan] channel fit unreadable for tenant=${tenant_id}: ${(e as Error).message}`);
    return new Map();
  }
}

export function needsYouByChannel(h: HeadOfGrowth): Map<string, string> {
  const out = new Map<string, string>();
  for (const section of h.note?.sections ?? []) {
    if (section.key !== "needs_you") continue;
    for (const row of section.rows) {
      const fix = row.fix;
      const slug = fix && (fix.kind === "action" || fix.kind === "locations") ? fix.channel_slug : null;
      if (slug && !out.has(slug)) out.set(slug, row.line);
    }
  }
  return out;
}

function formatMetric(m: GrowthPlanMetric): string {
  const v = m.value ?? 0;
  const n = Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (m.unit === "usd" || m.unit === "currency") return `$${n}`;
  if (m.unit === "ratio") return `${(v * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  return n;
}

export function betResult(
  channel_slug: string | null,
  metrics: readonly GrowthPlanMetric[],
  channel: Pick<GrowthPlanChannel, "metric_keys" | "last_run_at"> | null,
  blockers: ReadonlyMap<string, string>,
  tz: string = "UTC",
): BetResult | null {
  if (!channel_slug) return null;
  const blocked = blockers.get(channel_slug);
  if (blocked) return { line: blocked, label: "blocked", source: null };
  const keys = channel?.metric_keys ?? metricKeysFor(channel_slug);
  const m = metrics.find((x) => keys.includes(x.key) && x.status === "measured" && x.value !== null);
  if (m) return { line: `${m.label}: ${formatMetric(m)}`, label: "measured", source: m.source };
  const last = enteredDay(channel?.last_run_at, tz);
  return {
    line: last ? `No number to read yet. Last worked on ${last}.` : "No number to read yet. Not started.",
    label: "unmeasured",
    source: null,
  };
}

export async function getGrowthPlan(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(auth.access_token);
  const tenant_id = auth.tenant_id;

  const failed = new Set<GrowthPlanSection>();

  try {
    const plan = await readPlan(sb, tenant_id, failed);

    const [bets, goals, snapshots, changes, detail, work, head_of_growth] = await Promise.all([
      readBets(sb, tenant_id, plan?.id ?? null, failed),
      readGoals(sb, tenant_id, failed),
      readLatestSnapshots(sb, tenant_id, failed),
      readChanges(sb, tenant_id, failed),
      readPlanDetail(sb, tenant_id),
      readGoalWork(sb, tenant_id, failed),
      readHeadOfGrowth(sb, tenant_id, failed),
    ]);

    const metrics = buildMetrics(snapshots);
    const measured = new Set(
      metrics.filter((m) => m.status === "measured").map((m) => m.key),
    );
    const channels = await readChannels(sb, tenant_id, measured, failed);
    const fits = await readChannelFits(tenant_id, bets);
    for (const c of channels) c.fit = fits.get(c.slug) ?? null;
    const blockers = needsYouByChannel(head_of_growth);
    const tz = bets.length > 0 ? await goalTimeZone(tenant_id) : "UTC";
    const withResults = bets.map((b) => ({
      ...b,
      result: betResult(b.channel_slug, metrics, channels.find((c) => c.slug === b.channel_slug) ?? null, blockers, tz),
    }));

    res.json({
      plan,
      bets: withResults,
      goals,
      metrics,
      channels,
      changes,
      detail,
      goal_work: work.work,
      head_of_growth,
      constraint_conflicts: currentConflicts(work.conflicts, plan?.updated_at),
      unreadable: [...failed],
    } satisfies GrowthPlanResponse);
  } catch (e) {
    res.status(500).json({
      error: { code: "growth_plan_failed", message: (e as Error).message },
    });
  }
}
