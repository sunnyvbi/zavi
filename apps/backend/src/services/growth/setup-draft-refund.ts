
import { asTenantId, preTenantRpc, tenantClient, tenantRpc } from "@/services/tenant-client";
import { isRefundableSetupDraft, setupDraftKey, type SetupDraftRun } from "./setup-draft";

const TERMINAL = new Set(["success", "parse_failed", "error", "failed", "cancelled", "dispatch_error"]);

type Resolved = {
  tenant_id: string;
  status: string;
  agent_slug: string;
  trigger: string;
  enqueued_by_is_null: boolean;
  cron_dedupe_key: string | null;
  attempt: number;
};
type LedgerRow = { run_id: string; kind: string; attempt: number | null };
type SettleRefund = { status?: string; credits?: number };
export type RefundResult = { granted: number; skipped?: "not_setup_draft" | "not_terminal" };

export async function refundSetupDraftRun(run_id: string): Promise<RefundResult> {
  const { data, error } = await preTenantRpc("setup_draft_resolve_run", { p_run_id: run_id });
  if (error) throw new Error(`setup draft refund: resolve failed: ${error.message}`);
  const row = ((data ?? []) as Resolved[])[0];
  if (!row) return { granted: 0, skipped: "not_setup_draft" };
  const tenant_id = row.tenant_id;
  const run: SetupDraftRun = {
    id: run_id,
    status: row.status,
    agent_slug: row.agent_slug,
    trigger: row.trigger,
    enqueued_by: row.enqueued_by_is_null ? null : "user",
    cron_dedupe_key: row.cron_dedupe_key,
  };
  if (!isRefundableSetupDraft(tenant_id, run)) return { granted: 0, skipped: "not_setup_draft" };
  if (!TERMINAL.has(run.status)) return { granted: 0, skipped: "not_terminal" };

  const tid = asTenantId(tenant_id);
  const { data: rows, error: ledErr } = await tenantClient(tid)
    .from("tenant_credit_ledger")
    .select("run_id, kind, attempt")
    .eq("run_id", run_id)
    .eq("kind", "settle");
  if (ledErr) throw new Error(`setup draft refund: ledger read failed: ${ledErr.message}`);

  let granted = 0;
  for (const r of (rows ?? []) as LedgerRow[]) {
    const { data: out, error: rErr } = await tenantRpc(tid, "refund_setup_draft_settle", {
      p_run_id: run_id,
      p_attempt: r.attempt ?? 0,
    });
    if (rErr) throw new Error(`setup draft refund: refund failed: ${rErr.message}`);
    const res = (out ?? {}) as SettleRefund;
    if (res.status === "refunded") granted += Math.max(0, Math.floor(Number(res.credits ?? 0)));
  }
  return { granted };
}

export async function reconcileSetupDraftRefunds(tenant_id: string): Promise<void> {
  const keys = [1, 2, 3].map((a) => setupDraftKey(tenant_id, a));
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id")
    .eq("agent_slug", "cgo")
    .in("cron_dedupe_key", keys);
  if (error) throw new Error(`setup draft reconcile: ${error.message}`);
  for (const r of (data ?? []) as Array<{ id: string }>) {
    await refundSetupDraftRun(r.id);
  }
}
