
import { decisionCardTitle } from "@/services/approvals/decision-copy";
import { adChangeHeadline } from "@zavi/shared";
import { GROWTH_PAGE_ONLY_NOT_IN } from "@/services/approvals/growth-page-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeBriefForCustomer } from "./morning-brief-sanitize";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { isCriticalDecision } from "@/services/decisions/is-critical";

type ConductorRunRow = {
  id: string;
  objective: string | null;
  status: string;
  kind: string | null;
  spend_usd: number | string | null;
  created_at: string;
  updated_at: string | null;
};

type AgentRunCostRow = {
  cost_usd: number | string | null;
};

type GoalRow = {
  objective: string;
  target_metric: string;
  current_value: number | string | null;
  target_value: number | string | null;
  status: string;
};

export type ActivityKind = "build_done" | "plan_proposed" | "suggestion" | "undo";

export type ActivityItem = {
  kind: ActivityKind;
  label: string;
  at: string;
  link: string | null;
};

export type TopDecision = {
  id: string;
  title: string;
  recommendation?: string;
  impact?: string;
  risk?: string;
  is_critical?: boolean;
  age_days?: number;
};

export type MorningBriefResponse = {
  yesterday: {
    builds_started: number;
    builds_done: number;
    builds_failed: number;
    spend_usd: number;
    pr_count: number | null;
  };
  today: {
    proposed_plans: number;
    pending_suggestions: number | null;
    pending_approvals: number;
    critical_approvals?: number;
    expired_unread_recent?: number;
  };
  goals: Array<{
    objective: string;
    target_metric: string;
    current_value: number | null;
    target_value: number | null;
    status: string;
  }>;
  recent_activity: ActivityItem[];
  standup_atoms?: Array<{
    atom_type: string;
    title: string;
    owner: string | null;
    due_date: string | null;
    meeting_date: string | null;
  }>;
  top_decisions?: TopDecision[];
  growth_do_this_first?: string | null;
  _sanitize_violations?: string[];
};

export function startOfYesterdayUtc(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
}

export function startOfTodayUtc(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const INTERNAL_BUILD_RE = /^\s*\[(refine|smoke|test|qa|internal|draft)\]/i;
function isInternalBuild(objective: string | null | undefined): boolean {
  return typeof objective === "string" && INTERNAL_BUILD_RE.test(objective);
}

export function isMissingTableError(
  err: { code?: string; message?: string } | null,
): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("relation");
}

function bodyStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s.slice(0, 280) : undefined;
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  const sentence = (m ? m[0] : s).trim();
  return sentence.length > 120 ? `${sentence.slice(0, 117)}…` : sentence;
}

function humanizeDecisionClass(decisionClass: string | null, body?: unknown): string {
  if (!decisionClass) return "Decision needs your call";
  if (decisionClass === "bulk_outbound.send") return decisionCardTitle(decisionClass, body);
  const [agent, action] = decisionClass.split(".");
  const pretty = (s: string | undefined) =>
    (s ?? "").replace(/[-_]/g, " ").trim();
  const a = pretty(agent);
  const act = pretty(action);
  if (a && act) return `${a.charAt(0).toUpperCase()}${a.slice(1)}: ${act}`;
  return a ? `${a.charAt(0).toUpperCase()}${a.slice(1)}` : "Decision needs your call";
}

export function buildDecisionCard(
  id: string,
  decisionClass: string | null,
  rawBody: unknown,
): TopDecision | null {
  const b: Record<string, unknown> =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>)
      : {};

  const ev =
    b.decision_evidence && typeof b.decision_evidence === "object"
      ? (b.decision_evidence as Record<string, unknown>)
      : {};

  const titleRaw =
    bodyStr(b.title) ??
    bodyStr(b.headline) ??
    bodyStr(b.theme) ??
    bodyStr(b.intent) ??
    bodyStr(b.what) ??
    bodyStr(b.summary) ??
    (bodyStr(b.rationale) ? firstSentence(bodyStr(b.rationale)!) : undefined);
  const adTitle = adChangeHeadline(decisionClass, b);
  const title = adTitle ?? (titleRaw ? firstSentence(titleRaw) : humanizeDecisionClass(decisionClass, b));

  const recommendation =
    bodyStr(b.recommendation) ??
    (bodyStr(b.summary) && bodyStr(b.summary) !== title ? bodyStr(b.summary) : undefined);

  const impact = bodyStr(b.impact) ?? bodyStr(ev.impact);
  const risk = bodyStr(b.risk) ?? bodyStr(ev.blast_radius);

  return { id, title, recommendation, impact, risk };
}

