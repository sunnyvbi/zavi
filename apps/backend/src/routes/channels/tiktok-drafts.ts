
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { sendTikTokVideoToInbox, TIKTOK_VIDEO_PATH_RE } from "@/services/connectors/tiktok/api";
import { ExpectedToolError } from "@/services/tools/types";

const CHANNEL = "tiktok_organic";

const Body = z.object({
  video_path: z.string().trim().regex(TIKTOK_VIDEO_PATH_RE),
  consent: z.literal(true),
});

export async function tiktokSendToDrafts(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
    return;
  }
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, CHANNEL);
  if (locked) {
    res.status(403).json(locked.body);
    return;
  }
  const body = Body.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: "Upload an MP4 and tick the box, then try again." } });
    return;
  }
  if (!body.data.video_path.toLowerCase().startsWith(`${auth.tenant_id.toLowerCase()}/`)) {
    res.status(400).json({ error: { code: "validation", message: "That file is not in this workspace. Upload it again." } });
    return;
  }
  try {
    const r = await sendTikTokVideoToInbox(auth.tenant_id, body.data.video_path);
    res.json({ ok: true, publish_id: r.publish_id });
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      const message = e.code === "tiktok_not_connected" ? "Connect your TikTok account first, then send the video again." : e.message;
      res.status(409).json({ error: { code: e.code, message } });
      return;
    }
    console.warn(`[tiktok-drafts] send: ${(e as Error).message}`);
    res.status(502).json({ error: { code: "tiktok_drafts_failed", message: "TikTok did not take the video. Nothing was posted. Try again." } });
  }
}
