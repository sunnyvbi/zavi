
import { Readable, pipeline } from "node:stream";
import type { Response } from "express";
import { isOwnMediaPath } from "@zavi/shared";
import { humanApplicantStorage } from "@/services/tenant-client";
import { CREATOR_MEDIA_BUCKET } from "./creator-media";

const SELF_SIGNED_TTL_SECONDS = 60;

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function introVideoMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "video/mp4";
}

export type IntroVideoDeps = {
  sign: (path: string, ownerAuthUserId: string) => Promise<string | null>;
  fetch: (url: string) => Promise<globalThis.Response>;
};

export const realIntroVideoDeps: IntroVideoDeps = {
  async sign(path, owner) {
    try {
      const { data, error } = await humanApplicantStorage(owner)
        .from(CREATOR_MEDIA_BUCKET)
        .createSignedUrl(path, SELF_SIGNED_TTL_SECONDS);
      if (error) return null;
      return (data as { signedUrl?: string } | null)?.signedUrl ?? null;
    } catch {
      return null;
    }
  },
  fetch: (url) => fetch(url),
};

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "intro_video_not_found", message: "This creator has no intro video." } });
}

export async function streamIntroVideo(
  res: Response,
  path: string | null | undefined,
  ownerAuthUserId: string | null | undefined,
  deps: IntroVideoDeps = realIntroVideoDeps,
): Promise<void> {
  if (!path || !ownerAuthUserId || !isOwnMediaPath(path, ownerAuthUserId)) return notFound(res);
  const url = await deps.sign(path, ownerAuthUserId);
  if (!url) return notFound(res);
  let upstream: globalThis.Response;
  try {
    upstream = await deps.fetch(url);
  } catch {
    res.status(503).json({ error: { code: "intro_video_unavailable", message: "The video did not load. Try again." } });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    if (upstream.status === 404 || upstream.status === 400) return notFound(res);
    res.status(503).json({ error: { code: "intro_video_unavailable", message: "The video did not load. Try again." } });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", introVideoMime(path));
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const body = Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream);
  if (res.destroyed || res.writableEnded) {
    body.destroy();
    return;
  }
  pipeline(body, res, () => {
  });
}
