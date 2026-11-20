
import crypto from "node:crypto";
import sgMail from "@sendgrid/mail";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { emailSubjectLine } from "./theme";

export type InboxIdentity = { id: string; address: string; from_name: string | null };

export async function resolveInboxIdentity(tenant_id: string): Promise<InboxIdentity | null> {
  const logFallback = (why: string) =>
    logEvent({
      level: "warn",
      source: "agent-owned-email",
      code: "email.agent_owned.no_identity",
      message: `inbox identity unavailable (${why}); sending from the legacy address, so a reply will not reach Zavi`,
      tenant_id,
    }).catch(() => {});
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_agent_email_identity")
      .select("id, reply_to_address, from_name, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      await logFallback(`read failed: ${error.message}`);
      return null;
    }
    if (!data) return null;
    const row = data as { id: string; reply_to_address: string | null; from_name: string | null };
    const address = row.reply_to_address?.trim();
    if (!address) return null;
    return { id: row.id, address, from_name: row.from_name };
  } catch (e) {
    await logFallback(`read threw: ${(e as Error).message}`);
    return null;
  }
}

export function mintMessageId(address: string): string {
  const domain = address.split("@")[1] || "inbox.zaviagent.com";
  return `<zavi-${crypto.randomUUID()}@${domain}>`;
}

export function canonicalMessageId(mid: string): string {
  return mid.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

export type AgentOwnedSend = {
  tenant_id: string;
  agent_slug: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  fallbackFrom: { email: string; name?: string | null };
  messageId?: string;
  noteKey?: string;
};

export const CGO_NOTE_HEADER = "x-zavi-cgo-note";

export type AgentOwnedSendResult = { lane: "inbox" | "fallback"; message_id: string | null };

export async function sendAgentOwnedEmail(msg: AgentOwnedSend): Promise<AgentOwnedSendResult> {
  const apiKey = process.env.SYSTEM_SENDGRID_API_KEY;
  if (!apiKey) throw new Error("SYSTEM_SENDGRID_API_KEY unset");
  sgMail.setApiKey(apiKey);

  const identity =
    process.env.AGENTMAIL_FROM_IDENTITY === "0" ? null : await resolveInboxIdentity(msg.tenant_id);

  if (!identity) {
    await sgMail.send({
      to: msg.to,
      from: { email: msg.fallbackFrom.email, name: msg.fallbackFrom.name ?? msg.fallbackFrom.email },
      subject: emailSubjectLine(msg.subject),
      text: msg.text,
      html: msg.html,
    });
    return { lane: "fallback", message_id: null };
  }

  const domain = identity.address.split("@")[1] ?? "";
  const messageId =
    msg.messageId && domain && msg.messageId.toLowerCase().endsWith(`@${domain.toLowerCase()}>`) ? msg.messageId : mintMessageId(identity.address);
  const root = canonicalMessageId(messageId);

  const { error } = await tenantRpc(asTenantId(msg.tenant_id), "ingest_email_message", {
    p_owner_agent_slug: msg.agent_slug,
    p_owner_identity_id: identity.id,
    p_root_message_id: root,
    p_subject_normalized: msg.subject.trim().toLowerCase(),
    p_direction: "out",
    p_dedup_key: `out:${root}`,
    p_envelope_to: msg.to,
    p_from_address: identity.address,
    p_to_addresses: [msg.to],
    p_cc_addresses: [],
    p_rfc_message_id: root,
    p_in_reply_to: null,
    p_references_chain: [],
    p_subject: msg.subject,
    p_body_text: msg.text,
    p_body_html_sanitized: null,
    p_raw_mime_ref: null,
    p_spam_verdict: "pass",
    p_auto_submitted: false,
    p_headers: msg.noteKey ? { [CGO_NOTE_HEADER]: msg.noteKey } : {},
  });
  if (error) {
    await logEvent({
      level: "error",
      source: "agent-owned-email",
      code: "email.agent_owned.thread_record_failed",
      message: `could not record the thread root, so a reply will reach operator instead of ${msg.agent_slug}: ${error.message}`,
      tenant_id: msg.tenant_id,
    });
  }

  try {
    await sgMail.send({
      to: msg.to,
      from: { email: identity.address, name: identity.from_name || "Zavi" },
      replyTo: { email: identity.address },
      subject: emailSubjectLine(msg.subject),
      text: msg.text,
      html: msg.html,
      headers: { "Message-ID": messageId },
    });
  } catch (e) {
    await tenantClient(asTenantId(msg.tenant_id))
      .from("email_threads")
      .delete()
      .eq("root_message_id", root)
      .then(
        () => undefined,
        () => undefined,
      );
    throw e;
  }
  return { lane: "inbox", message_id: root };
}
