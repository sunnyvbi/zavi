
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { listBriefs, getBriefDetail, getEngagement } from "@/services/humans/tenantViews";

const IdParam = z.object({ id: z.string().uuid() });

export async function getHumanBriefs(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const briefs = await listBriefs(auth.access_token, auth.tenant_id);
  res.json({ briefs });
}

export async function getHumanBriefDetail(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_brief_id", message: "brief id is required" } });
    return;
  }
  const detail = await getBriefDetail(auth.access_token, auth.tenant_id, parsed.data.id);
  if (!detail) {
    res.status(404).json({ error: { code: "brief_not_found", message: "Brief not found." } });
    return;
  }
  res.json(detail);
}

export async function getHumanEngagement(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.engagementId });
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "bad_engagement_id", message: "engagement id is required" } });
    return;
  }
  const view = await getEngagement(auth.access_token, auth.tenant_id, parsed.data.id);
  if (!view) {
    res
      .status(404)
      .json({ error: { code: "engagement_not_found", message: "Engagement not found." } });
    return;
  }
  res.json(view);
}
