import type { Request, Response } from "express";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import { prefillFromUrl } from "@/services/launch-video-public/prefill";
import { hashIp, tickAttemptBucket } from "@/services/launch-video-public/store";
import { localMetersBypassed } from "@/services/launch-video-public/caps";

const WINDOW_SECONDS = 24 * 60 * 60;

export async function launchVideoPublicPrefill(req: Request, res: Response): Promise<void> {
  if (!(await getBoolSetting("launch_video_public_enabled"))) {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
    return;
  }

  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url || url.length > 300) {
    res.status(400).json({ error: { code: "bad_url", message: "Please enter your website address." } });
    return;
  }

  const ip = req.ip || req.socket?.remoteAddress || null;
  if (!ip) {
    res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
    return;
  }

  const unmetered = localMetersBypassed();
  if (unmetered) {
    console.warn("[launch-video/prefill] LOCAL UNMETERED: lookup meter bypassed (LAUNCH_VIDEO_PUBLIC_LOCAL_UNMETERED=1)");
  }
  const limit = unmetered ? 0 : await getNumberSetting("launch_video_public_prefill_per_ip_day");
  if (limit > 0) {
    let allowed: boolean;
    try {
      allowed = await tickAttemptBucket(`lvp_prefill:ip:${hashIp(ip)}`, limit, WINDOW_SECONDS);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[launch-video/prefill] meter failed, refusing: ${(e as Error).message}`);
      res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
      return;
    }
    if (!allowed) {
      res.status(429).json({
        error: {
          code: "prefill_limited",
          message: "Too many lookups recently. Please fill the form in by hand.",
        },
      });
      return;
    }
  }

  const globalLimit = await getNumberSetting("launch_video_public_prefill_global_day");
  if (globalLimit > 0) {
    let underCeiling: boolean;
    try {
      underCeiling = await tickAttemptBucket("lvp_prefill:global", globalLimit, WINDOW_SECONDS);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[launch-video/prefill] global meter failed, refusing: ${(e as Error).message}`);
      res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
      return;
    }
    if (!underCeiling) {
      res.status(429).json({
        error: {
          code: "prefill_limited",
          message: "Too many lookups recently. Please fill the form in by hand.",
        },
      });
      return;
    }
  }

  const result = await prefillFromUrl(url);
  if (!result.ok) {
    if (result.reason === "busy") {
      res.status(503).json({
        error: {
          code: "busy",
          message: "We're a bit busy right now, so the lookup didn't run. Fill the form in by hand, or try again in a minute.",
        },
      });
      return;
    }
    const message =
      result.reason === "bad_url"
        ? "That doesn't look like a web address we can reach."
        : result.reason === "unreachable"
          ? "We couldn't reach that site. You can fill the form in by hand."
          : "We couldn't read enough from that page. You can fill the form in by hand.";
    res.status(422).json({ error: { code: result.reason, message } });
    return;
  }

  res.json({ fields: result.fields, source_url: result.source_url });
}
