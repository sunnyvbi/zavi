import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadAsImageBlock } from "@/services/agents/chat-history";
import { ownChatImagePaths } from "@/services/workspace-files/site-photos";

export const MAX_REFINE_IMAGES = 3;
export const MAX_REFINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_REFINE_IMAGE_BYTES * 4) / 3);

export type RefineImagePaths = { ok: true; paths: string[] } | { ok: false; message: string };

export function parseRefineImagePaths(tenantId: string, raw: unknown): RefineImagePaths {
  if (raw === undefined || raw === null) return { ok: true, paths: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "image_paths must be a list of uploaded images" };
  if (raw.length > MAX_REFINE_IMAGES) return { ok: false, message: `attach at most ${MAX_REFINE_IMAGES} images to a change` };
  const unique = new Set(raw.map((p) => (typeof p === "string" ? p.toLowerCase() : p)));
  const paths = ownChatImagePaths(tenantId, raw);
  if (paths.length !== unique.size) {
    return { ok: false, message: "each image must be a png, jpeg or webp uploaded to this workspace" };
  }
  return { ok: true, paths };
}

export function refineRequestImagePaths(tenantId: string, payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as { refine_mode?: unknown; request_image_paths?: unknown };
  if (p.refine_mode !== true) return [];
  return ownChatImagePaths(tenantId, p.request_image_paths).slice(0, MAX_REFINE_IMAGES);
}

function attachedNote(shown: number, missing: number): string {
  const lines: string[] = [];
  if (shown > 0) {
    lines.push(
      `[The founder attached ${shown === 1 ? "the image above" : `the ${shown} images above`} to this change, usually a screenshot of their site or a look to match: find the part of the site it shows and change that.]`,
    );
  }
  if (missing > 0) {
    lines.push(`[${missing === 1 ? "One attached image" : `${missing} attached images`} could not be loaded.]`);
  }
  return lines.join("\n");
}

export async function resolveRefineRequestImages(
  sb: SupabaseClient,
  tenantId: string,
  payload: unknown,
  intentText: string,
): Promise<MessageParam["content"] | null> {
  const paths = refineRequestImagePaths(tenantId, payload);
  if (paths.length === 0) return null;
  const images: Array<Awaited<ReturnType<typeof downloadAsImageBlock>>> = [];
  let missing = 0;
  for (const path of paths) {
    const block = await downloadAsImageBlock(sb, path);
    const data = block?.source.type === "base64" ? block.source.data : "";
    if (!block || data.length === 0 || data.length > MAX_IMAGE_BASE64_CHARS) missing++;
    else images.push(block);
  }
  return [
    ...images,
    { type: "text" as const, text: attachedNote(images.length, missing) },
    { type: "text" as const, text: intentText },
  ] as MessageParam["content"];
}
