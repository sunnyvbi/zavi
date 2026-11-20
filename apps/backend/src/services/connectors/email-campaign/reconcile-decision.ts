import { asTenantId, fleetSweepClient, tenantClient } from "@/services/tenant-client";
import type { SendOutcome } from "@/services/email-cards/outcome";
import { EMAIL_SEND_CLASS, OUTCOME_UNKNOWN_SUFFIX } from "./execute-send";
import { reconcileEmailSend, type ReconcileResult } from "./reconcile";

export type DecisionSendRow = {
  tenant_id: string;
  decision_class: string | null;
  status: string | null;
  dispatch_error: string | null;
  body: unknown;
  ref: string | null;
};

export type DecisionSettle = { status: "acted" | "dispatch_failed"; dispatch_error: string | null };

export type DecisionReconcileDeps = {
  readRow: (decisionId: string) => Promise<DecisionSendRow | null>;
  settle: (tenantId: string, decisionId: string, patch: DecisionSettle) => Promise<boolean>;
  markNotSent: (tenantId: string, decisionId: string) => Promise<boolean>;
  reconcile: typeof reconcileEmailSend;
  tell: (o: SendOutcome) => Promise<unknown>;
};

async function liveReadRow(decisionId: string): Promise<DecisionSendRow | null> {
  const { data, error } = await fleetSweepClient("email send reconcile worker: read one decision by id to learn its tenant")
    .from("decisions")
    .select("tenant_id, decision_class, status, dispatch_error, body")
    .eq("id", decisionId)
    .maybeSingle();
  if (error) throw new Error(`decision read failed: ${error.message}`);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const tenantId = String(r.tenant_id);
  const ref = await tenantClient(asTenantId(tenantId)).from("email_send_refs").select("provider_ref").eq("rail", "decisions").eq("card_id", decisionId).maybeSingle();
  if (ref.error) throw new Error(`email_send_refs read failed: ${ref.error.message}`);
  return {
    tenant_id: tenantId,
    decision_class: typeof r.decision_class === "string" ? r.decision_class : null,
    status: typeof r.status === "string" ? r.status : null,
    dispatch_error: typeof r.dispatch_error === "string" ? r.dispatch_error : null,
    body: r.body ?? null,
    ref: (ref.data as { provider_ref?: string } | null)?.provider_ref ?? null,
  };
}

const LIVE: DecisionReconcileDeps = {
  readRow: liveReadRow,
  settle: async (tenantId, decisionId, patch) => {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("decisions")
      .update(patch)
      .eq("id", decisionId)
      .eq("status", "dispatching")
      .select("id");
    if (error) throw new Error(`decision settle failed: ${error.message}`);
    return ((data ?? []) as unknown[]).length > 0;
  },
  markNotSent: async (tenantId, decisionId) => (await import("./execute-send")).markSendRefNotSent(tenantId, decisionId),
  reconcile: reconcileEmailSend,
  tell: async (o) => (await import("@/services/email-cards/outcome-tell")).tellEmailSendOutcomeOrQueue(o),
};

export function decisionAwaitingCheck(row: Pick<DecisionSendRow, "decision_class" | "status" | "dispatch_error">): boolean {
  return row.decision_class === EMAIL_SEND_CLASS && row.status === "dispatching" && (row.dispatch_error ?? "").endsWith(OUTCOME_UNKNOWN_SUFFIX);
}

export async function reconcileDecisionEmailSend(
  decisionId: string,
  opts: { finalPass: boolean; lastPass: boolean },
  depsIn: Partial<DecisionReconcileDeps> = {},
): Promise<ReconcileResult> {
  const d = { ...LIVE, ...depsIn };
  const row = await d.readRow(decisionId);
  if (row && !opts.lastPass && row.decision_class === EMAIL_SEND_CLASS && row.status === "dispatching" && !decisionAwaitingCheck(row)) return { done: false, outcome: "in_flight" };
  if (!row || !decisionAwaitingCheck(row)) return { done: true, outcome: "nothing_to_do" };
  const marked = row.dispatch_error ?? OUTCOME_UNKNOWN_SUFFIX;
  const tell = (o: SendOutcome) => d.tell({ ...o, rail: "decisions" });
  if (!row.ref) {
    if (!(await d.settle(row.tenant_id, decisionId, { status: "dispatch_failed", dispatch_error: marked }))) return { done: true, outcome: "nothing_to_do" };
    await tell({ tenant_id: row.tenant_id, rail: "decisions", card_id: decisionId, outcome: "unknown", sent: null, reason: marked.slice(0, -OUTCOME_UNKNOWN_SUFFIX.length) || null }).catch(() => undefined);
    return { done: true, outcome: "could_not_check" };
  }
  let settled = true;
  const r = await d.reconcile(
    decisionId,
    {
      tenant_id: row.tenant_id,
      exec_class: row.decision_class,
      exec_status: "failed",
      exec_result: { code: "exec_outcome_unknown" },
      exec_payload: row.body,
      exec_progress: { campaign_id: row.ref, stage: "send_requested" },
      approved_by_source: null,
      lease_expired: false,
    },
    opts,
    {
      settle: async (_tenantId, a) => {
        const mayHave = !a.ok && a.result.code === "exec_partial" && a.result.not_sent !== true;
        if (!a.ok && a.result.not_sent === true) await d.markNotSent(row.tenant_id, decisionId).catch(() => false);
        settled = await d.settle(
          row.tenant_id,
          decisionId,
          a.ok ? { status: "acted", dispatch_error: null } : { status: "dispatch_failed", dispatch_error: `${(a.error ?? "").slice(0, 400)}${mayHave ? OUTCOME_UNKNOWN_SUFFIX : ""}` },
        );
        return { ok: settled, replayed: !settled };
      },
      tell: async (o) => (settled ? tell(o) : undefined),
    },
  );
  return r;
}
