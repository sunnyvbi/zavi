"use client";

import type { GoalTrajectory } from "./goalTrajectory";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

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
  founder_constraint?: string | null;
  founder_constraint_at?: string | null;
  constraint_agreed_at?: string | null;
};

export type GrowthBetStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "superseded"
  | "done";

export type GrowthBet = {
  id: string;
  channel_slug: string | null;
  intent: string;
  rationale: string | null;
  expected_effect: string | null;
  falsifier: string | null;
  status: GrowthBetStatus;
  rejected_reason: string | null;
  sort_order: number | null;
  result?: { line: string; label: "measured" | "unmeasured" | "blocked"; source: string | null } | null;
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
  source: string | null;
  falsifier: string | null;
  status_changed_by: string | null;
  status_changed_at: string | null;
  measurement_mode?: string | null;
  measure_source?: string | null;
  current_value_at?: string | null;
  counted_as?: string | null;
  count_failing?: boolean;
  value_kind?: string | null;
  value_period_start?: string | null;
  trajectory?: GoalTrajectory;
  founder_estimate?: string | null;
};

export type GrowthGoals = {
  max_active: number | null;
  active_count: number;
  over_cap: boolean;
  items: GrowthGoal[];
};

export type GrowthMetricStatus = "measured" | "unavailable";

export type GrowthMetric = {
  key: string;
  label: string;
  unit: string | null;
  direction: string | null;
  value: number | null;
  status: GrowthMetricStatus;
  source: string | null;
  window_end: string | null;
  denominator: { spend: number; conversions: number } | null;
  caveat: string | null;
};

export type GrowthChannelAvailability = "measured" | "unavailable" | "none";

export type GrowthChannel = {
  slug: string;
  last_run_at: string | null;
  last_run_status: string | null;
  metric_keys: string[];
  metric_availability: GrowthChannelAvailability;
  autorun: boolean;
  auto_capable?: boolean;
  autorun_set_by: string;
  plan_selected: boolean;
  plan_selected_set_by?: "plan" | "founder" | "founder_stopped" | null;
  cgo_reason?: string | null;
  cgo_set_at?: string | null;
  fit?: { value: "high" | "medium" | "low"; line: string | null } | null;
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
    sections?: NoteSection[];
  } | null;
  undoable: Array<{ goal_id: string; why: string; at: string; prev_objective: string }>;
};

export type NoteRowUndo = { kind: "goal"; goal_id: string } | { kind: "channel"; channel_slug: string };
export type NoteRowFix =
  | { kind: "reconnect"; slug: string }
  | { kind: "budget" }
  | { kind: "check"; decision_id: string }
  | { kind: "locations"; channel_slug: string }
  | { kind: "action"; channel_slug: string; action_id: string };
export type NoteSectionRow = {
  line: string;
  url: string | null;
  url_label?: string;
  sub?: string[];
  question_ordinal?: number;
  undo?: NoteRowUndo;
  urgent?: true;
  fix?: NoteRowFix;
  rid?: string;
};
export type NoteSection = {
  key: "needs_you" | "changed" | "decided" | "would_change" | "working_on" | "blocked";
  title: string;
  rows: NoteSectionRow[];
  more: { count: number; url: string; line: string } | null;
};
const NOTE_SECTION_KEYS: ReadonlySet<string> = new Set(["needs_you", "changed", "decided", "would_change", "working_on", "blocked"]);

const relUrl = (v: unknown): string | null => (typeof v === "string" && /^\/(?![\/\\])/.test(v) ? v : null);

const SLUG_RE = /^[a-z0-9_.-]{1,64}$/;
function fixOf(v: unknown): NoteRowFix | undefined {
  const f = (v ?? {}) as Record<string, unknown>;
  if (f.kind === "reconnect" && typeof f.slug === "string" && SLUG_RE.test(f.slug)) return { kind: "reconnect", slug: f.slug };
  if (f.kind === "budget") return { kind: "budget" };
  if (f.kind === "check" && typeof f.decision_id === "string" && /^[0-9a-f-]{36}$/i.test(f.decision_id))
    return { kind: "check", decision_id: f.decision_id };
  if (f.kind === "locations" && typeof f.channel_slug === "string" && SLUG_RE.test(f.channel_slug))
    return { kind: "locations", channel_slug: f.channel_slug };
  if (f.kind === "action" && typeof f.channel_slug === "string" && SLUG_RE.test(f.channel_slug) && typeof f.action_id === "string" && f.action_id)
    return { kind: "action", channel_slug: f.channel_slug, action_id: String(f.action_id).slice(0, 80) };
  return undefined;
}

