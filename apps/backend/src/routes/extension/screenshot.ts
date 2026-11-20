
import type { Request, Response } from "express";
import { authMiddleware, requireAuth } from "@/services/auth/middleware";
import { hasCurrentExtensionConsent } from "@/services/extension/consent";
import { checkExtensionScreenshotDailyCap } from "@/services/agents/extension-spend-guard";
import { recordExtensionScreenshot } from "@/services/extension/screenshots";
import {
  CHAT_IMAGE_BUCKET,
  chatImageUploadMiddleware,
  normalizeChatImage,
  readUploadedFile,
  sendChatImageError,
  storeNormalizedChatImage,
} from "@/services/chat-images/store-chat-image";
import { asTenantId, tenantStorage } from "@/services/tenant-client";

export async function postExtensionScreenshot(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const consented = await hasCurrentExtensionConsent(auth.tenant_id, auth.user_id);
  if (!consented) {
    res.status(403).json({
      error: {
        code: "consent_required",
        message:
          "Zavi needs your OK before it can read the page you're on. Open the Zavi extension to turn page reading on.",
      },
    });
    return;
  }

  const cap = await checkExtensionScreenshotDailyCap(auth.tenant_id);
  if (!cap.allowed) {
    res.status(429).json({
      error: {
        code: "extension_daily_cap",
        message: `You've used today's ${cap.cap} page reads. This resets at midnight UTC.`,
      },
    });
    return;
  }

  const got = readUploadedFile(req);
  if (!got.ok) return sendChatImageError(res, got);

  const normalized = await normalizeChatImage(got.file.buffer);
  if (!normalized.ok) return sendChatImageError(res, normalized);

  const stored = await storeNormalizedChatImage(auth.tenant_id, normalized.jpeg);
  if (!stored.ok) return sendChatImageError(res, stored);

  try {
    await recordExtensionScreenshot(auth.tenant_id, auth.user_id, stored.image_path);
  } catch (e) {
    await tenantStorage(asTenantId(auth.tenant_id))
      .from(CHAT_IMAGE_BUCKET)
      .remove([stored.image_path])
      .catch(() => undefined);
    res.status(500).json({
      error: { code: "ledger_write_failed", message: (e as Error).message },
    });
    return;
  }

  res.status(200).json({ image_path: stored.image_path });
}

export const extensionScreenshotChain = [
  authMiddleware,
  chatImageUploadMiddleware,
  postExtensionScreenshot,
];
