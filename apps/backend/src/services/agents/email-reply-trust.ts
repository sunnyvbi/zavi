
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { parseAddrSpec } from "@/email/addr-spec";
import { splitReplyText } from "@/email/quoted-reply";

export async function isVerifiedMemberReplyRun(claim: {
  tenant_id: string;
  agent_slug: string;
  trigger: string | null | undefined;
  payload: unknown;
}): Promise<boolean> {
  if (claim.trigger !== "email") return false;
  const email = (claim.payload as { email?: { email_message_id?: unknown } } | null)?.email;
  const messageId = typeof email?.email_message_id === "string" ? email.email_message_id : null;
  if (!messageId) return false;

  try {
    const db = tenantClient(asTenantId(claim.tenant_id));
    const { data: msg } = await db
      .from("email_messages")
      .select("thread_id, direction, sender_verified_member, from_address, rfc_message_id, attachments, body_text")
      .eq("id", messageId)
      .maybeSingle();
    const m = msg as {
      thread_id: string;
      direction: string;
      sender_verified_member: boolean;
      from_address: string | null;
      rfc_message_id: string | null;
      attachments: unknown;
      body_text: string | null;
    } | null;
    if (!m || m.direction !== "in" || m.sender_verified_member !== true) return false;

    if (Array.isArray(m.attachments) ? m.attachments.length > 0 : m.attachments != null) {
      return false;
    }

    const split = splitReplyText(m.body_text);
    if (split.forwarded || !split.own) return false;

    const from = parseAddrSpec(m.from_address ?? "")?.address;
    if (!from) return false;

    const { data: thread } = await db
      .from("email_threads")
      .select("owner_agent_slug, root_message_id")
      .eq("id", m.thread_id)
      .maybeSingle();
    const t = thread as { owner_agent_slug: string; root_message_id: string | null } | null;
    if (!t?.root_message_id || t.owner_agent_slug !== claim.agent_slug) return false;

    const { data: root } = await db
      .from("email_messages")
      .select("id, to_addresses")
      .eq("thread_id", m.thread_id)
      .eq("direction", "out")
      .eq("rfc_message_id", t.root_message_id)
      .limit(1)
      .maybeSingle();
    if (!root) return false;

    const emailed = ((root as { to_addresses: unknown }).to_addresses ?? []) as unknown;
    const recipients = (Array.isArray(emailed) ? emailed : [])
      .map((a: unknown) => parseAddrSpec(String(a ?? ""))?.address)
      .filter((a): a is string => !!a);
    if (!recipients.includes(from)) return false;

    const rfcId = (m.rfc_message_id ?? "").trim();
    if (!rfcId) return false;
    const { data: first, error: firstErr } = await db
      .from("email_messages")
      .select("id")
      .eq("direction", "in")
      .eq("rfc_message_id", rfcId)
      .order("received_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstErr || (first as { id: string } | null)?.id !== messageId) return false;

    const tid = asTenantId(claim.tenant_id);
    const { data: isMember, error: memberErr } = await tenantRpc(tid, "is_tenant_member_email", {
      p_email: from,
    });
    if (memberErr || isMember !== true) return false;
    const { data: disabled, error: disabledErr } = await tenantRpc(tid, "disabled_member_emails", {});
    if (disabledErr) return false;
    const off = (Array.isArray(disabled) ? disabled : []).map((e: unknown) =>
      String(e ?? "").trim().toLowerCase(),
    );
    return !off.includes(from);
  } catch {
    return false;
  }
}

export async function emailReplyOwnText(tenant_id: string, payload: unknown): Promise<string | null> {
  const id = (payload as { email?: { email_message_id?: unknown } } | null)?.email?.email_message_id;
  if (typeof id !== "string" || !id) return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("email_messages")
    .select("body_text")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const own = splitReplyText((data as { body_text: string | null }).body_text).own;
  return own ? own.trim() : null;
}
