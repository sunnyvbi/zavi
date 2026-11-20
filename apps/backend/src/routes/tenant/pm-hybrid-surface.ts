
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getBoolSetting } from "@/services/settings";

const SETTING_KEY = "pm_hybrid_surface";

export async function getPmHybridSurface(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const enabled = await getBoolSetting(SETTING_KEY, auth.tenant_id);
    res.json({ enabled });
  } catch (e) {
    res.status(500).json({
      error: { code: "read_failed", message: (e as Error).message },
    });
  }
}
