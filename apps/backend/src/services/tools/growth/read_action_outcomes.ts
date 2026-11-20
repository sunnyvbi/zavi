
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { ownActionClassScopes } from "@/services/agents/paid-channel-scope";

const inputSchema = z.object({
  days: z.number().int().min(1).max(180).default(90),
  limit: z.number().int().min(1).max(50).default(20),
});

const ACTION_CLASS_SCOPES = ["meta_ads.%", "google_ads.%", "linkedin_ads.%"] as const;

const METRIC_KEYS = [
  "spend",
  "roas",
  "conversions",
  "purchase_value",
  "impressions",
  "spend_avoided_estimate",
  "spend_avoided_inputs",
] as const;

type OutcomeRow = {
  id: number;
  action_class: string;
  decision_outcome: string;
  subject_type: string;
  subject_id: string;
  subject_name: string | null;
  target_metric: string;
  outcome_tier: "business" | "delivery";
  baseline_metrics: Record<string, unknown> | null;
  outcome_metrics: Record<string, unknown> | null;
  delta_metrics: Record<string, unknown> | null;
  reconcile_status: string;
  measurement_window_days: number;
  measurement_window_start: string | null;
  measurement_window_end: string | null;
  reconcile_after: string;
  measured_at: string | null;
  created_at: string;
};

function pickMetrics(m: Record<string, unknown> | null): Record<string, unknown> | null {
  if (m == null) return null;
  const out: Record<string, unknown> = {};
  for (const k of METRIC_KEYS) {
    if (k in m) out[k] = m[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const readActionOutcomesTool: ToolSpec = {
  name: "growth_read_action_outcomes",
  effect: "read",
  description:
    "Read recorded paid-ad decision outcomes, scoped server-side to the caller's channel/provider for paid specialists. Generalists retain the Meta and Google scoreboard. The measurement loop records baseline and post-action metrics (spend / ROAS / conversions, plus a labelled spend-avoided ESTIMATE for pauses). Use these rows for an honest scoreboard before proposing new moves. Read-only; 'pending' rows are still measuring, not a result. has_data:false means no recorded outcomes in this scope and window: say so, never invent a delta.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { days, limit } = inputSchema.parse(input);
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
    const sc = serviceClient();
    const scopes = ownActionClassScopes(ctx.agent_slug, ACTION_CLASS_SCOPES);
    const scopeLabel = scopes.map((p) => p.replace(/%$/, "*")).join(", ");
    const { data, error } = await sc
      .from("action_outcomes")
      .select(
        "id, action_class, decision_outcome, subject_type, subject_id, subject_name, target_metric, outcome_tier, baseline_metrics, outcome_metrics, delta_metrics, reconcile_status, measurement_window_days, measurement_window_start, measurement_window_end, reconcile_after, measured_at, created_at",
      )
      .eq("tenant_id", ctx.tenant_id)
      .or(scopes.map((p) => `action_class.like.${p}`).join(","))
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      throw new ExpectedToolError(
        "action_outcomes_read_failed",
        `Could not read action outcomes: ${error.message}. Say the scoreboard is unavailable this run — do NOT invent past deltas.`,
      );
    }

    const rows = (data ?? []) as OutcomeRow[];
    const counts = { measured: 0, pending: 0, no_data: 0, error: 0 };
    const mapped = rows.map((r) => {
      if (r.reconcile_status === "measured") counts.measured++;
      else if (r.reconcile_status === "pending") counts.pending++;
      else if (r.reconcile_status === "no_data") counts.no_data++;
      else counts.error++;
      return {
        outcome_id: r.id,
        action_class: r.action_class,
        decision_outcome: r.decision_outcome,
        subject_type: r.subject_type,
        subject_id: r.subject_id,
        subject_name: r.subject_name,
        target_metric: r.target_metric,
        outcome_tier: r.outcome_tier ?? "business",
        decided_at: r.created_at,
        reconcile_status: r.reconcile_status,
        measurement_due: r.reconcile_status === "pending" ? r.reconcile_after : null,
        measurement_window_days: r.measurement_window_days,
        measurement_window_start: r.measurement_window_start,
        measurement_window_end: r.measurement_window_end,
        measured_at: r.measured_at,
        baseline: pickMetrics(r.baseline_metrics),
        outcome: pickMetrics(r.outcome_metrics),
        delta: pickMetrics(r.delta_metrics),
      };
    });

    return {
      has_data: mapped.length > 0,
      window_days: days,
      action_class_scope: scopeLabel,
      counts,
      rows: mapped,
      note:
        mapped.length === 0
          ? `No recorded action outcomes for ${scopeLabel} in the window. This does not establish whether unmeasured changes exist. Say the scoreboard has no recorded outcomes in this scope and window — never fabricate a track record.`
          : "Cite scoreboard numbers verbatim from these rows. 'pending' rows are still measuring (results due ~measurement_due) — not a result. spend_avoided_estimate is a labelled estimate.",
    };
  },
};
