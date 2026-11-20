
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { invalidateTenantKeepaliveCache } from "@/services/sandbox/keepalive-flag";

const bodySchema = z
  .object({
    sandbox_keepalive_enabled: z.boolean(),
  })
  .strict()
  .refine(
    (d) => Object.keys(d).length > 0,
    "at least one setting required",
  );

export async function patchTenantSettings(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "validation", message: parsed.error.message } });
    return;
  }
  const patch = parsed.data;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("set_tenant_sandbox_keepalive", {
    p_tenant_id: auth.tenant_id,
    p_enabled: patch.sandbox_keepalive_enabled,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  invalidateTenantKeepaliveCache(auth.tenant_id);

  res.json({ sandbox_keepalive_enabled: data });
}
