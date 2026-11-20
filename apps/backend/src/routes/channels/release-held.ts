
import type { Request, Response } from "express";
import { isChannelSlug } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { releasePacedChannels } from "@/services/channels/onboarding-pacing";

export async function channelActionsReleaseHeld(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    return;
  }
  const slug = String(req.params.slug ?? "");
  if (!isChannelSlug(slug)) {
    res.status(404).json({ error: { code: "unknown_channel", message: "Unknown channel." } });
    return;
  }
  try {
    res.json({ ok: true, released: await releasePacedChannels(auth.tenant_id, [slug]) });
  } catch {
    res.status(500).json({ error: { code: "release_failed", message: "Could not show them just now. Try again." } });
  }
}
