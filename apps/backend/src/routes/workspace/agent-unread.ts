
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const Body = z.object({ slug: z.string().min(1).max(128) });

export async function workspaceAgentUnread(
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
  const { data, error } = await supabase.rpc("mark_agent_unread", {
    p_agent_slug: body.slug,
  });
  if (error) {
    res.status(500).json({
      error: { code: "unread_failed", message: error.message },
    });
    return;
  }
  res.json({ marked: data === true });
}
