import type { Request, Response } from "express";
import { getBoolSetting } from "@/services/settings";
import { turnstileSiteKey } from "@/services/launch-video-public/captcha";

export async function launchVideoPublicConfig(_req: Request, res: Response): Promise<void> {
  const enabled = await getBoolSetting("launch_video_public_enabled");
  if (!enabled) {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
    return;
  }
  const required = await getBoolSetting("launch_video_public_captcha_required");
  res.json({
    captcha: {
      required,
      site_key: required ? turnstileSiteKey() : null,
    },
  });
}
