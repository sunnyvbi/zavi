
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function agentChatHistory(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;
  const threadIdRaw = req.query.thread_id;
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw : undefined;

  if (threadId !== undefined && !UUID_RE.test(threadId)) {
    res.status(400).json({
      error: { code: "bad_request", message: "thread_id must be a uuid" },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);

  let threadQuery = supabase
    .from("agent_threads")
    .select("id, title, last_message_at, created_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("agent_slug", slug)
    .is("deleted_at", null);
  if (threadId) {
    threadQuery = threadQuery.eq("id", threadId);
  } else {
    threadQuery = threadQuery.is("email_thread_id", null).order("last_message_at", { ascending: false });
  }
  const { data: threadRows, error: terr } = await threadQuery.limit(1);
  if (terr) {
    res
      .status(500)
      .json({ error: { code: "internal", message: terr.message } });
    return;
  }
  const thread = threadRows?.[0] ?? null;

  if (threadId && !thread) {
    res
      .status(404)
      .json({ error: { code: "not_found", message: "thread not found" } });
    return;
  }
  if (!thread) {
    res.json({ thread: null, messages: [] });
    return;
  }

  const { data: messages, error: merr } = await supabase
    .from("agent_thread_messages")
    .select("id, sender_role, body, agent_run_id, created_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("thread_id", thread.id)
    .filter("meta->>superseded_by", "is", null)
    .order("created_at", { ascending: true })
    .limit(200);
  if (merr) {
    res
      .status(500)
      .json({ error: { code: "internal", message: merr.message } });
    return;
  }

  res.json({ thread, messages: messages ?? [] });
}
