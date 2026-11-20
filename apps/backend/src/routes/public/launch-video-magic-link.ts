
import type { Request, Response } from "express";
import { getJobById, hashSecret, safeHashEqual } from "@/services/launch-video-public/store";
import { sendLaunchVideoClaimEmail } from "@/email/sendAuthEmail";

export async function launchVideoPublicSendMagicLink(req: Request, res: Response): Promise<void> {
  const jobId = typeof req.body?.job_id === "string" ? req.body.job_id.trim() : "";
  const secret = typeof req.body?.secret === "string" ? req.body.secret : "";
  if (!jobId || !secret) {
    res.status(400).json({ error: { code: "missing_params", message: "job_id and secret are required." } });
    return;
  }

  const job = await getJobById(jobId);
  if (!job || !safeHashEqual(job.client_secret_hash, hashSecret(secret))) {
    res.status(403).json({ error: { code: "not_authorized", message: "Not found." } });
    return;
  }
  if (!job.email) {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    await sendLaunchVideoClaimEmail(job.email, job.id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[launch-video/send-magic-link] send failed", { msg: (e as Error).message });
    res.status(500).json({ error: { code: "send_failed", message: "Couldn't send the link. Try again in a moment." } });
    return;
  }

  res.status(200).json({ ok: true });
}
