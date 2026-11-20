
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { loadTenantRole } from "@/services/auth/tenant-role";
import {
  normalizeChatImage,
  readUploadedFile,
  sendChatImageError,
  storeNormalizedChatImage,
} from "@/services/chat-images/store-chat-image";
import { uploadWorkspaceFiles, workspaceFilesDeps } from "@/services/workspace-files/workspace-files";

export { chatImageUploadMiddleware } from "@/services/chat-images/store-chat-image";

export async function chatImageUpload(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const got = readUploadedFile(req);
  if (!got.ok) return sendChatImageError(res, got);

  const normalized = await normalizeChatImage(got.file.buffer);
  if (!normalized.ok) return sendChatImageError(res, normalized);

  const stored = await storeNormalizedChatImage(auth.tenant_id, normalized.jpeg);
  if (!stored.ok) return sendChatImageError(res, stored);

  const saved_to_files =
    req.query?.save_to_files === "1" &&
    (await saveChatImageToFiles(auth, got.file.originalname, normalized.jpeg));

  res.status(200).json({ image_path: stored.image_path, saved_to_files });
}

const FILES_WRITER_ROLES = ["owner", "admin"];

function jpgName(originalname: string): string {
  const stem = (originalname || "").replace(/\.[^./\\]*$/, "").trim();
  return `${stem || "chat-image"}.jpg`;
}

async function saveChatImageToFiles(auth: AuthedRequest, originalname: string, jpeg: Buffer): Promise<boolean> {
  try {
    const role = await loadTenantRole(auth);
    if (!role || !FILES_WRITER_ROLES.includes(role)) return false;
    await uploadWorkspaceFiles(workspaceFilesDeps(auth.tenant_id), {
      files: [{ originalname: jpgName(originalname), mimetype: "image/jpeg", size: jpeg.length, buffer: jpeg }],
      uploadedBy: auth.user_id,
    });
    return true;
  } catch (e) {
    console.error(`[chat-upload-image] save to files failed: ${(e as Error).message}`);
    return false;
  }
}
