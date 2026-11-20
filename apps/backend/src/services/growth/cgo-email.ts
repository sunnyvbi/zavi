
import { randomUUID } from "node:crypto";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { EMAIL_PROVIDERS, EMAIL_TOOL_LABEL, isEmailTool, type EmailTool } from "@/services/connectors/email-campaign/providers";
import { authorizeUnattendedEmail, emailAudienceKey, isEmailSendClass, EMAIL_SEND_CHANNEL } from "./unattended-email";

type DoorRow = {
  channel_slug: string;
  exec_class: string | null;
  exec_payload: unknown;
  exec_status: string | null;
  status: string;
  approved_by_source: string | null;
};

export function isPlannedCard(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && typeof (payload as { planned_send_id?: unknown }).planned_send_id === "string";
}

async function listHasPlannedEmail(tenant_id: string, payload: unknown): Promise<boolean> {
  const key = emailAudienceKey(payload);
  if (!key) return false;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("email_planned_sends")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("list_key", key)
    .in("status", ["planned", "drafting", "ready", "scheduled"])
    .gt("planned_at", new Date().toISOString())
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

async function liveAudienceCount(tenant_id: string, payload: unknown): Promise<number | null> {
  try {
    const { autopilotListMatches, parseEmailSendBody, connectedCall } = await import("@/services/connectors/email-campaign/execute-send");
    const { resolveOwnedComposioAccount } = await import("@/services/connectors/composio/account");
    const { composioExecuteTool } = await import("@/services/connectors/composio/api");
    const body = parseEmailSendBody(payload);
    if (!body) return null;
    const call = connectedCall(tenant_id, body, { resolveAccount: resolveOwnedComposioAccount, exec: composioExecuteTool });
    const audience = await EMAIL_PROVIDERS[body.tool].getAudience(call, body.audience_id);
    return audience && autopilotListMatches(body, audience) ? audience.member_count : null;
  } catch {
    return null;
  }
}

export async function cgoApproveEmailChannelAction(
  tenant_id: string,
  action_id: string,
  opts: { run_id?: string; mayAct?: (tenant_id: string, run_id: string) => Promise<boolean> } = {},
): Promise<boolean> {
  let pendingSend: { id: string } | null = null;
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("channel_actions")
      .select("channel_slug, exec_class, exec_payload, exec_status, status, approved_by_source")
      .eq("id", action_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as DoorRow;
    if (row.channel_slug !== EMAIL_SEND_CHANNEL || !isEmailSendClass(row.exec_class)) return false;
    if (isPlannedCard(row.exec_payload)) return false;
    const resend = row.exec_status === "queued" && row.approved_by_source === "cgo";
    if ((row.exec_status !== null && !resend) || row.status !== "pending") return false;
    let count: number | null = null;
    if (!resend) {
      if (await listHasPlannedEmail(tenant_id, row.exec_payload)) return false;
      count = await liveAudienceCount(tenant_id, row.exec_payload);
      const v = await authorizeUnattendedEmail(
        tenant_id,
        { action_id, exec_class: row.exec_class as string, payload: row.exec_payload, audience_count: count },
        { where: "door" },
      );
      if (v.verdict !== "allow") return false;
      const { autopilotSenderMatchesCard } = await import("@/services/connectors/email-campaign/execute-send");
      if (!(await autopilotSenderMatchesCard(tenant_id, row.exec_payload))) return false;
    }
    const { tenantOwnerId } = await import("./cgo-auto-run");
    const owner = await tenantOwnerId(tenant_id);
    if (!owner) return false;
    if (opts.run_id) {
      const mayAct = opts.mayAct ?? (await import("@/services/agents/run-may-act")).runMayActNow;
      if (!(await mayAct(tenant_id, opts.run_id))) return false;
    }
    const { data: out, error: rpcError } = await tenantRpc(asTenantId(tenant_id), "approve_email_campaign_send_as_cgo", {
      p_action_id: action_id,
      p_event_key: `cgo:${action_id}`,
      p_actor_user_id: owner,
      p_approved_count: count,
    });
    if (rpcError) throw new Error(rpcError.message);
    const r = (out ?? {}) as { ok?: boolean; code?: string; attempt?: number; replayed?: boolean; exec_status?: string };
    if (!r.ok) {
      console.warn(`[cgo-email] approve of channel action ${action_id} refused: ${r.code ?? "unknown"}`);
      return false;
    }
    if (!r.replayed || r.exec_status === "queued" || resend) {
      pendingSend = { id: `approve:${action_id}:${Number(r.attempt ?? 1)}` };
    }
  } catch (e) {
    console.warn(`[cgo-email] channel action ${action_id} left for the founder: ${(e as Error).message}`);
    return false;
  }
  if (pendingSend) {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ id: pendingSend.id, name: "channel-action.approved", data: { action_id } });
  }
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: "info",
      source: "cgo-email",
      code: "cgo.email_send_approved",
      message: "email campaign send approved by cgo (autopilot)",
      tenant_id,
    });
  } catch {
  }
  return true;
}

export type AutopilotSend = {
  action_id: string;
  tool: EmailTool | string;
  subject: string;
  audience_name: string;
  sent_to: number;
  url: string | null;
};

export function autopilotSendLine(s: AutopilotSend): string {
  const tool = isEmailTool(s.tool) ? EMAIL_TOOL_LABEL[s.tool] : "your email tool";
  const people = `${s.sent_to.toLocaleString("en-US")} ${s.sent_to === 1 ? "person" : "people"}`;
  const link = s.url ? ` See it: ${s.url}` : "";
  if (s.tool === "sendgrid") {
    return `Autopilot handed "${s.subject.slice(0, 120)}" to SendGrid for your "${s.audience_name.slice(0, 80)}" list. Delivery is not confirmed yet.${link}`;
  }
  return `Autopilot sent "${s.subject.slice(0, 120)}" to ${people} on your "${s.audience_name.slice(0, 80)}" list in ${tool}.${link}`;
}

async function sendNoteEmail(tenant_id: string, note_id: string): Promise<void> {
  const { inngest } = await import("@/../workers/client");
  await inngest.send({ id: `cgo-note-email:note:${note_id}`, name: "cgo/note.email", data: { note_id, tenant_id } });
}

export async function notifyFounderOfAutopilotSend(tenant_id: string, send: AutopilotSend): Promise<boolean> {
  {
    const key = `email_sent:${send.action_id}`;
    const db = tenantClient(asTenantId(tenant_id));
    const { data: seen, error: seenErr } = await db.from("cgo_notes").select("id").eq("tenant_id", tenant_id).contains("alarm_keys", [key]).limit(1);
    if (seenErr) throw new Error(seenErr.message);
    const existing = (seen ?? [])[0] as { id?: string } | undefined;
    if (existing?.id) {
      await sendNoteEmail(tenant_id, existing.id);
      return false;
    }
    const { data: last } = await db
      .from("cgo_notes")
      .select("next_review_at")
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ next_review_at: string }>();
    const { data: note, error } = await db
      .from("cgo_notes")
      .insert({
        tenant_id,
        run_id: null,
        kind: "alarm",
        changed: [autopilotSendLine(send)],
        alarm_keys: [key],
        queued_at: new Date().toISOString(),
        notified: false,
        notification_key: `note:${randomUUID()}`,
        next_review_at: last?.next_review_at ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
      .select("id")
      .maybeSingle<{ id: string }>();
    if (error || !note) throw new Error(error?.message ?? "no row");
    await sendNoteEmail(tenant_id, note.id);
    return true;
  }
}
