
import { z } from "zod";
import { asTenantId, staffCrossTenantClient, tenantRpc } from "@/services/tenant-client";
import { readGlobalBulkStop, type GlobalBulkStop } from "@/services/comms/bulk-outbound/config";

export const BULK_CLEAR_HOLD_KEY = "bulk-email-clear-hold";
export const BULK_RESUME_SEND_KEY = "bulk-email-resume-send";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (label: string) =>
  z.string().trim().regex(UUID_RE, `${label} must be a uuid`).transform((s) => s.toLowerCase());

export type ClearHoldArgs = { tenant_id: string };
export type ResumeSendArgs = { send_id: string };
export const clearHoldSchema = z.object({ tenant_id: uuid("tenant_id") });
export const resumeSendSchema = z.object({ send_id: uuid("send_id") });

export class BulkScriptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export type AbuseHold = { tenant_id: string; send_id: string | null; reason: string; created_at: string; cleared_at: string | null };

export type HeldSend = {
  send_id: string;
  tenant_id: string;
  status: string;
  hold_reason: string | null;
  total: number;
  counts: Record<string, number>;
  workspace_on_hold: boolean;
};

export type BulkScriptDeps = {
  readHold: (tenantId: string) => Promise<AbuseHold | null>;
  clearHold: (tenantId: string, staffUserId: string) => Promise<{ ok: boolean; reason?: string; bulk_email_reenabled?: boolean }>;
  readSend: (sendId: string) => Promise<HeldSend | null>;
  resumeSend: (tenantId: string, sendId: string) => Promise<{ ok: boolean; reason?: string; pending?: number }>;
  startFanout: (sendId: string) => Promise<void>;
  readGlobalStop: () => Promise<GlobalBulkStop>;
  readPaused: (tenantId: string) => Promise<boolean>;
};

const client = () => staffCrossTenantClient("admin script bulk-email: staff clears an abuse hold or resumes a held bulk send");

export const DEFAULT_BULK_SCRIPT_DEPS: BulkScriptDeps = {
  async readHold(tenantId) {
    const { data, error } = await client()
      .from("email_bulk_abuse_holds")
      .select("tenant_id, send_id, reason, created_at, cleared_at")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error("bulk-email: hold read failed");
    return (data as AbuseHold | null) ?? null;
  },
  async clearHold(tenantId, staffUserId) {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "email_bulk_clear_abuse_hold", { p_staff_user_id: staffUserId });
    if (error) throw new Error("bulk-email: clear hold failed");
    return (data ?? { ok: false, reason: "error" }) as { ok: boolean; reason?: string; bulk_email_reenabled?: boolean };
  },
  async readSend(sendId) {
    const sb = client();
    const { data, error } = await sb
      .from("email_bulk_sends")
      .select("id, tenant_id, status, hold_reason, total")
      .eq("id", sendId)
      .maybeSingle();
    if (error) throw new Error("bulk-email: send read failed");
    if (!data) return null;
    const row = data as { id: string; tenant_id: string; status: string; hold_reason: string | null; total: number };
    const { data: recips, error: rErr } = await sb
      .from("email_bulk_send_recipients")
      .select("status")
      .eq("send_id", row.id)
      .eq("tenant_id", row.tenant_id);
    if (rErr) throw new Error("bulk-email: recipient read failed");
    const counts: Record<string, number> = {};
    for (const r of (recips ?? []) as Array<{ status: string }>) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const { data: hold } = await sb
      .from("email_bulk_abuse_holds")
      .select("cleared_at")
      .eq("tenant_id", row.tenant_id)
      .maybeSingle();
    return {
      send_id: row.id,
      tenant_id: row.tenant_id,
      status: row.status,
      hold_reason: row.hold_reason,
      total: Number(row.total ?? 0),
      counts,
      workspace_on_hold: !!hold && !(hold as { cleared_at: string | null }).cleared_at,
    };
  },
  async resumeSend(tenantId, sendId) {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "email_bulk_resume_send", { p_send_id: sendId });
    if (error) throw new Error("bulk-email: resume failed");
    return (data ?? { ok: false, reason: "error" }) as { ok: boolean; reason?: string; pending?: number };
  },
  async startFanout(sendId) {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ id: `bulk-email-fanout:${sendId}:resume:${Date.now()}`, name: "bulk-email/fanout.requested", data: { send_id: sendId } });
  },
  readGlobalStop: readGlobalBulkStop,
  async readPaused(tenantId) {
    const { emailSendPaused } = await import("@/services/email-cards/pause");
    return emailSendPaused(tenantId);
  },
};

