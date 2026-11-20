import { asTenantId, tenantStorage } from "@/services/tenant-client";
import {
  CHAT_IMAGE_BUCKET,
  MAX_UPLOAD_BYTES,
  normalizeChatImage,
  sniffImageMime,
  storeNormalizedChatImage,
} from "@/services/chat-images/store-chat-image";

export const MAX_IDEA_IMAGES = 3;
export const IDEA_IMAGE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export type IdeaImagesResult =
  | { ok: true; jpegs: Buffer[] }
  | { ok: false; message: string };

export async function validateIdeaImages(raw: unknown): Promise<IdeaImagesResult> {
  if (raw === undefined || raw === null) return { ok: true, jpegs: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "reference_images must be a list of images" };
  if (raw.length > MAX_IDEA_IMAGES) {
    return { ok: false, message: `attach at most ${MAX_IDEA_IMAGES} images` };
  }
  const jpegs: Buffer[] = [];
  for (const item of raw) {
    const match = typeof item === "string" ? DATA_URL_RE.exec(item) : null;
    if (!match) return { ok: false, message: "each image must be a png, jpeg or webp" };
    const buf = Buffer.from(match[2], "base64");
    if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
      return { ok: false, message: "each image must be 5 MB or smaller" };
    }
    if (!sniffImageMime(buf)) return { ok: false, message: "each image must be a png, jpeg or webp" };
    const normalized = await normalizeChatImage(buf);
    if (!normalized.ok) return { ok: false, message: "one of the images could not be read" };
    jpegs.push(normalized.jpeg);
  }
  return { ok: true, jpegs };
}

export async function storeIdeaImages(tenant_id: string, jpegs: Buffer[]): Promise<string[]> {
  const urls: string[] = [];
  const paths: string[] = [];
  const bucket = tenantStorage(asTenantId(tenant_id)).from(CHAT_IMAGE_BUCKET);
  try {
    for (const jpeg of jpegs) {
      const stored = await storeNormalizedChatImage(tenant_id, jpeg);
      if (!stored.ok) throw new Error(stored.message);
      paths.push(stored.image_path);
      const { data, error } = await bucket.createSignedUrl(stored.image_path, IDEA_IMAGE_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) throw new Error(error?.message ?? "reference image URL was not created");
      urls.push(data.signedUrl);
    }
    return urls;
  } catch (error) {
    if (paths.length > 0) await bucket.remove(paths).catch(() => undefined);
    throw error;
  }
}
