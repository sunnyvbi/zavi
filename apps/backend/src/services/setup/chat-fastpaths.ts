
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { isSetupActive } from "./state";
import { answerSetupQuestion } from "./faq";
import { setCompanyFact } from "@/services/company/facts";
import { deleteNote } from "@/services/memory";
import { askNextConflict } from "@/services/knowledge-import/ask-conflict";
import { isLowIntentGreeting } from "@/services/agents/acknowledgment-classify";

export const CGO = "cgo";
export const CONFLICT_USE_FILE = "Use the file's";
export const CONFLICT_KEEP = "Keep what you have";
const GREETING_REPLY = "Hey! How can Zavi help you?";

type Auth = { tenant_id: string; user_id: string };
type Body = { message: string; thread_id?: string | null };
export type FastPathResult = { thread_id: string; user_message_id: string | null; ok: true; action: string };

export class SetupFastPathError extends Error {
  constructor(readonly reason: string) {
    super(`setup fast path failed: ${reason}`);
    this.name = "SetupFastPathError";
  }
}

export async function ownThread(auth: Auth, slug: string, thread_id: string | null | undefined, title: string): Promise<string | null> {
  const db = tenantClient(asTenantId(auth.tenant_id));
  if (thread_id) {
    const { data, error } = await db.from("agent_threads").select("id, user_id, agent_slug").eq("id", thread_id).maybeSingle();
    if (error) throw new SetupFastPathError("thread_read_failed");
    const t = data as { user_id?: string; agent_slug?: string } | null;
    return t && t.user_id === auth.user_id && t.agent_slug === slug ? thread_id : null;
  }
  const { data, error } = await db
    .from("agent_threads")
    .insert({ agent_slug: slug, user_id: auth.user_id, title: title.slice(0, 80) })
    .select("id")
    .single();
  if (error || !data) throw new SetupFastPathError("thread_create_failed");
  return (data as { id: string }).id;
}

export async function latestCgoThread(tenant_id: string, user_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_threads")
    .select("id")
    .eq("agent_slug", CGO)
    .eq("user_id", user_id)
    .is("email_thread_id", null)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new SetupFastPathError("thread_read_failed");
  return (data as { id?: string } | null)?.id ?? null;
}

export async function writeNoRunExchange(
  auth: Auth,
  thread_id: string,
  userText: string,
  reply: string,
  meta: Record<string, unknown>,
): Promise<string | null> {
  const db = tenantClient(asTenantId(auth.tenant_id));
  const { data: userRow, error: userErr } = await db
    .from("agent_thread_messages")
    .insert({ thread_id, sender_role: "user", body: userText, agent_run_id: null })
    .select("id")
    .single();
  if (userErr) throw new SetupFastPathError("message_write_failed");
  const { error: botErr } = await db
    .from("agent_thread_messages")
    .insert({ thread_id, sender_role: "assistant", body: reply, agent_run_id: null, meta: { no_run: true, ...meta } })
    .select("id")
    .single();
  if (botErr) throw new SetupFastPathError("message_write_failed");
  await db.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", thread_id);
  return (userRow as { id?: string } | null)?.id ?? null;
}

export async function trySetupFaq(auth: Auth, body: Body): Promise<FastPathResult | null> {
  const text = body.message.trim();
  if (!text) return null;
  if (!(await isSetupActive(auth.tenant_id))) return null;
  const role = await loadTenantRoleFor(auth.user_id, auth.tenant_id);
  if (role !== "owner" && role !== "admin") return null;
  const thread_id = await ownThread(auth, CGO, body.thread_id, text);
  if (!thread_id) throw new SetupFastPathError("thread_unavailable");
  const reply = await answerSetupQuestion(auth.tenant_id, text);
  const user_message_id = await writeNoRunExchange(auth, thread_id, text, reply, { reason: "setup_faq" });
  return { thread_id, user_message_id, ok: true, action: "setup_faq_no_run" };
}

export async function tryGreeting(auth: Auth, slug: string, body: Body): Promise<FastPathResult | null> {
  if (!isLowIntentGreeting(body.message)) return null;
  const thread_id = await ownThread(auth, slug, body.thread_id, body.message);
  if (!thread_id) return null;
  const user_message_id = await writeNoRunExchange(auth, thread_id, body.message, GREETING_REPLY, { reason: "greeting" });
  return { thread_id, user_message_id, ok: true, action: "greeting_no_run" };
}

