
import type { Request, Response } from "express";
import { serviceClient } from "@/services/supabase";
import { getJobById, hashSecret, safeHashEqual } from "@/services/launch-video-public/store";

const PREVIEW_TTL_SECONDS = 600;
const LAUNCH_VIDEO_BUCKET = "launch-video-artifacts";

async function signArtifact(artifactId: string): Promise<string | null> {
  const sb = serviceClient();
  const { data: row } = await sb
    .from("run_artifacts")
    .select("storage_path, bucket")
    .eq("id", artifactId)
    .maybeSingle<{ storage_path: string; bucket: string }>();
  if (!row?.storage_path) return null;
  const { data, error } = await sb.storage
    .from(row.bucket || LAUNCH_VIDEO_BUCKET)
    .createSignedUrl(row.storage_path, PREVIEW_TTL_SECONDS);
  return error ? null : (data?.signedUrl ?? null);
}

export async function launchVideoPublicStatus(req: Request, res: Response): Promise<void> {
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

  const claimed = job.status === "claimed" || job.claimed_at != null;
  const ready = job.status === "ready" || claimed;

  let preview_url: string | null = null;
  let hd_url: string | null = null;
  if (ready && job.preview_artifact_id) preview_url = await signArtifact(job.preview_artifact_id);
  if (claimed && job.hd_artifact_id) hd_url = await signArtifact(job.hd_artifact_id);

  res.status(200).json({
    status: job.status,
    ready,
    claimed,
    preview_url,
    hd_url,
    error: job.status === "failed" ? "render_failed" : null,
  });
}