export const RESUMABLE_HOLDS: ReadonlySet<string> = new Set(["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed"]);

export const clearHoldConfirmPhrase = (tenantId: string) => `CLEAR HOLD ${tenantId}`;
export const resumeConfirmPhrase = (sendId: string) => `RESUME ${sendId}`;

export async function previewClearHold(a: ClearHoldArgs, deps: BulkScriptDeps) {
  const hold = await deps.readHold(a.tenant_id);
  return { hold, open: !!hold && !hold.cleared_at, confirm_phrase: clearHoldConfirmPhrase(a.tenant_id) };
}

export async function applyClearHold(a: ClearHoldArgs, staff: { user_id: string; email: string }, deps: BulkScriptDeps) {
  const hold = await deps.readHold(a.tenant_id);
  if (!hold || hold.cleared_at) throw new BulkScriptError("no_open_hold", "That workspace has no open abuse hold.", 404);
  const out = await deps.clearHold(hold.tenant_id, staff.user_id);
  if (!out.ok) {
    if (out.reason === "not_staff") throw new BulkScriptError("not_staff", "Only active staff can clear an abuse hold.", 403);
    throw new BulkScriptError("no_open_hold", "That workspace has no open abuse hold.", 404);
  }
  const reenabled = out.bulk_email_reenabled === true;
  return {
    tenant_id: hold.tenant_id,
    cleared: true,
    bulk_email_reenabled: reenabled,
    note: reenabled
      ? "Bulk email is back on for this workspace: the switch-off the abuse shutoff wrote was removed, so it follows the default (on)."
      : "Bulk email was NOT switched back on: it was switched off by staff or the founder, not by the abuse shutoff. Leave it, or change it in Settings for this workspace.",
    reason: hold.reason,
  };
}

export async function previewResumeSend(a: ResumeSendArgs, deps: BulkScriptDeps) {
  const send = await deps.readSend(a.send_id);
  if (!send) throw new BulkScriptError("not_found", "No bulk send with that id.", 404);
  const globalStop = await deps.readGlobalStop();
  const paused = await deps.readPaused(send.tenant_id);
  const refusal =
    globalStop !== "running"
      ? "bulk_sending_paused"
      : paused
      ? "email_paused"
      : send.status !== "held"
      ? "not_held"
      : !RESUMABLE_HOLDS.has(send.hold_reason ?? "")
        ? "not_resumable"
        : send.workspace_on_hold
        ? "workspace_on_abuse_hold"
        : (send.counts.pending ?? 0) === 0
          ? "nobody_waiting"
          : null;
  return { ...send, would_email: send.counts.pending ?? 0, refusal, confirm_phrase: resumeConfirmPhrase(a.send_id) };
}

export async function applyResumeSend(a: ResumeSendArgs, deps: BulkScriptDeps) {
  const send = await deps.readSend(a.send_id);
  if (!send) throw new BulkScriptError("not_found", "No bulk send with that id.", 404);
  if ((await deps.readGlobalStop()) !== "running") {
    throw new BulkScriptError("bulk_sending_paused", "Bulk email is paused for everyone (the global stop). Turn it back on before resuming a send.");
  }
  if (await deps.readPaused(send.tenant_id)) {
    throw new BulkScriptError("email_paused", "The founder has paused email for that workspace, so nobody would be emailed. The send stays held; resume it after they resume email.");
  }
  const out = await deps.resumeSend(send.tenant_id, send.send_id);
  if (!out.ok) {
    const messages: Record<string, string> = {
      not_held: "That send is not held.",
      not_resumable:
        "That send was held for a reason only the founder can fix (the domain, the list, its consent, or bulk email switched off). They propose the email again.",
      bulk_outbound_disabled: "Bulk email is switched off for that workspace.",
      bulk_sending_paused: "Bulk email is paused for everyone (the global stop).",
      sending_domain_not_verified: "The workspace's sending domain is not verified.",
      list_archived: "The contact list was archived.",
      list_not_consented: "The list's consent is not on record.",
      abuse_hold: "The workspace is on an abuse hold. Clear it first (bulk-email-clear-hold).",
      nobody_waiting: "Nobody is still waiting on that send.",
      not_found: "No bulk send with that id.",
    };
    throw new BulkScriptError(out.reason ?? "error", messages[out.reason ?? ""] ?? "The send could not be resumed.");
  }
  await deps.startFanout(send.send_id);
  return { send_id: send.send_id, tenant_id: send.tenant_id, resumed: true, pending: out.pending ?? 0 };
}
