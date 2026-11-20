
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { verifyBearer } from "@/services/auth/jwt";
import { humanApplicantStorage } from "@/services/tenant-client";
import {
  CREATOR_PHOTO_MAX_BYTES,
  CREATOR_SAMPLE_VIDEOS_MAX,
  CREATOR_VIDEO_MAX_BYTES,
  CREATOR_VIDEO_MIME,
  isCreatorPhotoMime,
  photoExtensionFor,
  videoExtensionFor,
} from "@zavi/shared";
import { HumanError } from "@/services/humans/contract";

const MEDIA_BUCKET = "creator-media";

const UPLOAD_URL_TTL_NOTE = "Supabase signed upload tokens are single-use and short-lived.";

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function sendUnexpected(res: Response, where: string, e: unknown): void {
  if (e instanceof HumanError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.error(`[human] ${where} failed: ${(e as Error)?.message ?? e}`);
  fail(res, 500, "human_unavailable", "Creator signup is temporarily unavailable.");
}

export async function postMediaUploadUrl(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    fail(res, 401, "unauthorized", "Sign in required.");
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (kind !== "intro" && kind !== "sample" && kind !== "photo") {
    fail(res, 400, "validation", "Say whether this is your intro video, a sample or your profile photo.");
    return;
  }
  const contentType = typeof body.content_type === "string" ? body.content_type.trim() : "";
  let ext: string | null;
  let maxBytes: number;
  if (kind === "photo") {
    ext = isCreatorPhotoMime(contentType) ? photoExtensionFor(contentType) : null;
    if (!ext) {
      fail(res, 400, "unsupported_media_type", "Upload a JPG, PNG or WebP photo.");
      return;
    }
    maxBytes = CREATOR_PHOTO_MAX_BYTES;
  } else {
    ext = (CREATOR_VIDEO_MIME as readonly string[]).includes(contentType) ? videoExtensionFor(contentType) : null;
    if (!ext) {
      fail(res, 400, "unsupported_media_type", "Upload an MP4, MOV or WebM video.");
      return;
    }
    maxBytes = CREATOR_VIDEO_MAX_BYTES;
  }
  if (body.size_bytes !== undefined) {
    const size = Number(body.size_bytes);
    if (!Number.isFinite(size) || size <= 0) {
      fail(res, 400, "validation", "That file is empty.");
      return;
    }
    if (size > maxBytes) {
      fail(
        res,
        413,
        "file_too_large",
        kind === "photo" ? "Photos can be up to 5 MB." : "Videos can be up to 100 MB.",
      );
      return;
    }
  }

  const path = `${verified.user_id}/${randomUUID()}.${ext}`;

  try {
    const { data, error } = await humanApplicantStorage(verified.user_id)
      .from(MEDIA_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      console.error(`[human] signed upload url failed: ${error?.message ?? "no data"}`);
      fail(res, 502, "upload_url_failed", "We couldn't start that upload. Try again.");
      return;
    }
    res.json({
      path: data.path ?? path,
      token: data.token,
      signed_url: data.signedUrl,
      bucket: MEDIA_BUCKET,
      max_bytes: maxBytes,
      samples_max: CREATOR_SAMPLE_VIDEOS_MAX,
      note: UPLOAD_URL_TTL_NOTE,
    });
  } catch (e) {
    sendUnexpected(res, "signed upload url", e);
  }
}
