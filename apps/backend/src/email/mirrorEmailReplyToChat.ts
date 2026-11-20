
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { isVerifiedMemberReplyRun } from "@/services/agents/email-reply-trust";
import { logEvent } from "@/services/logging/logEvent";
import { splitReplyText } from "@/email/quoted-reply";
import { stripSignoff } from "@/email/strip-signoff";

const MAX_BODY = 32_000;

export async function mirrorEmailReplyToChat(args: {
  tenant_id: string;
  agent_slug: string;
  run_id: string;
  run_payload: unknown;
  sender_email: string;
  answer: string;
}): Promise<void> {
  try {
    const trusted = await isVerifiedMemberReplyRun({
      tenant_id: args.tenant_id,
      agent_slug: args.agent_slug,
      trigger: "email",
      payload: args.run_payload,
    });
    if (!trusted) return;

    const tid = asTenantId(args.tenant_id);
    const db = tenantClient(tid);
    const messageId = (args.run_payload as { email?: { email_message_id?: string } }).email
      ?.email_message_id;
    const { data: inbound } = await db
      .from("email_messages")
      .select("body_text, thread_id, subject")
      .eq("id", messageId ?? "")
      .maybeSingle();
    const row = inbound as { body_text: string | null; thread_id: string | null; subject: string | null } | null;
    const own = splitReplyText(row?.body_text).own;
    if (!own) return;
    const founderText = stripSignoff(own);
    if (!row?.thread_id) return;

    const { data: userId } = await tenantRpc(tid, "member_user_id_by_email", {
      p_email: args.sender_email,
    });
    if (typeof userId !== "string" || !userId) return;

    const threadId = await findOrCreateEmailChat(args.tenant_id, args.agent_slug, userId, row.thread_id, chatTitle(row.subject));
    if (!threadId) return;

    const now = Date.now();
    const { error } = await db.from("agent_thread_messages").insert([
      {
        thread_id: threadId,
        sender_role: "user",
        body: founderText.slice(0, MAX_BODY),
        meta: { via: "email", reply_run_id: args.run_id },
        created_at: new Date(now).toISOString(),
      },
      {
        thread_id: threadId,
        sender_role: "assistant",
        body: args.answer.slice(0, MAX_BODY),
        agent_run_id: args.run_id,
        meta: { via: "email", from_agent_slug: args.agent_slug },
        created_at: new Date(now + 1).toISOString(),
      },
    ]);
    if (error) throw new Error(error.message);
    await db
      .from("agent_threads")
      .update({ last_message_at: new Date(now + 1).toISOString() })
      .eq("id", threadId);
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "email-reply-mirror",
      code: "email.reply.mirror_failed",
      message: `could not mirror the email exchange into the ${args.agent_slug} chat: ${(e as Error).message}`,
      tenant_id: args.tenant_id,
    });
  }
}

export function chatTitle(subject: string | null | undefined): string | null {
  const t = String(subject ?? "")
    .replace(/^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim();
  return t ? t.slice(0, 200) : null;
}

async function findOrCreateEmailChat(
  tenant_id: string,
  agent_slug: string,
  user_id: string,
  email_thread_id: string,
  title: string | null,
): Promise<string | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const find = async () => {
    const { data } = await db
      .from("agent_threads")
      .select("id")
      .eq("agent_slug", agent_slug)
      .eq("user_id", user_id)
      .eq("email_thread_id", email_thread_id)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  const { data, error } = await db
    .from("agent_threads")
    .insert({ agent_slug, user_id, email_thread_id, title, title_source: "email" })
    .select("id")
    .maybeSingle();
  if (!error && data) return (data as { id: string }).id;
  return find();
}
