
import type { Request, Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import { extensionAuthCodeClient } from "@/services/tenant-client";

const DEFAULT_REDIRECT_URI =
  "https://kfgbahfijacgiigdnlaoaemdfbolabia.chromiumapp.org/callback";

export const CODE_TTL_MS = 60_000;

export function extensionRedirectUri(): string {
  return process.env.EXTENSION_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export async function extensionConnectStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const code = randomBytes(32).toString("base64url");

  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  const sb = extensionAuthCodeClient(
    "Chrome-extension sign-in handoff: store the hash of a single-use code against the authed user id.",
  );
  const { error } = await sb.from("extension_auth_codes").insert({
    code_hash: hashCode(code),
    user_id: auth.user_id,
    expires_at: expiresAt,
  });
  if (error) {
    res.status(500).json({
      error: { code: "connect_start_failed", message: "Could not start the connection. Try again." },
    });
    return;
  }

  res.json({ code, redirect_uri: extensionRedirectUri() });
}
