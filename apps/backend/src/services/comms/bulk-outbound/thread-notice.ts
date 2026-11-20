
import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function postBulkSendNotice(tenantId: string, sendId: string, text: string): Promise<boolean> {
  const db = tenantClient(asTenantId(tenantId));
  const { data: send } = await db.from("email_bulk_sends").select("decision_id").eq("id", sendId).maybeSingle();
  const decisionId = (send as { decision_id?: string } | null)?.decision_id;
  if (!decisionId) return false;
  const { data: decision } = await db.from("decisions").select("agent_run_id").eq("id", decisionId).maybeSingle();
  const runId = (decision as { agent_run_id?: string | null } | null)?.agent_run_id;
  if (!runId) return false;
  const { data: run } = await db.from("agent_runs").select("trigger, payload").eq("id", runId).maybeSingle();
  const r = run as { trigger?: string | null; payload?: { thread_id?: unknown } | null } | null;
  if (!r || (r.trigger !== "chat" && r.trigger !== "a2a")) return false;
  const threadId = typeof r.payload?.thread_id === "string" ? r.payload.thread_id : "";
  if (!threadId) return false;
  const { data: thread } = await db.from("agent_threads").select("id").eq("id", threadId).maybeSingle();
  if (!thread) return false;

  const { error } = await db.from("agent_thread_messages").insert({
    thread_id: threadId,
    sender_role: "assistant",
    body: text,
    meta: { dispatch_notice: true, decision_id: decisionId, decision_class: "bulk_outbound.send", ok: true },
    agent_run_id: null,
  });
  if (error) return false;
  await db.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", threadId);
  return true;
}
