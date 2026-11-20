import type { MediaRequest, RouteEntry } from "./types";

type Unit = "image" | "second" | "kchar";
type PriceRow = { usd: number; unit: Unit; verified: boolean; default_seconds?: number };

export const PRICES: Record<string, PriceRow> = {
  "fal:bytedance/seedream/v5/pro/text-to-image": { usd: 0.0675, unit: "image", verified: true },
  "fal:bytedance/seedream/v5/pro/edit": { usd: 0.0675, unit: "image", verified: true },
  "fal:openai/gpt-image-2.5/flare/text-to-image": { usd: 0.06, unit: "image", verified: true },
  "fal:openai/gpt-image-2.5/sunburst/text-to-image": { usd: 0.06, unit: "image", verified: true },
  "fal:openai/gpt-image-2.5/flare/edit": { usd: 0.08, unit: "image", verified: false },
  "fal:fal-ai/recraft/v4.1/text-to-vector": { usd: 0.08, unit: "image", verified: true },
  "fal:fal-ai/recraft/v4/text-to-vector": { usd: 0.08, unit: "image", verified: true },
  "fal:fal-ai/flux-2/klein/4b": { usd: 0.006, unit: "image", verified: true },
  "fal:bytedance/seedance-2.5/text-to-video": { usd: 0.473, unit: "second", verified: true, default_seconds: 8 },
  "fal:bytedance/seedance-2.5/image-to-video": { usd: 0.473, unit: "second", verified: true, default_seconds: 8 },
  "fal:bytedance/seedance-2.5/reference-to-video": { usd: 0.55, unit: "second", verified: false, default_seconds: 8 },
  "fal:bytedance/seedance-2.0/text-to-video": { usd: 0.3, unit: "second", verified: false, default_seconds: 8 },
  "fal:alibaba/wan-3.0/text-to-video": { usd: 0.1, unit: "second", verified: true, default_seconds: 5 },
  "fal:alibaba/wan-3.0/image-to-video": { usd: 0.1, unit: "second", verified: true, default_seconds: 5 },
  "fal:alibaba/wan-3.0/reference-to-video": { usd: 0.1, unit: "second", verified: true, default_seconds: 5 },
  "fal:google/gemini-omni-flash/v1.1/text-to-video": { usd: 0.1, unit: "second", verified: true, default_seconds: 8 },
  "fal:minimax/h3/image-to-video": { usd: 0.06, unit: "second", verified: true, default_seconds: 5 },
  "fal:fal-ai/bytedance/omnihuman/v1.5": { usd: 0.16, unit: "second", verified: true, default_seconds: 5 },
  "fal:fal-ai/kling-video/ai-avatar/v2/pro": { usd: 0.115, unit: "second", verified: true, default_seconds: 5 },
  "fal:fal-ai/kling-video/ai-avatar/v2/standard": { usd: 0.0562, unit: "second", verified: true, default_seconds: 5 },
  "fal:veed/fabric-1.0": { usd: 0.15, unit: "second", verified: true, default_seconds: 5 },
  "fal:elevenlabs/tts/eleven-v4": { usd: 0.08, unit: "kchar", verified: true },
  "fal:fal-ai/elevenlabs/tts/eleven-v3": { usd: 0.1, unit: "kchar", verified: true },
  "openai:gpt-image-2.5-flare": { usd: 0.06, unit: "image", verified: true },
  "openai:gpt-image-1-mini": { usd: 0.02, unit: "image", verified: false },
  "openai:gpt-4o-mini-tts": { usd: 0.012, unit: "kchar", verified: false },
  "gemini:gemini-3.1-flash-image-preview": { usd: 0.067, unit: "image", verified: true },
  "gemini:gemini-3-pro-image": { usd: 0.134, unit: "image", verified: false },
  "gemini:gemini-3.1-flash-lite-image-preview": { usd: 0.034, unit: "image", verified: false },
  "gemini:gemini-2.5-flash-preview-tts": { usd: 0.02, unit: "kchar", verified: false },
  "higgsfield:gpt_image_2_5": { usd: 0, unit: "image", verified: true },
};

export function priceUsd(entry: RouteEntry, req: MediaRequest, done: { duration_s?: number }): number {
  const row = PRICES[`${entry.vendor}:${entry.model}`];
  if (!row) throw new Error(`media-router: no price for ${entry.vendor}:${entry.model}`);
  if (row.unit === "image") return row.usd;
  if (row.unit === "kchar") return (row.usd * (req.text ?? "").length) / 1000;
  const secs = done.duration_s ?? req.duration_s ?? row.default_seconds ?? 0;
  return row.usd * secs;
}
