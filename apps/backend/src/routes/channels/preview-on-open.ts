
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { startPreviewOnOpen } from "@/services/growth/auto-first-run";

const SlugParam = z.object({ slug: z.string().min(1).max(64) });

export async function channelPreviewOnOpen(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = SlugParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_slug", message: "slug is required" } });
    return;
  }
  res.status(202).json(await startPreviewOnOpen(auth.tenant_id, parsed.data.slug));
}
