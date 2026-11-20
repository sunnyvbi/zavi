import { asTenantId, tenantClient } from "@/services/tenant-client";
import { bulkSendLine } from "@/services/comms/bulk-outbound/notices";
import type { BulkSendStatus, SendCounts } from "@/services/comms/bulk-outbound/store";
import { audienceMismatchResult, EMAIL_PAUSED_CODE, EMAIL_SEND_CLASS, OUTCOME_UNKNOWN_SUFFIX } from "@/services/connectors/email-campaign/execute-send";
import { EMAIL_TOOL_LABEL } from "@/services/connectors/email-campaign/providers";
import { bulkSendOutcome, type SendOutcome } from "./outcome";
import type { SendOutcomeRef } from "./outcome-tell";
import { FANOUT_STALLED_REASON, RELEASED_EXPIRED_REASON, RELEASED_PAUSED_REASON, RELEASED_SENDER_STOPPED_REASON } from "./recovery";

export type RebuiltOutcome = { o: SendOutcome } | { pending: true } | null;

type ActionRow = { tenant_id: string; exec_class: string | null; exec_status: string | null; exec_result: Record<string, unknown> | null };
type DecisionRow = { tenant_id: string; decision_class: string | null; status: string | null; dispatch_error: string | null };
type BulkRow = { id: string; tenant_id: string; status: BulkSendStatus };

export type RebuildDeps = {
  readAction: (tenantId: string, id: string) => Promise<ActionRow | null>;
  readDecision: (tenantId: string, id: string) => Promise<DecisionRow | null>;
  readBulkSend: (tenantId: string, decisionId: string) => Promise<BulkRow | null>;
  counts: (tenantId: string, sendId: string) => Promise<SendCounts>;
};

