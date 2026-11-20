
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";

const TTL_SECONDS = 600;

export async function chatImageUrl(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const path = (req.query.path as string | undefined)?.trim();
  if (!path) {
    res
      .status(400)
      .json({ error: { code: "missing_path", message: "path query param required" } });
    return;
  }

  const expectedPrefix = `${auth.tenant_id}/`;
  const validShape = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/;

  if (!path.startsWith(expectedPrefix) || !validShape.test(path)) {
    res.status(403).json({
      error: {
        code: "path_not_owned",
        message: "image path not owned by tenant or malformed",
      },
    });
    return;
  }

  const { data, error } = await serviceClient()
    .storage.from("agent-chat-images")
    .createSignedUrl(path, TTL_SECONDS);

  if (error || !data?.signedUrl) {
    res.status(404).json({
      error: {
        code: "sign_failed",
        message: error?.message ?? "could not sign image url",
      },
    });
    return;
  }

  res.status(200).json({ signed_url: data.signedUrl, expires_in: TTL_SECONDS });
}