export async function assembleMorningBrief(
  supabase: SupabaseClient,
  tenant_id: string,
  now: Date,
): Promise<MorningBriefResponse> {
  const yStart = startOfYesterdayUtc(now);
  const tStart = startOfTodayUtc(now);

  const [
    yesterdayBuildsRes,
    yesterdayCostRes,
    todayProposedRes,
    todayPendingDecRes,
    goalsRes,
    suggestionsRes,
    recentBuildsRes,
    recentProposalsRes,
    recentUndoRes,
    topDecisionsRes,
    standupAtomsRes,
    expiredRecentRes,
    growthPlanRes,
  ] = await Promise.all([
    supabase
      .from("conductor_runs")
      .select("id, objective, status, kind, created_at")
      .eq("tenant_id", tenant_id)
      .eq("kind", "build_app")
      .gte("created_at", yStart)
      .lt("created_at", tStart),

    supabase
      .from("agent_runs")
      .select("cost_usd")
      .eq("tenant_id", tenant_id)
      .gte("started_at", yStart)
      .lt("started_at", tStart),

    supabase
      .from("conductor_runs")
      .select("id, objective, created_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed")
      .eq("kind", "company_goal")
      .gte("created_at", tStart),

    supabase
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed")
      .not("decision_class", "in", GROWTH_PAGE_ONLY_NOT_IN),

    supabase
      .from("autopilot_goals")
      .select("objective, target_metric, current_value, target_value, status")
      .eq("tenant_id", tenant_id)
      .in("status", ["active", "met", "missed", "paused"])
      .order("priority", { ascending: false })
      .limit(20),

    supabase
      .from("refine_suggestions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("status", "pending"),

    supabase
      .from("conductor_runs")
      .select("id, objective, status, kind, updated_at")
      .eq("tenant_id", tenant_id)
      .eq("kind", "build_app")
      .in("status", ["done", "failed", "halted"])
      .gte("updated_at", yStart)
      .order("updated_at", { ascending: false })
      .limit(10),

    supabase
      .from("conductor_runs")
      .select("id, objective, created_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed")
      .eq("kind", "company_goal")
      .gte("created_at", yStart)
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("autopilot_action_ledger")
      .select("id, conductor_run_id, action, target_agent_slug, created_at")
      .eq("tenant_id", tenant_id)
      .eq("action", "undo")
      .gte("created_at", yStart)
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("decisions")
      .select("id, decision_class, body, status, emitted_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed")
      .not("decision_class", "in", GROWTH_PAGE_ONLY_NOT_IN)
      .order("emitted_at", { ascending: false })
      .limit(500),
    supabase
      .from("meeting_atoms")
      .select("atom_type, title, owner, due_date, created_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "auto_stored")
      .gt("expires_at", now.toISOString())
      .order("created_at", { ascending: false })
      .limit(8),

    supabase
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("status", "expired")
      .gte("emitted_at", new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()),

    supabase
      .from("memory_note")
      .select("metadata")
      .eq("tenant_id", tenant_id)
      .eq("note_type", "growth_priorities")
      .contains("tags", ["current-growth-plan"])
      .is("superseded_by", null)
      .order("updated_at", { ascending: false })
      .limit(1),

  ]);

  const yBuilds = ((yesterdayBuildsRes.data ?? []) as ConductorRunRow[]).filter(
    (b) => !isInternalBuild(b.objective),
  );
  const builds_started = yBuilds.length;
  const builds_done = yBuilds.filter((b) => b.status === "done").length;
  const builds_failed = yBuilds.filter((b) => b.status === "failed").length;

  const spend_usd = ((yesterdayCostRes.data ?? []) as AgentRunCostRow[]).reduce(
    (s, r) => s + num(r.cost_usd),
    0,
  );

  const pr_count: number | null = null;

  const proposed_plans = ((todayProposedRes.data ?? []) as ConductorRunRow[])
    .length;

  let pending_suggestions: number | null;
  if (isMissingTableError(suggestionsRes.error)) {
    pending_suggestions = null;
  } else if (suggestionsRes.error) {
    pending_suggestions = null;
  } else {
    pending_suggestions = suggestionsRes.count ?? 0;
  }

  const pending_approvals = todayPendingDecRes.count ?? 0;

  let goals: MorningBriefResponse["goals"] = [];
  if (!goalsRes.error) {
    goals = ((goalsRes.data ?? []) as GoalRow[]).map((g) => ({
      objective: decodeXmlEntities(g.objective),
      target_metric: decodeXmlEntities(g.target_metric),
      current_value:
        g.current_value === null || g.current_value === undefined
          ? null
          : num(g.current_value),
      target_value:
        g.target_value === null || g.target_value === undefined
          ? null
          : num(g.target_value),
      status: g.status,
    }));
  }

  let standup_atoms: MorningBriefResponse["standup_atoms"] = [];
  if (!standupAtomsRes.error) {
    standup_atoms = ((standupAtomsRes.data ?? []) as Array<{
      atom_type: string;
      title: string;
      owner: string | null;
      due_date: string | null;
      created_at: string | null;
    }>).map((a) => ({
      atom_type: a.atom_type,
      title: a.title,
      owner: a.owner ?? null,
      due_date: a.due_date ?? null,
      meeting_date: a.created_at ? a.created_at.slice(0, 10) : null,
    }));
  }

  const activity: ActivityItem[] = [];

  for (const r of (recentBuildsRes.data ?? []) as ConductorRunRow[]) {
    if (!r.updated_at) continue;
    if (isInternalBuild(r.objective)) continue;
    const label =
      r.status === "done"
        ? `Build done: ${r.objective ?? r.id}`
        : r.status === "failed"
          ? `Build failed: ${r.objective ?? r.id}`
          : `Build halted: ${r.objective ?? r.id}`;
    activity.push({
      kind: "build_done",
      label,
      at: r.updated_at,
      link: `/workspace?run=${encodeURIComponent(r.id)}`,
    });
  }

  for (const r of (recentProposalsRes.data ?? []) as ConductorRunRow[]) {
    activity.push({
      kind: "plan_proposed",
      label: `Plan proposed: ${r.objective ?? r.id}`,
      at: r.created_at,
      link: `/workspace?run=${encodeURIComponent(r.id)}`,
    });
  }

  type LedgerRow = {
    id: string;
    conductor_run_id: string | null;
    action: string | null;
    target_agent_slug: string | null;
    created_at: string;
  };
  for (const r of (recentUndoRes.data ?? []) as LedgerRow[]) {
    const who = r.target_agent_slug ? ` (${r.target_agent_slug})` : "";
    activity.push({
      kind: "undo",
      label: `Undo dispatched node${who}`,
      at: r.created_at,
      link: r.conductor_run_id
        ? `/workspace?run=${encodeURIComponent(r.conductor_run_id)}`
        : null,
    });
  }

  activity.sort((a, b) => {
    const at = Date.parse(a.at);
    const bt = Date.parse(b.at);
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
  const seenActivity = new Set<string>();
  const dedupedActivity: ActivityItem[] = [];
  for (const a of activity) {
    const day = a.at.slice(0, 10);
    const key = `${a.kind}|${a.label}|${day}`;
    if (seenActivity.has(key)) continue;
    seenActivity.add(key);
    dedupedActivity.push(a);
  }
  const recent_activity = dedupedActivity.slice(0, 10);

  let top_decisions: TopDecision[] = [];
  let critical_approvals = 0;
  if (!topDecisionsRes.error) {
    type DecisionRow = {
      id: string;
      decision_class: string | null;
      body: unknown;
      status: string;
      emitted_at: string | null;
    };
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cards: TopDecision[] = ((topDecisionsRes.data ?? []) as DecisionRow[])
      .map((d): TopDecision | null => {
        const card = buildDecisionCard(d.id, d.decision_class, d.body);
        if (!card) return null;
        const is_critical = isCriticalDecision(d.decision_class, d.body);
        const ageMs = d.emitted_at ? now.getTime() - Date.parse(d.emitted_at) : NaN;
        const age_days = Number.isFinite(ageMs)
          ? Math.max(0, Math.floor(ageMs / DAY_MS))
          : undefined;
        return { ...card, is_critical, ...(age_days !== undefined ? { age_days } : {}) };
      })
      .filter((c): c is TopDecision => c !== null);
    critical_approvals = cards.filter((c) => c.is_critical).length;
    const ranked = cards
      .slice()
      .sort(
        (a, b) =>
          Number(!!b.is_critical) - Number(!!a.is_critical) ||
          (a.is_critical && b.is_critical
            ? (b.age_days ?? 0) - (a.age_days ?? 0)
            : 0),
      );
    top_decisions = ranked.slice(0, 5);
  }

  const expired_unread_recent = expiredRecentRes.error
    ? 0
    : expiredRecentRes.count ?? 0;

  let growth_do_this_first: string | null = null;
  if (!growthPlanRes.error) {
    const row = Array.isArray(growthPlanRes.data) ? growthPlanRes.data[0] : null;
    const meta =
      row && typeof row === "object"
        ? (row as Record<string, unknown>).metadata
        : null;
    const plan =
      meta && typeof meta === "object"
        ? (meta as Record<string, unknown>).plan
        : null;
    const nowAction =
      plan && typeof plan === "object"
        ? (plan as Record<string, unknown>).now
        : null;
    const action =
      nowAction && typeof nowAction === "object"
        ? (nowAction as Record<string, unknown>).action
        : null;
    if (typeof action === "string" && action.trim()) {
      growth_do_this_first = action.trim();
    }
  }

  const assembled: MorningBriefResponse = {
    top_decisions,
    ...(growth_do_this_first ? { growth_do_this_first } : {}),
    yesterday: {
      builds_started,
      builds_done,
      builds_failed,
      spend_usd,
      pr_count,
    },
    today: {
      proposed_plans,
      pending_suggestions,
      pending_approvals,
      ...(critical_approvals > 0 ? { critical_approvals } : {}),
      ...(expired_unread_recent > 0 ? { expired_unread_recent } : {}),
    },
    goals,
    recent_activity,
    standup_atoms,
  };

  const { brief: scrubbed, violations } = sanitizeBriefForCustomer(assembled);
  return violations.length > 0
    ? { ...scrubbed, _sanitize_violations: violations }
    : scrubbed;
}
