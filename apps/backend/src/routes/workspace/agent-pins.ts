
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const Body = z.object({
  pinned_slugs: z.array(z.string().min(1).max(128)).max(30),
});

export async function workspaceAgentPinsGet(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("workspace_agent_pins")
    .select("pinned_slugs")
    .eq("user_id", auth.user_id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  if (error) {
    res.status(500).json({
      error: { code: "pins_read_failed", message: error.message },
    });
    return;
  }

  const raw = (data?.pinned_slugs ?? null) as unknown;
  const pinned = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : null;
  res.json({ pinned_slugs: pinned });
}

export async function workspaceAgentPinsPut(
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

  const slugs = Array.from(new Set(body.pinned_slugs));

  const supabase = serverClientFromBearer(auth.access_token);
  const { error } = await supabase.rpc("set_agent_pins", {
    p_slugs: slugs,
  });
  if (error) {
    res.status(500).json({
      error: { code: "pins_write_failed", message: error.message },
    });
    return;
  }
  res.status(204).end();
}
