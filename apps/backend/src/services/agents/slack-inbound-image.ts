
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { downloadSlackFileBytes } from "@/services/tools/slack/_client";

const MAX_INBOUND_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SUPPORTED_MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

export type SlackImageRef = {
  url: string;
  mimetype: string;
  name?: string;
  size?: number;
};

export function normalizeSlackImageRefs(raw: unknown): SlackImageRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SlackImageRef[] = [];
  for (const r of raw) {
    if (out.length >= MAX_INBOUND_IMAGES) break;
    if (!r || typeof r !== "object") continue;
    const url = (r as { url?: unknown }).url;
    const mimetype = (r as { mimetype?: unknown }).mimetype;
    if (typeof url !== "string" || url.length === 0) continue;
    if (typeof mimetype !== "string") continue;
    out.push({
      url,
      mimetype,
      name: typeof (r as { name?: unknown }).name === "string" ? (r as { name: string }).name : undefined,
      size: typeof (r as { size?: unknown }).size === "number" ? (r as { size: number }).size : undefined,
    });
  }
  return out;
}

export async function resolveSlackImageContent(
  tenant_id: string,
  team_id: string | undefined,
  rawImages: unknown,
  intentText: string,
): Promise<MessageParam["content"] | null> {
  const refs = normalizeSlackImageRefs(rawImages);
  if (refs.length === 0) return null;

  const imageBlocks: any[] = [];
  const failureMarkers: Array<{ type: "text"; text: string }> = [];

  for (const ref of refs) {
    const name = ref.name ?? "image";
    const mediaType = SUPPORTED_MEDIA_TYPES[ref.mimetype.toLowerCase()];
    if (!mediaType) {
      failureMarkers.push({ type: "text", text: `[image ${name} (${ref.mimetype}) is an unsupported format]` });
      continue;
    }
    if (typeof ref.size === "number" && ref.size > MAX_IMAGE_BYTES) {
      failureMarkers.push({ type: "text", text: `[image ${name} is too large to load]` });
      continue;
    }
    try {
      const buf = await downloadSlackFileBytes(tenant_id, ref.url, team_id);
      if (buf) {
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: buf.toString("base64") },
        });
      } else {
        failureMarkers.push({ type: "text", text: `[image ${name} could not be loaded]` });
      }
    } catch (e) {
      console.warn(
        `[slack-inbound-image] download failed for an inbound Slack image (tenant ${tenant_id}): ${(e as Error).message}`,
      );
      failureMarkers.push({ type: "text", text: `[image ${name} could not be loaded]` });
    }
  }

  if (imageBlocks.length === 0 && failureMarkers.length === 0) return null;

  const content = [
    ...imageBlocks,
    ...failureMarkers,
    { type: "text" as const, text: intentText },
  ];
  return content as MessageParam["content"];
}
