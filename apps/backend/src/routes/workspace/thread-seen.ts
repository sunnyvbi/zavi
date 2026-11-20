
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const Body = z.object({ thread_id: z.string().uuid() });

export async function workspaceThreadSeen(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { error } = await supabase.rpc("mark_thread_seen", {
    p_thread_id: body.thread_id,
  });
  if (error) {
    console.warn("[thread-seen] mark_thread_seen failed:", error.message);
    res
      .status(500)
      .json({ error: { code: "seen_write_failed", message: "Could not mark the chat seen" } });
    return;
  }
  res.status(204).end();
}