type ConflictMeta = { key?: string; file_value?: string; existing_value?: string; status?: string; asked_at?: string | null };

export async function tryResolveConflict(auth: Auth, body: Body): Promise<FastPathResult | null> {
  const text = body.message.trim().toLowerCase();
  const choice = text === CONFLICT_USE_FILE.toLowerCase() ? "file" : text === CONFLICT_KEEP.toLowerCase() ? "keep" : null;
  if (!choice || !body.thread_id) return null;
  const role = await loadTenantRoleFor(auth.user_id, auth.tenant_id);
  if (role !== "owner" && role !== "admin") return null;
  const thread_id = await ownThread(auth, CGO, body.thread_id, "");
  if (!thread_id) return null;
  const db = tenantClient(asTenantId(auth.tenant_id));
  const { data: last, error: lastErr } = await db
    .from("agent_thread_messages")
    .select("meta")
    .eq("thread_id", thread_id)
    .eq("sender_role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) throw new SetupFastPathError("message_read_failed");
  const lastMeta = (last as { meta?: { fact_conflict?: { note_id?: string }; reason?: string } } | null)?.meta;
  const alreadyResolved = async (): Promise<FastPathResult> => {
    const user_message_id = await writeNoRunExchange(auth, thread_id, body.message.trim(),
      "That one's already answered. Nothing else to do.", { reason: "fact_conflict_already_resolved" });
    return { thread_id, user_message_id, ok: true, action: "fact_conflict_already_resolved" };
  };
  const noteId = lastMeta?.fact_conflict?.note_id;
  const acked = lastMeta?.reason === "fact_conflict_resolved" || lastMeta?.reason === "fact_conflict_already_resolved";
  if (!noteId) return acked ? alreadyResolved() : null;
  const { data: note, error: noteErr } = await db
    .from("memory_note")
    .select("id, source_ref, metadata")
    .eq("id", noteId)
    .eq("source", "document_import")
    .maybeSingle();
  if (noteErr) throw new SetupFastPathError("note_read_failed");
  const n = note as { source_ref?: string; metadata?: Record<string, unknown> } | null;
  const conflict = (n?.metadata?.conflict ?? null) as ConflictMeta | null;
  if (!n || !conflict || conflict.status !== "open") return alreadyResolved();
  if (!conflict.key) return null;
  const key = conflict.key as Parameters<typeof setCompanyFact>[1];

  const value = choice === "file" ? conflict.file_value ?? "" : conflict.existing_value ?? "";
  const write = await setCompanyFact(auth.tenant_id, key, value, choice === "file" ? n.source_ref ?? "setup:conflict" : "setup:conflict");
  if (!write.ok) {
    const user_message_id = await writeNoRunExchange(auth, thread_id, body.message.trim(),
      "I couldn't save that just now. Tap your answer again in a moment.", { reason: "fact_conflict_failed" });
    return { thread_id, user_message_id, ok: true, action: "fact_conflict_failed" };
  }
  let closed = false;
  if (choice === "file") {
    const { data: upd, error: updErr } = await db
      .from("memory_note")
      .update({ metadata: { ...n.metadata, conflict: { ...conflict, status: "file" } } })
      .eq("id", noteId)
      .eq("source", "document_import")
      .select("id");
    closed = !updErr && (upd ?? []).length === 1;
  } else {
    closed = await deleteNote(auth.tenant_id, noteId, auth.user_id, "founder kept the existing value").then(
      () => true,
      () => false,
    );
  }
  if (!closed) {
    const user_message_id = await writeNoRunExchange(auth, thread_id, body.message.trim(),
      "I couldn't save that just now. Tap your answer again in a moment.", { reason: "fact_conflict_failed" });
    return { thread_id, user_message_id, ok: true, action: "fact_conflict_failed" };
  }
  const reply = choice === "file" ? `Got it. I'll use "${value}".` : `Got it. I'll keep "${value}".`;
  const user_message_id = await writeNoRunExchange(auth, thread_id, body.message.trim(), reply, { reason: "fact_conflict_resolved" });
  await askNextConflict({ tenant_id: auth.tenant_id, user_id: auth.user_id }).catch(() => {});
  return { thread_id, user_message_id, ok: true, action: "fact_conflict_resolved" };
}
