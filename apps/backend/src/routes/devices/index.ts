
import type { Request, Response } from "express";
import { z } from "zod";

import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const registerBody = z.object({
  expo_push_token: z.string().min(1).max(512),
  platform: z.enum(["ios", "android"]),
});

export async function devicesRegister(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = registerBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("upsert_device", {
    p_expo_push_token: parsed.data.expo_push_token,
    p_platform: parsed.data.platform,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "register_failed", message: error.message } });
    return;
  }

  res.json({ id: data as string });
}

export async function devicesDelete(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    res.status(400).json({
      error: { code: "bad_request", message: "id must be a uuid" },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { error } = await supabase.from("devices").delete().eq("id", id);
  if (error) {
    res
      .status(500)
      .json({ error: { code: "delete_failed", message: error.message } });
    return;
  }

  res.json({ ok: true });
}