function undoOf(v: unknown): NoteRowUndo | undefined {
  const u = (v ?? {}) as Record<string, unknown>;
  if (u.kind === "goal" && typeof u.goal_id === "string" && u.goal_id) return { kind: "goal", goal_id: u.goal_id };
  if (u.kind === "channel" && typeof u.channel_slug === "string" && u.channel_slug) return { kind: "channel", channel_slug: u.channel_slug };
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
      const fix = fixOf(x.fix);
      const sub = Array.isArray(x.sub) ? x.sub.filter((l): l is string => typeof l === "string" && !!l.trim()).slice(0, 20) : [];
      return [{
        line: x.line,
        url: relUrl(x.url),
        ...(typeof x.url_label === "string" && x.url_label.trim() ? { url_label: x.url_label.trim().slice(0, 40) } : {}),
        ...(typeof x.question_ordinal === "number" && Number.isInteger(x.question_ordinal) ? { question_ordinal: x.question_ordinal } : {}),
        ...(undo ? { undo } : {}),
        ...(sub.length ? { sub } : {}),
        ...(x.urgent === true ? { urgent: true as const } : {}),
        ...(fix ? { fix } : {}),
        ...(typeof x.rid === "string" && x.rid.trim() ? { rid: x.rid.trim().slice(0, 120) } : {}),
      }];
    });
    const m = (s.more ?? null) as Record<string, unknown> | null;
    const more =
      m && typeof m.count === "number" && m.count > 0 && typeof m.line === "string" && relUrl(m.url)
        ? { count: m.count, url: relUrl(m.url)!, line: m.line }
        : null;
    if (rows.length === 0 && !more) continue;
    out.push({ key: s.key as NoteSection["key"], title: s.title, rows, more });
  }
  return out;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function headOfGrowthOf(raw: unknown): HeadOfGrowth {
  const h = (raw ?? {}) as Record<string, unknown>;
  const n = h.note as Record<string, unknown> | null | undefined;
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
            ...(noteSectionsOf(n.sections) ? { sections: noteSectionsOf(n.sections) } : {}),
          }
        : null,
    undoable: (Array.isArray(h.undoable) ? h.undoable : [])
      .map((u) => u as Record<string, unknown>)
      .filter((u) => typeof u.goal_id === "string")
      .map((u) => ({ goal_id: String(u.goal_id), why: String(u.why ?? ""), at: String(u.at ?? ""), prev_objective: String(u.prev_objective ?? "") })),
  };
}

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
  hypotheses?: GoalHypothesis[];
  hypotheses_unavailable?: boolean;
};

export type GoalHypothesisStatus = "listed" | "testing" | "confirmed" | "ruled_out";
export type GoalHypothesis = {
  id: string;
  claim: string;
  status: GoalHypothesisStatus;
  problem?: string | null;
  segment?: string | null;
  restates_plan_constraint?: boolean;
  research_running?: boolean;
  evidence: Array<{ at: string; verdict: string | null; quote: string | null; why: string | null }>;
};

export type ConstraintConflict = { goal_id: string; hypothesis_id: string; claim: string; kept_at?: string | null };

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

const HYP_STATUSES = new Set<GoalHypothesisStatus>(["listed", "testing", "confirmed", "ruled_out"]);
const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

export function hypothesesOf(raw: unknown): GoalHypothesis[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((h) => {
    if (!h || typeof h !== "object") return [];
    const x = h as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.claim !== "string" || !HYP_STATUSES.has(x.status as GoalHypothesisStatus)) return [];
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
        segment: strOrNull(x.segment),
        restates_plan_constraint: x.restates_plan_constraint === true,
        research_running: x.research_running === true,
        evidence,
      },
    ];
  });
}

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

export type GrowthPlanPayload = {
  detail?: GrowthPlanDetail;
  goal_work?: Record<string, GoalWork>;
  head_of_growth?: HeadOfGrowth;
  constraint_conflicts?: ConstraintConflict[];
  plan: GrowthPlanRow | null;
  bets: GrowthBet[];
  goals: GrowthGoals;
  metrics: GrowthMetric[];
  channels: GrowthChannel[];
  changes: GrowthChange[];
  unreadable: GrowthSection[];
};

export type GrowthPlanState = {
  data: GrowthPlanPayload | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  drafting: boolean;
  draftSlow: boolean;
  draftError?: string | null;
  watchForPlan: (runId?: string) => void;
  stopWatch: () => void;
};

export const POLL_MS = 10_000;
export const POLL_CAP_MS = 10 * 60_000;

function planKey(plan: GrowthPlanRow | null): string | null {
  return plan ? `${plan.source}:${plan.id}:${plan.version}:${plan.updated_at}` : null;
}

