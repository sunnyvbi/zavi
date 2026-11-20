import type { serverClientFromBearer } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { BUILD_SESSION_PAYLOAD_KEY, buildSessionOfPayload } from "@/services/agents/build-session-binding";

export const BUILD_CHAT_AGENT = "operator";
const BOUND_RUN_CAP = 200;

type Reader = ReturnType<typeof serverClientFromBearer>;

export async function buildChatThreadsOn(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_chat_thread_follows_build", tenantId);
  } catch {
    return false;
  }
}

export async function buildChatThreadIds(
  db: Reader,
  tenantId: string,
  userId: string,
): Promise<Map<string, string[]>> {
  const { data: runs, error } = await db
    .from("agent_runs")
    .select("payload")
    .eq("tenant_id", tenantId)
    .eq("agent_slug", BUILD_CHAT_AGENT)
    .eq("enqueued_by", userId)
    .not(`payload->>${BUILD_SESSION_PAYLOAD_KEY}`, "is", null)
    .order("enqueued_at", { ascending: false })
    .limit(BOUND_RUN_CAP);
  if (error) throw new Error(error.message);
  const threadSession = new Map<string, string>();
  for (const row of (runs ?? []) as Array<{ payload: unknown }>) {
    const threadId = (row.payload as { thread_id?: unknown } | null)?.thread_id;
    const session = buildSessionOfPayload(row.payload);
    if (typeof threadId !== "string" || !session || threadSession.has(threadId)) continue;
    threadSession.set(threadId, session);
  }
  const out = new Map<string, string[]>();
  if (threadSession.size === 0) return out;
  const { data: threads, error: threadErr } = await db
    .from("agent_threads")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("agent_slug", BUILD_CHAT_AGENT)
    .in("id", [...threadSession.keys()])
    .is("deleted_at", null)
    .order("last_message_at", { ascending: false });
  if (threadErr) throw new Error(threadErr.message);
  for (const row of (threads ?? []) as Array<{ id: string }>) {
    const session = threadSession.get(row.id);
    if (!session) continue;
    const list = out.get(session) ?? [];
    list.push(row.id);
    out.set(session, list);
  }
  return out;
}
