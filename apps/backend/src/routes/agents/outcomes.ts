
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

type OutcomeRow = {
  decision_id: string;
  tenant_id: string;
  action_class: string;
  decision_outcome: "approved" | "rejected";
  subject_type: string;
  subject_id: string;
  subject_name: string | null;
  target_metric: string;
  outcome_tier: "business" | "delivery";
  baseline_metrics: Record<string, unknown>;
  outcome_metrics: Record<string, unknown>;
  delta_metrics: Record<string, unknown>;
  baseline_status: string;
  reconcile_status: string;
  measurement_window_days: number;
  reconcile_after: string;
  measured_at: string | null;
  created_at: string;
};

type DecisionRow = {
  id: string;
  tenant_id: string;
  decision_class: string;
  status: string;
  approved_at: string | null;
  emitted_at: string;
};

export async function agentOutcomes(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;

  if (slug !== "performance-marketer") {
    res.json({ agent_slug: slug, outcomes: [], total: 0 });
    return;
  }

  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 50) : 20;

  const supabase = serverClientFromBearer(auth.access_token);

  const { data: outcomeData, error: oErr } = await supabase
    .from("action_outcomes")
    .select(
      "decision_id, tenant_id, action_class, decision_outcome, subject_type, subject_id, subject_name, target_metric, outcome_tier, baseline_metrics, outcome_metrics, delta_metrics, baseline_status, reconcile_status, measurement_window_days, reconcile_after, measured_at, created_at",
    )
    .like("action_class", "meta_ads.%")
    .order("created_at", { ascending: false })
    .limit(limit * 2);

  if (oErr) {
    res.status(500).json({ error: { code: "query_failed", message: oErr.message } });
    return;
  }
  const outcomes = (outcomeData ?? []) as OutcomeRow[];
  if (outcomes.length === 0) {
    res.json({ agent_slug: slug, outcomes: [], total: 0 });
    return;
  }

  const decisionIds = outcomes.map((o) => o.decision_id);
  const { data: decData, error: dErr } = await supabase
    .from("decisions")
    .select("id, tenant_id, decision_class, status, approved_at, emitted_at")
    .in("id", decisionIds)
    .in("status", ["approved", "rejected"]);

  if (dErr) {
    res.status(500).json({ error: { code: "query_failed", message: dErr.message } });
    return;
  }
  const decById = new Map<string, DecisionRow>();
  for (const d of (decData ?? []) as DecisionRow[]) decById.set(d.id, d);

  const joined = outcomes
    .map((o) => {
      const d = decById.get(o.decision_id);
      if (!d || d.tenant_id !== o.tenant_id) return null;
      const closedAt = d.approved_at ?? d.emitted_at;
      return { outcome: o, decision: d, closed_at: closedAt };
    })
    .filter((x): x is { outcome: OutcomeRow; decision: DecisionRow; closed_at: string } => x !== null);

  joined.sort((a, b) => {
    if (a.closed_at !== b.closed_at) return a.closed_at < b.closed_at ? 1 : -1;
    return a.decision.id < b.decision.id ? 1 : -1;
  });

  const out = joined.slice(0, limit).map(({ outcome: o, closed_at }) => {
    const isPending = o.reconcile_status === "pending";
    const daysLeft = isPending
      ? Math.max(0, Math.ceil((new Date(o.reconcile_after).getTime() - Date.now()) / 86400_000))
      : 0;
    return {
      decision_id: o.decision_id,
      action_class: o.action_class,
      decision_outcome: o.decision_outcome,
      subject_type: o.subject_type,
      subject_id: o.subject_id,
      subject_name: o.subject_name,
      target_metric: o.target_metric,
      outcome_tier: o.outcome_tier ?? "business",
      baseline_metrics: o.baseline_metrics ?? {},
      outcome_metrics: o.outcome_metrics ?? {},
      delta_metrics: o.delta_metrics ?? {},
      baseline_status: o.baseline_status,
      reconcile_status: o.reconcile_status,
      measurement_window_days: o.measurement_window_days,
      measured_at: o.measured_at,
      closed_at,
      days_until_result: daysLeft,
    };
  });

  res.json({ agent_slug: slug, outcomes: out, total: out.length });
}
