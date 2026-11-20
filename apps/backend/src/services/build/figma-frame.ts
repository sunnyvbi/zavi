import { parseFigmaFrameRef, type FigmaFrameRef } from "@zavi/shared";
import { figmaGet } from "@/services/tools/figma/_client";
import { ExpectedToolError } from "@/services/tools/types";
import { safeFetchImage } from "@/services/media-router/vendors/safe-fetch";
import { normalizeChatImage } from "@/services/chat-images/store-chat-image";

export const FIGMA_FRAME_DEADLINE_MS = 15_000;

export type FigmaFrameFailure =
  | "figma_link_invalid"
  | "figma_not_connected"
  | "figma_key_rejected"
  | "figma_not_found"
  | "figma_rate_limited"
  | "figma_timeout"
  | "figma_image_unavailable"
  | "figma_failed";

export type FigmaFrameResult =
  | { ok: true; jpeg: Buffer }
  | { ok: false; code: FigmaFrameFailure; note: string };

export type FigmaFrameDeps = {
  figmaGet: typeof figmaGet;
  fetchImage: typeof safeFetchImage;
  normalize: typeof normalizeChatImage;
  deadlineMs: number;
};

const DEFAULT_DEPS: FigmaFrameDeps = {
  figmaGet,
  fetchImage: safeFetchImage,
  normalize: normalizeChatImage,
  deadlineMs: FIGMA_FRAME_DEADLINE_MS,
};

const NOTES: Record<FigmaFrameFailure, string> = {
  figma_link_invalid: "That Figma link could not be read. Fix the link and try starting the build again.",
  figma_not_connected: "Figma is not connected. Connect Figma in Connectors, then try starting the build again.",
  figma_key_rejected: "Figma refused access to that frame. Reconnect Figma or check that the file is shared with you, then try again.",
  figma_not_found: "Figma could not find that frame. Check that the link points to a frame, then try again.",
  figma_rate_limited: "Figma is busy right now. Try starting the build again in a moment.",
  figma_timeout: "Figma took too long to export the frame. Try starting the build again.",
  figma_image_unavailable: "The Figma frame was too big or could not be downloaded. Fix the frame or link, then try again.",
  figma_failed: "The Figma frame could not be exported. Try starting the build again.",
};

const TOOL_CODES: Record<string, FigmaFrameFailure> = {
  figma_not_connected: "figma_not_connected",
  figma_key_rejected: "figma_key_rejected",
  figma_not_found: "figma_not_found",
  figma_rate_limited: "figma_rate_limited",
  figma_unreachable: "figma_timeout",
};

class FigmaDeadline extends Error {}

function fail(tenant_id: string, code: FigmaFrameFailure): FigmaFrameResult {
  console.warn("build_figma_frame_failed", { tenant_id, code });
  return { ok: false, code, note: NOTES[code] };
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FigmaDeadline()), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function imageUrlFor(body: unknown, node_id: string): string | null {
  if (!body || typeof body !== "object") return null;
  const images = (body as { images?: unknown }).images;
  if (!images || typeof images !== "object") return null;
  const url = (images as Record<string, unknown>)[node_id];
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

export async function exportFigmaFrame(
  tenant_id: string,
  raw: unknown,
  deps: Partial<FigmaFrameDeps> = {},
): Promise<FigmaFrameResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const ref: FigmaFrameRef | null = parseFigmaFrameRef(raw);
  if (!ref) return fail(tenant_id, "figma_link_invalid");
  const path = `/v1/images/${encodeURIComponent(ref.file_key)}?ids=${encodeURIComponent(ref.node_id)}&format=png&scale=2`;
  try {
    return await withDeadline(
      (async (): Promise<FigmaFrameResult> => {
        const body = await d.figmaGet(tenant_id, path);
        const url = imageUrlFor(body, ref.node_id);
        if (!url) return fail(tenant_id, "figma_not_found");
        const image = await d.fetchImage(url);
        if (!image) return fail(tenant_id, "figma_image_unavailable");
        const normalized = await d.normalize(image.bytes);
        if (!normalized.ok) return fail(tenant_id, "figma_image_unavailable");
        return { ok: true, jpeg: normalized.jpeg };
      })(),
      d.deadlineMs,
    );
  } catch (e) {
    if (e instanceof FigmaDeadline) return fail(tenant_id, "figma_timeout");
    if (e instanceof ExpectedToolError) return fail(tenant_id, TOOL_CODES[e.code] ?? "figma_failed");
    return fail(tenant_id, "figma_failed");
  }
}
