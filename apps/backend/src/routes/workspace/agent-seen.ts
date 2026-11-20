
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const Body = z.object({ slug: z.string().min(1).max(128) });

export async function workspaceAgentSeen(
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
  const { error } = await supabase.rpc("mark_agent_seen", {
    p_agent_slug: body.slug,
  });
  if (error) {
    console.warn("[agent-seen] mark_agent_seen failed:", error.message);
  }
  res.status(204).end();
}