const LIVE: RebuildDeps = {
  readAction: async (tenantId, id) => {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("channel_actions").select("tenant_id, exec_class, exec_status, exec_result").eq("id", id).maybeSingle();
    if (error) throw new Error("channel_actions read failed");
    return (data as ActionRow | null) ?? null;
  },
  readDecision: async (tenantId, id) => {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("decisions").select("tenant_id, decision_class, status, dispatch_error").eq("id", id).maybeSingle();
    if (error) throw new Error("decisions read failed");
    return (data as DecisionRow | null) ?? null;
  },
  readBulkSend: async (tenantId, decisionId) => {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_bulk_sends")
      .select("id, tenant_id, status")
      .eq("decision_id", decisionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("email_bulk_sends read failed");
    return (data as BulkRow | null) ?? null;
  },
  counts: async (tenantId, sendId) => (await import("@/services/comms/bulk-outbound/store")).supabaseBulkSendStore.settleSend(tenantId, sendId, null),
};

const DECISION_EMAIL_CLASSES: ReadonlySet<string> = new Set(["bulk_outbound.send", EMAIL_SEND_CLASS]);
const UNSETTLED_DECISION: ReadonlySet<string> = new Set(["approved", "dispatching"]);
const NOT_TOLD_CODES: ReadonlySet<string> = new Set([EMAIL_PAUSED_CODE, "email_redraft_required"]);
const MISMATCH_ERRORS: ReadonlySet<string> = new Set(Object.values(EMAIL_TOOL_LABEL).map((l) => audienceMismatchResult(l).error ?? ""));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function sentCount(r: Record<string, unknown> | null): number | null {
  const receipt = r?.receipt as { line?: unknown } | undefined;
  const line = str(receipt?.line) ?? str(r?.notice);
  const m = line ? /^Sent to ([\d,]+) (?:person|people)\b/.exec(line) : null;
  const n = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fromAction(id: string, row: ActionRow): RebuiltOutcome {
  if (row.exec_class !== EMAIL_SEND_CLASS) return null;
  if (row.exec_status === "queued" || row.exec_status === "dispatching") return { pending: true };
  const base = { tenant_id: row.tenant_id, rail: "channel_actions" as const, card_id: id };
  if (row.exec_status === "executed") return { o: { ...base, outcome: "sent", sent: sentCount(row.exec_result) } };
  if (row.exec_status !== "failed") return null;
  const r = row.exec_result ?? {};
  if (r.held_for_founder === true || (typeof r.code === "string" && NOT_TOLD_CODES.has(r.code))) return null;
  const reason = str(r.error);
  if (r.audience_mismatch === true) return { o: { ...base, outcome: "failed", sent: null, reason, kind: "audience_mismatch" } };
  const unknown = r.code === "exec_outcome_unknown" || (r.code === "exec_partial" && r.not_sent !== true && r.reconciled === true);
  return { o: unknown ? { ...base, outcome: "unknown", sent: null, reason } : { ...base, outcome: "failed", sent: 0, reason } };
}

function fromSettledDecision(id: string, row: DecisionRow): RebuiltOutcome {
  const base = { tenant_id: row.tenant_id, rail: "decisions" as const, card_id: id };
  if (row.status === "acted") return row.decision_class === EMAIL_SEND_CLASS ? { o: { ...base, outcome: "sent", sent: null } } : null;
  if (row.status !== "dispatch_failed") return null;
  const e = row.dispatch_error ?? "";
  const released = [RELEASED_PAUSED_REASON, RELEASED_SENDER_STOPPED_REASON, RELEASED_EXPIRED_REASON].find((r) => e.startsWith(r)) ?? null;
  if (released) return { o: { ...base, outcome: "failed", sent: 0, reason: released } };
  if (row.decision_class === EMAIL_SEND_CLASS) {
    if (e.endsWith(OUTCOME_UNKNOWN_SUFFIX)) return { o: { ...base, outcome: "unknown", sent: null, reason: str(e.slice(0, -OUTCOME_UNKNOWN_SUFFIX.length)) } };
    if (MISMATCH_ERRORS.has(e)) return { o: { ...base, outcome: "failed", sent: null, reason: e, kind: "audience_mismatch" } };
    return { o: { ...base, outcome: "failed", sent: 0, reason: str(e) } };
  }
  const coded = /^(.*) \(([a-z_]+)\)$/s.exec(e);
  if (coded && coded[2] === EMAIL_PAUSED_CODE) return null;
  return { o: { ...base, outcome: "failed", sent: 0, reason: str(coded ? coded[1] : e) } };
}

async function fromDecision(id: string, row: DecisionRow, deps: RebuildDeps): Promise<RebuiltOutcome> {
  if (!row.decision_class || !DECISION_EMAIL_CLASSES.has(row.decision_class)) return null;
  const send = await deps.readBulkSend(row.tenant_id, id);
  if (send) {
    if (send.tenant_id !== row.tenant_id || !(send.status === "done" || send.status === "failed" || send.status === "held")) return null;
    const c = await deps.counts(row.tenant_id, send.id);
    const reason = c.hold_reason === "fanout_stalled" ? FANOUT_STALLED_REASON : bulkSendLine(send.status, c);
    const o = bulkSendOutcome(row.tenant_id, id, send.status, c, reason);
    return o ? { o } : null;
  }
  if (row.status && UNSETTLED_DECISION.has(row.status)) return { pending: true };
  return fromSettledDecision(id, row);
}

export async function rebuildSendOutcome(tenantId: string, ref: SendOutcomeRef, depsIn: Partial<RebuildDeps> = {}): Promise<RebuiltOutcome> {
  const deps = { ...LIVE, ...depsIn };
  let out: RebuiltOutcome;
  if (ref.rail === "channel_actions") {
    const row = await deps.readAction(tenantId, ref.card_id);
    out = row?.tenant_id === tenantId ? fromAction(ref.card_id, row) : null;
  } else {
    const row = await deps.readDecision(tenantId, ref.card_id);
    out = row?.tenant_id === tenantId ? await fromDecision(ref.card_id, row, deps) : null;
  }
  if (!out || "pending" in out) return out;
  return out.o.outcome === ref.outcome && (out.o.kind ?? "") === (ref.kind ?? "") ? out : null;
}
