
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { readLeftOut } from "./left-out";

export type BulkSendStatus = "sending" | "waiting_for_tomorrow" | "held" | "done" | "failed";

export type BulkSendRow = {
  id: string;
  tenant_id: string;
  decision_id: string;
  list_id: string;
  list_version_id: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  render_sha: string | null;
  from_address: string;
  reply_to: string | null;
  total: number;
  status: BulkSendStatus;
  hold_reason: string | null;
  next_run_at: string | null;
};

export type SendCounts = {
  status: BulkSendStatus;
  hold_reason: string | null;
  next_run_at: string | null;
  total: number;
  sent: number;
  skipped: number;
  left_out?: number;
  failed: number;
  unknown: number;
  pending: number;
  sending: number;
  complaints: number;
  hard_bounces: number;
};

export type ClaimOutcome =
  | { outcome: "held" }
  | { outcome: "none_pending" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "allowance_exhausted"; day_index: number }
  | { outcome: "claimed"; contact_id: string; email: string; day_index: number };

export type FreezeResult =
  | { ok: true; send_id: string; total: number; created: boolean }
  | { ok: false; reason: "not_approved" | "list_archived" | "version_not_consented" | "abuse_hold" | "list_version_changed" | "audience_over_limit" | "error" };

export interface BulkSendStore {
  getSend(tenantId: string, sendId: string): Promise<BulkSendRow | null>;
  freeze(args: {
    tenantId: string;
    decisionId: string;
    listId: string;
    versionId: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    renderSha?: string | null;
    fromAddress: string;
    replyTo: string | null;
    cap: number;
  }): Promise<FreezeResult>;
  markStaleUnknown(tenantId: string, sendId: string, staleSeconds: number): Promise<number>;
  claimNext(tenantId: string, sendId: string, dailyCap: number): Promise<ClaimOutcome>;
  skipIfBlocked(tenantId: string, sendId: string, contactId: string): Promise<string | null>;
  requeueClaimed(tenantId: string, sendId: string, contactId: string): Promise<boolean>;
  settleRecipient(tenantId: string, sendId: string, contactId: string, status: "sent" | "failed" | "unknown"): Promise<boolean>;
  closeHeldSend(tenantId: string, sendId: string): Promise<boolean>;
  sendIdForDecision(tenantId: string, decisionId: string): Promise<string | null>;
  settleSend(
    tenantId: string,
    sendId: string,
    status: BulkSendStatus | null,
    holdReason?: string | null,
    nextRunAt?: string | null,
  ): Promise<SendCounts>;
}

async function rpc(tenantId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error) throw new Error(`${name} failed`);
  return data;
}

const SEND_COLUMNS =
  "id, tenant_id, decision_id, list_id, list_version_id, subject, body_text, body_html, render_sha, from_address, reply_to, total, status, hold_reason, next_run_at";

