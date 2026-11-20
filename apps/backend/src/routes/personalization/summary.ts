
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { buildPersonalizationSummary } from "@/services/personalization/summary";

export async function getPersonalizationSummary(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json(await buildPersonalizationSummary(auth.tenant_id));
  } catch (e) {
    res.status(500).json({ error: { code: "summary_failed", message: (e as Error).message } });
  }
}
