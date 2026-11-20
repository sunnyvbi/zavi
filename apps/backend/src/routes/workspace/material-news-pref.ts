
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getBoolSetting, setTenantSetting } from "@/services/settings";

export async function getMaterialNewsPref(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const enabled = await getBoolSetting("material_news_enabled", auth.tenant_id);
  res.json({ enabled });
}

export async function postMaterialNewsPref(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({
      error: { code: "bad_request", message: "enabled (boolean) is required" },
    });
    return;
  }

  try {
    await setTenantSetting(
      auth.tenant_id,
      "material_news_enabled",
      body.enabled,
      auth.user_id,
    );
  } catch (e) {
    res.status(500).json({
      error: { code: "set_pref_failed", message: (e as Error).message },
    });
    return;
  }

  res.json({ ok: true, enabled: body.enabled });
}
