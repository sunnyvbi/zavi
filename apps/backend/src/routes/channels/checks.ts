
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const PROFILE_CHECK_KEYS = ["bio", "avatar", "header", "pinned"] as const;

const Params = z.object({
  slug: z.literal("x_organic"),
  key: z.enum(PROFILE_CHECK_KEYS),
});

export async function channelCheckDone(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = Params.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_check", message: "unknown channel or check" } });
    return;
  }

  const { error } = await tenantClient(asTenantId(auth.tenant_id))
    .from("social_profile_check_dismissals")
    .upsert(
      { tenant_id: auth.tenant_id, channel: "x", check_key: parsed.data.key, dismissed_at: new Date().toISOString() },
      { onConflict: "tenant_id,channel,check_key" },
    );
  if (error) {
    res.status(500).json({ error: { code: "dismiss_failed", message: error.message } });
    return;
  }
  res.json({ ok: true, key: parsed.data.key });
}
