import type { serverClientFromBearer } from "@/services/supabase";

type Supabase = ReturnType<typeof serverClientFromBearer>;

type UnreadInput = { id: string; last_message_at: string | null };

export type UnreadReply = {
  head: string;
  kind: "question" | "reply";
  at: string;
};

type LatestRow = {
  thread_id: string;
  created_at: string;
  body_head: string | null;
  is_question: boolean | null;
};

export async function attachThreadUnread<T extends UnreadInput>(
  supabase: Supabase,
  threads: T[],
): Promise<Array<T & { unread: boolean; unread_reply: UnreadReply | null }>> {
  const ids = threads.map((t) => t.id);
  const replyById = new Map<string, UnreadReply>();

  if (ids.length > 0) {
    const { data: markers, error: markerError } = await supabase
      .from("agent_thread_seen_marker")
      .select("thread_id, seen_at")
      .in("thread_id", ids);
    if (markerError) {
      console.warn("[thread-unread] seen markers read failed:", markerError.message);
      return threads.map((t) => ({ ...t, unread: false, unread_reply: null }));
    }
    const seenAt = new Map<string, string>();
    for (const m of (markers ?? []) as Array<{
      thread_id: string;
      seen_at: string;
    }>) {
      seenAt.set(m.thread_id, m.seen_at);
    }

    const candidates = threads.filter((t) => {
      const seen = seenAt.get(t.id);
      if (!seen) return true;
      return !!t.last_message_at && t.last_message_at > seen;
    });

    if (candidates.length > 0) {
      const { data, error } = await supabase.rpc("latest_assistant_messages", {
        p_thread_ids: candidates.map((t) => t.id),
      });
      if (error) {
        console.warn("[thread-unread] latest_assistant_messages failed:", error.message);
      }
      for (const m of (data ?? []) as LatestRow[]) {
        const seen = seenAt.get(m.thread_id);
        if (seen && !(m.created_at > seen)) continue;
        replyById.set(m.thread_id, {
          head: m.body_head ?? "",
          kind: m.is_question ? "question" : "reply",
          at: m.created_at,
        });
      }
    }
  }

  return threads.map((t) => {
    const reply = replyById.get(t.id) ?? null;
    return { ...t, unread: reply !== null, unread_reply: reply };
  });
}
