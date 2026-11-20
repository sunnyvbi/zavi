
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function agentRenameThread(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const threadId = req.params.threadId;
  if (!threadId || !UUID_RE.test(threadId)) {
    res.status(400).json({ error: { code: "bad_thread_id" } });
    return;
  }

  const raw = (req.body as { title?: unknown } | undefined)?.title;
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title || title.length > 120) {
    res.status(400).json({ error: { code: "bad_title" } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data: owned, error: readError } = await supabase
    .from("agent_threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (readError) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: readError.message } });
    return;
  }
  if (!owned) {
    res.status(404).json({ error: { code: "thread_not_found" } });
    return;
  }

  const { error: writeError } = await serviceClient()
    .from("agent_threads")
    .update({ title })
    .eq("id", threadId);
  if (writeError) {
    res
      .status(500)
      .json({ error: { code: "write_failed", message: writeError.message } });
    return;
  }

  res.json({ renamed: true, title });
}
