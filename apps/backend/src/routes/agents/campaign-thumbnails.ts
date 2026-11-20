import type { Request, Response } from "express";
import { campaignMediaChannelSchema } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { readChannelCampaignMedia, validCampaignMediaIds } from "@/services/campaign-media/read";

export async function agentCampaignThumbnails(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (req.params.slug !== "performance-marketer") { res.status(404).json({ error: { code: "unsupported_agent" } }); return; }
  const channel = campaignMediaChannelSchema.safeParse(req.query.channel ?? "meta_ads");
  if (!channel.success) { res.status(400).json({ error: { code: "unsupported_channel" } }); return; }
  const ids = typeof req.query.campaign_ids === "string" ? [...new Set(req.query.campaign_ids.split(","))] : [];
  if (!validCampaignMediaIds(channel.data, ids)) { res.status(400).json({ error: { code: "invalid_campaign_ids" } }); return; }
  const level = req.query.level === "ad" ? "ad" : "campaign";
  if (level === "ad" && channel.data !== "linkedin_ads") { res.status(400).json({ error: { code: "unsupported_level" } }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  try {
    res.json({ thumbnails: await readChannelCampaignMedia(auth.tenant_id, channel.data, ids, req.query.refresh === "1", level) });
  } catch {
    res.status(502).json({ error: { code: "campaign_thumbnails_unavailable" } });
  }
}
