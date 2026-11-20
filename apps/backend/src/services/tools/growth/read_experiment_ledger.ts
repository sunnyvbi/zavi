
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { ownActionClassScopes } from "@/services/agents/paid-channel-scope";

const inputSchema = z.object({
  days: z.number().int().min(1).max(180).default(90),
  limit: z.number().int().min(1).max(50).default(20),
});

const ACTION_CLASS_SCOPE = "meta_ads.%";

const METRIC_KEYS = [
  "spend",
  "roas",
  "conversions",
  "purchase_value",
  "impressions",
  "spend_avoided_estimate",
  "spend_avoided_inputs",
] as const;

type LedgerOutcomeRow = {
  id: number;
  decision_id: string;
  action_class: string;
  decision_outcome: string;
  subject_type: string;
  subject_id: string;
  subject_name: string | null;
  target_metric: string;
  baseline_metrics: Record<string, unknown> | null;
  outcome_metrics: Record<string, unknown> | null;
  delta_metrics: Record<string, unknown> | null;
  reconcile_status: string;
  reconcile_after: string;
  measurement_window_days: number;
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

export async function readHypotheses(
  sc: ReturnType<typeof serviceClient>,
  tenantId: string,
  decisionIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (decisionIds.length === 0) return out;
  const { data, error } = await sc
    .from("decisions")
    .select("id, body")
    .eq("tenant_id", tenantId)
    .in("id", decisionIds);
  if (error || !data) return out;
  for (const row of data as Array<{ id: string; body: unknown }>) {
    const body = row.body;
    if (body && typeof body === "object") {
      const rationale = (body as Record<string, unknown>).rationale;
      if (typeof rationale === "string" && rationale.trim().length > 0) {
        out[row.id] = rationale.trim().slice(0, 500);
      }
    }
  }
  return out;
}

export const readExperimentLedgerTool: ToolSpec = {
  name: "growth_read_experiment_ledger",
  effect: "read",
  description:
    "Read the recorded paid-ad experiment ledger, scoped server-side to the caller's channel/provider for paid specialists. Generalists retain the Meta ledger. Rows represent recorded approved/rejected decisions, never floated 'New tests' ideas. Each row carries the hypothesis, baseline metrics, readout_due date and, once measured, result delta. readout_due:true means the measurement window elapsed; a null result is still not a measured result. has_data:false means no recorded experiments in this scope and window, not proof that no campaigns launched. Never invent a ledger.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { days, limit } = inputSchema.parse(input);
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
    const nowIso = new Date().toISOString();
    const sc = serviceClient();
    const scopes = ownActionClassScopes(ctx.agent_slug, [ACTION_CLASS_SCOPE]);
    const scopeLabel = scopes.map((p) => p.replace(/%$/, "*")).join(", ");

    const { data, error } = await sc
      .from("action_outcomes")
      .select(
        "id, decision_id, action_class, decision_outcome, subject_type, subject_id, subject_name, target_metric, baseline_metrics, outcome_metrics, delta_metrics, reconcile_status, reconcile_after, measurement_window_days, measured_at, created_at",
      )
      .eq("tenant_id", ctx.tenant_id)
      .or(scopes.map((p) => `action_class.like.${p}`).join(","))
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      throw new ExpectedToolError(
        "experiment_ledger_read_failed",
        `Could not read the experiment ledger: ${error.message}. Say the ledger is unavailable this run — do NOT invent past launches or results.`,
      );
    }

    const rows = (data ?? []) as LedgerOutcomeRow[];
    const hypotheses = await readHypotheses(
      sc,
      ctx.tenant_id,
      rows.map((r) => r.decision_id),
    );

    let readout_due_count = 0;
    const mapped = rows.map((r) => {
      const readout_due = r.reconcile_after <= nowIso;
      if (readout_due) readout_due_count++;
      const measured = r.reconcile_status === "measured";
      return {
        ledger_id: r.id,
        decision_id: r.decision_id,
        action_class: r.action_class,
        decision_outcome: r.decision_outcome,
        subject_type: r.subject_type,
        subject_id: r.subject_id,
        subject_name: r.subject_name,
        target_metric: r.target_metric,
        hypothesis: hypotheses[r.decision_id] ?? null,
        launched_at: r.created_at,
        readout_due,
        readout_due_at: r.reconcile_after,
        reconcile_status: r.reconcile_status,
        measured_at: r.measured_at,
        baseline: pickMetrics(r.baseline_metrics),
        result: measured ? pickMetrics(r.delta_metrics) : null,
        measurement_window_days: r.measurement_window_days,
      };
    });

    return {
      has_data: mapped.length > 0,
      window_days: days,
      action_class_scope: scopeLabel,
      readout_due_count,
      rows: mapped,
      note:
        mapped.length === 0
          ? `No recorded experiments for ${scopeLabel} in the window. A floated 'New tests' idea is NOT a launch. This does not establish whether unmeasured changes exist; never fabricate a launch or a result.`
          : "These are recorded approved/rejected decisions. Review readout_due:true rows before proposing anything new; an elapsed window does not guarantee a measured result. Cite hypothesis + baseline + result verbatim; a null result is not a result; spend_avoided_estimate is a labelled estimate.",
    };
  },
};
