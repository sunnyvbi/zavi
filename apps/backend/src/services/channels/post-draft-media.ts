import { renderPostArtwork } from "./post-draft-artwork";
import { z } from "zod";
import type { PostDraftContent } from "@zavi/shared";
import { asTenantId, tenantStorage } from "@/services/tenant-client";
import { safeFetchImage } from "@/services/media-router/vendors/safe-fetch";
import { storeNormalizedChatImage } from "@/services/chat-images/store-chat-image";

const mediaBody = z.object({ media: z.object({ kind: z.literal("image"), url: z.string().url() }).optional() }).passthrough();
export async function renderPostDraftImage(tenantId: string, content: PostDraftContent, originalBody: unknown): Promise<string | null> {
  if (!content.image_path && !content.size && !content.headline) return null;
  let source: Buffer;
  if (content.image_path) {
    if (!content.image_path.startsWith(`${tenantId}/`) || !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/.test(content.image_path)) throw new Error("Choose an image from this workspace.");
    if (!content.size && !content.headline) return content.image_path;
    const stored = await tenantStorage(asTenantId(tenantId)).from("agent-chat-images").download(content.image_path);
    if (stored.error || !stored.data || stored.data.size > 10 * 1024 * 1024) throw new Error("The selected image could not be read.");
    source = Buffer.from(await stored.data.arrayBuffer());
  } else {
    const parsed = mediaBody.safeParse(originalBody);
    if (!parsed.success || !parsed.data.media) throw new Error("Choose a photo before changing its size or headline.");
    const fetched = await safeFetchImage(parsed.data.media.url);
    if (!fetched) throw new Error("The original photo could not be read. Upload it to continue.");
    source = fetched.bytes;
  }
  const saved = await storeNormalizedChatImage(tenantId, await renderPostArtwork(source, content));
  if (!saved.ok) throw new Error("The edited photo could not be saved.");
  return saved.image_path;
}