export const supabaseBulkSendStore: BulkSendStore = {
  async getSend(tenantId, sendId) {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_bulk_sends")
      .select(SEND_COLUMNS)
      .eq("id", sendId)
      .maybeSingle();
    if (error) throw new Error("email_bulk_sends read failed");
    return (data as BulkSendRow | null) ?? null;
  },

  async freeze(a) {
    const out = (await rpc(a.tenantId, "email_bulk_freeze_send", {
      p_decision_id: a.decisionId,
      p_list_id: a.listId,
      p_version_id: a.versionId,
      p_subject: a.subject,
      p_body_text: a.bodyText,
      p_body_html: a.bodyHtml ?? null,
      p_render_sha: a.renderSha ?? null,
      p_from_address: a.fromAddress,
      p_reply_to: a.replyTo,
      p_cap: a.cap,
    })) as { ok?: boolean; reason?: string; send_id?: string; total?: number; created?: boolean } | null;
    if (out?.ok && out.send_id) {
      return { ok: true, send_id: out.send_id, total: Number(out.total ?? 0), created: out.created === true };
    }
    const reason = out?.reason;
    return {
      ok: false,
      reason:
        reason === "not_approved" ||
        reason === "list_archived" ||
        reason === "version_not_consented" ||
        reason === "abuse_hold" ||
        reason === "list_version_changed" ||
        reason === "audience_over_limit"
          ? reason
          : "error",
    };
  },

  async markStaleUnknown(tenantId, sendId, staleSeconds) {
    return Number((await rpc(tenantId, "email_bulk_mark_stale_unknown", { p_send_id: sendId, p_stale_seconds: staleSeconds })) ?? 0);
  },

  async claimNext(tenantId, sendId, dailyCap) {
    const out = (await rpc(tenantId, "email_bulk_claim_next", {
      p_send_id: sendId,
      p_daily_cap: Math.max(0, Math.floor(dailyCap)),
    })) as { outcome?: string; reason?: string; contact_id?: string; email?: string; day_index?: number } | null;
    const day_index = Number(out?.day_index ?? 0);
    switch (out?.outcome) {
      case "claimed":
        if (out.contact_id && out.email) return { outcome: "claimed", contact_id: out.contact_id, email: out.email, day_index };
        throw new Error("email_bulk_claim_next returned a claim with no recipient");
      case "skipped":
        return { outcome: "skipped", reason: out.reason ?? "suppressed" };
      case "allowance_exhausted":
        return { outcome: "allowance_exhausted", day_index };
      case "none_pending":
        return { outcome: "none_pending" };
      case "held":
        return { outcome: "held" };
      default:
        throw new Error("email_bulk_claim_next returned an unknown outcome");
    }
  },

  async skipIfBlocked(tenantId, sendId, contactId) {
    const out = await rpc(tenantId, "email_bulk_skip_if_blocked", { p_send_id: sendId, p_contact_id: contactId });
    return typeof out === "string" && out ? out : null;
  },

  async requeueClaimed(tenantId, sendId, contactId) {
    return (await rpc(tenantId, "email_bulk_requeue_claimed", { p_send_id: sendId, p_contact_id: contactId })) === true;
  },

  async settleRecipient(tenantId, sendId, contactId, status) {
    return (await rpc(tenantId, "email_bulk_settle_recipient", { p_send_id: sendId, p_contact_id: contactId, p_status: status })) === true;
  },

  async sendIdForDecision(tenantId, decisionId) {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_bulk_sends")
      .select("id")
      .eq("decision_id", decisionId)
      .maybeSingle();
    if (error) throw new Error("email_bulk_sends read failed");
    return (data as { id: string } | null)?.id ?? null;
  },

  async closeHeldSend(tenantId, sendId) {
    return (await rpc(tenantId, "email_bulk_close_held_send", { p_send_id: sendId })) === true;
  },

  async settleSend(tenantId, sendId, status, holdReason = null, nextRunAt = null) {
    const out = (await rpc(tenantId, "email_bulk_settle_send", {
      p_send_id: sendId,
      p_status: status,
      p_hold_reason: holdReason,
      p_next_run_at: nextRunAt,
    })) as (Partial<SendCounts> & { ok?: boolean }) | null;
    if (!out?.ok) throw new Error("email_bulk_settle_send: send not found");
    const n = (v: unknown) => Number(v ?? 0);
    const leftOut = out.status === "done" ? await readLeftOut(tenantId, { id: sendId }) : null;
    return {
      status: out.status as BulkSendStatus,
      hold_reason: out.hold_reason ?? null,
      next_run_at: out.next_run_at ?? null,
      total: n(out.total),
      sent: n(out.sent),
      skipped: n(out.skipped),
      failed: n(out.failed),
      unknown: n(out.unknown),
      pending: n(out.pending),
      sending: n(out.sending),
      complaints: n(out.complaints),
      hard_bounces: n(out.hard_bounces),
      ...(leftOut === null ? {} : { left_out: leftOut }),
    };
  },
};
