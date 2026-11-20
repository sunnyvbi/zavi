
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { readLeftOut } from "./left-out";
import { bulkSendLine, type BulkSendState } from "./notices";
import type { BulkSendStatus, SendCounts } from "./store";

export type BulkSendProgress = {
  state: BulkSendState;
  line: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  unknown: number;
  waiting: number;
  hold_reason: string | null;
  next_run_at: string | null;
  in_progress: boolean;
};

type Row = {
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  unknown: number;
  complaints: number;
  hard_bounces: number;
  status: BulkSendStatus;
  hold_reason: string | null;
  next_run_at: string | null;
};

export async function readSentSoFar(tenantId: string, decisionId: string): Promise<number | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const { data, error } = await db.from("email_bulk_sends").select("id").eq("decision_id", decisionId).maybeSingle();
    const sendId = (data as { id?: string } | null)?.id;
    if (error || !sendId) return null;
    const { count, error: countError } = await db
      .from("email_bulk_send_recipients")
      .select("contact_id", { count: "exact", head: true })
      .eq("send_id", sendId)
      .eq("status", "sent");
    return countError ? null : count;
  } catch {
    return null;
  }
}

export async function bulkSendProgress(tenantId: string, decisionId: string): Promise<BulkSendProgress | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("email_bulk_sends")
    .select("total, sent, skipped, failed, unknown, complaints, hard_bounces, status, hold_reason, next_run_at")
    .eq("decision_id", decisionId)
    .maybeSingle();
  if (error) throw new Error("email_bulk_sends read failed");
  if (!data) return null;
  const r = data as Row;
  const waiting = Math.max(0, r.total - r.sent - r.skipped - r.failed - r.unknown);
  const leftOut = r.status === "done" ? await readLeftOut(tenantId, { decision_id: decisionId }) : null;
  const counts: SendCounts = { ...r, pending: waiting, sending: 0, ...(leftOut === null ? {} : { left_out: leftOut }) };
  const state: BulkSendState = r.status === "sending" ? "more" : r.status;
  const line =
    state === "waiting_for_tomorrow"
      ? `Sent ${r.sent.toLocaleString("en-US")} of ${r.total.toLocaleString("en-US")}. ` +
        `Zavi sends a limited number of emails each day, fewer while a new sending domain warms up, so the rest go out over the coming days. It keeps going by itself.`
      : bulkSendLine(state, counts);
  return {
    state,
    line,
    total: r.total,
    sent: r.sent,
    skipped: r.skipped,
    failed: r.failed,
    unknown: r.unknown,
    waiting,
    hold_reason: r.hold_reason,
    next_run_at: r.next_run_at,
    in_progress: state === "more" || state === "waiting_for_tomorrow",
  };
}
