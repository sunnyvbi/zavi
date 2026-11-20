import { asTenantId, tenantStorage } from "@/services/tenant-client";
import { z } from "zod";
import { workspaceFilesDeps, readIndex, readPublicWorkspaceFile } from "@/services/workspace-files/workspace-files";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { normalizeChatImage, readUploadedFile, sendChatImageError, storeNormalizedChatImage } from "@/services/chat-images/store-chat-image";

const photoImport = z.object({ file_id: z.string().uuid() }).strict();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single("file");
export async function postDraftPhotoUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  upload(req, res, (error: unknown) => {
    if (error) { res.status(400).json({ error: { code: "invalid_image", message: "Choose a JPG, PNG or WebP image up to 10 MB." } }); return; }
    void save(req, res, auth.tenant_id).catch(next);
  });
}
async function save(req: Request, res: Response, tenantId: string) {
  const file = readUploadedFile(req);
  if (!file.ok) return sendChatImageError(res, file);
  const normalized = await normalizeChatImage(file.file.buffer);
  if (!normalized.ok) return sendChatImageError(res, normalized);
  const stored = await storeNormalizedChatImage(tenantId, normalized.jpeg);
  if (!stored.ok) return sendChatImageError(res, stored);
  res.json({ image_path: stored.image_path });
}

export async function postDraftPhotoImport(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const input = photoImport.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: { code: "invalid_photo", message: "Choose a workspace photo." } }); return; }
  try {
    const deps = workspaceFilesDeps(auth.tenant_id);
    const index = await readIndex(deps);
    const item = index.files.find((file) => file.id === input.data.file_id && ["image/jpeg", "image/png", "image/webp"].includes(file.mime));
    if (!item || item.size > 10 * 1024 * 1024) { res.status(404).json({ error: { code: "photo_missing", message: "This workspace photo is unavailable." } }); return; }
    const content = await readPublicWorkspaceFile(deps.storage, auth.tenant_id, item.id, item.path.split("/").pop());
    if (!content || content.body.length > 10 * 1024 * 1024) throw new Error("Photo unavailable");
    const normalized = await normalizeChatImage(content.body);
    if (!normalized.ok) return sendChatImageError(res, normalized);
    const stored = await storeNormalizedChatImage(auth.tenant_id, normalized.jpeg);
    if (!stored.ok) return sendChatImageError(res, stored);
    res.json({ image_path: stored.image_path });
  } catch { res.status(503).json({ error: { code: "photo_unavailable", message: "The workspace photo could not be loaded." } }); }
}

export async function postDraftVideoUrl(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const path = req.query.path;
  if (typeof path !== "string" || !path.startsWith(`${auth.tenant_id}/`) || !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.mp4$/.test(path)) { res.status(403).json({ error: { code: "media_not_owned", message: "This video does not belong to this workspace." } }); return; }
  try {
    const result = await tenantStorage(asTenantId(auth.tenant_id)).from("launch-video-media").createSignedUrl(path, 600);
    if (result.error || !result.data?.signedUrl) throw new Error("Video unavailable");
    res.setHeader("Cache-Control", "private, no-store"); res.json({ signed_url: result.data.signedUrl });
  } catch { res.status(503).json({ error: { code: "video_unavailable", message: "The video could not be loaded." } }); }
}