const EMPTY_GOALS: GrowthGoals = {
  max_active: null,
  active_count: 0,
  over_cap: false,
  items: [],
};

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const MOVE_STATES = new Set<GoalMoveState>(["waiting", "declined", "starting", "running", "done", "blocked", "failed"]);

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
      moves: moves.flatMap((m) => {
        if (!m || typeof m !== "object") return [];
        const x = m as Record<string, unknown>;
        if (typeof x.decision_id !== "string" || typeof x.agent !== "string" || typeof x.intent !== "string") return [];
        if (!MOVE_STATES.has(x.state as GoalMoveState)) return [];
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

export function normalizeGrowthPlan(raw: unknown): GrowthPlanPayload {
  const body = (raw ?? {}) as Partial<GrowthPlanPayload>;
  const goals = (body.goals ?? null) as Partial<GrowthGoals> | null;
  const items = list<GrowthGoal>(goals?.items);
  return {
    plan: body.plan
      ? {
          ...(body.plan as GrowthPlanRow),
          basis_evidence: list<GrowthBasisEvidence>(
            (body.plan as Partial<GrowthPlanRow>).basis_evidence,
          ),
        }
      : null,
    bets: list<GrowthBet>(body.bets),
    goals: goals
      ? {
          max_active:
            typeof goals.max_active === "number" ? goals.max_active : null,
          active_count:
            typeof goals.active_count === "number"
              ? goals.active_count
              : items.filter((g) => g.status === "active").length,
          over_cap: goals.over_cap === true,
          items,
        }
      : EMPTY_GOALS,
    metrics: list<GrowthMetric>(body.metrics),
    channels: list<GrowthChannel>(body.channels),
    changes: list<GrowthChange>(body.changes),
    goal_work: goalWorkOf(body.goal_work),
    head_of_growth: headOfGrowthOf(body.head_of_growth),
    constraint_conflicts: constraintConflictsOf(body.constraint_conflicts),
    unreadable: list<GrowthSection>(body.unreadable),
  };
}

export function useGrowthPlan(onPoll?: () => void): GrowthPlanState {
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;
  const [data, setData] = useState<GrowthPlanPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftSlow, setDraftSlow] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const mounted = useRef(true);
  const dataRef = useRef<GrowthPlanPayload | null>(null);
  const baseline = useRef<string | null>(null);
  const watchedRun = useRef<string | undefined>(undefined);

  const read = useCallback(async (quiet: boolean) => {
    if (!quiet) setLoading(true);
    try {
      const res = await apiFetch("/api/workspace/growth/plan");
      if (!res.ok) {
        if (!mounted.current || quiet) return;
        setError(`Couldn't load your plan (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as unknown;
      if (!mounted.current) return;
      const next = normalizeGrowthPlan(body);
      dataRef.current = next;
      setData(next);
      setError(null);
    } catch (e) {
      if (!mounted.current || quiet) return;
      setError((e as Error).message || "Couldn't load your plan.");
    } finally {
      if (mounted.current && !quiet) setLoading(false);
    }
  }, []);

  const reload = useCallback(() => read(false), [read]);
  const refresh = useCallback(() => read(true), [read]);

  const watchForPlan = useCallback((runId?: string) => {
    watchedRun.current = runId;
    setDraftError(null);
    baseline.current = planKey(dataRef.current?.plan ?? null);
    setDraftSlow(false);
    setDrafting(true);
  }, []);
  const stopWatch = useCallback(() => { watchedRun.current = undefined; setDrafting(false); setDraftSlow(false); }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!drafting) return;
    const started = Date.now();
    const id = setInterval(() => {
      if (Date.now() - started >= POLL_CAP_MS) {
        setDraftSlow(true);
        if ((Date.now() - started) % 30_000 >= POLL_MS) return;
      }
      void read(true);
      onPollRef.current?.();
      const run = watchedRun.current;
      if (run) void (async () => {
        try {
          const res = await apiFetch(`/api/agents/runs/${encodeURIComponent(run)}`);
          if (!res.ok || !mounted.current || watchedRun.current !== run) return;
          const body = await res.json() as { run?: { status?: string } };
          if (!mounted.current || watchedRun.current !== run) return;
          const status = body.run?.status ?? "";
          const failed = ["parse_failed", "dispatch_error", "failed", "error"].includes(status);
          if (failed || status === "cancelled") {
            setDrafting(false); setDraftSlow(false);
            watchedRun.current = undefined;
            if (failed) setDraftError("Your strategy could not finish. Please try again.");
          }
        } catch {  }
      })();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [drafting, read]);

  useEffect(() => {
    if (!drafting || !data) return;
    const plan = data.unreadable.includes("plan") ? null : data.plan;
    const key = planKey(plan);
    if (key !== null && key !== baseline.current && !plan?.pending_acceptance) setDrafting(false);
  }, [data, drafting]);

  return { data, loading, error, reload, refresh, drafting, draftSlow, draftError, watchForPlan, stopWatch };
}
