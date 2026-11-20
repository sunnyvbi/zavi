import type { MediaTask, RouteEntry } from "./types";

const fal = (model: string): RouteEntry => ({ vendor: "fal", model, enabled: true });
const openai = (model: string): RouteEntry => ({ vendor: "openai", model, enabled: true });
const gemini = (model: string): RouteEntry => ({ vendor: "gemini", model, enabled: true });
const HIGGSFIELD_OFF: RouteEntry = { vendor: "higgsfield", model: "gpt_image_2_5", enabled: false };

const GEMINI_PRO_IMAGE = "gemini-3-pro-image";
const SEEDREAM = "bytedance/seedream/v5/pro/text-to-image";
const SEEDANCE_T2V = "bytedance/seedance-2.5/text-to-video";
const KLING_AVATAR_PRO = "fal-ai/kling-video/ai-avatar/v2/pro";
const KLING_AVATAR_STANDARD = "fal-ai/kling-video/ai-avatar/v2/standard";
export const ROUTES: Record<MediaTask, RouteEntry[]> = {
  "image.photo": [fal(SEEDREAM), openai("gpt-image-2.5-flare"), gemini(GEMINI_PRO_IMAGE), HIGGSFIELD_OFF],
  "image.plate": [fal(SEEDREAM), openai("gpt-image-2.5-flare"), gemini("gemini-3.1-flash-image-preview"), HIGGSFIELD_OFF],
  "image.hero": [fal(SEEDREAM), openai("gpt-image-2.5-flare"), gemini(GEMINI_PRO_IMAGE), HIGGSFIELD_OFF],
  "image.text": [fal("openai/gpt-image-2.5/sunburst/text-to-image"), fal(SEEDREAM), gemini(GEMINI_PRO_IMAGE)],
  "image.edit": [fal("openai/gpt-image-2.5/flare/edit"), fal("bytedance/seedream/v5/pro/edit"), gemini(GEMINI_PRO_IMAGE)],
  "image.vector": [fal("fal-ai/recraft/v4.1/text-to-vector"), fal("fal-ai/recraft/v4/text-to-vector")],
  "image.draft": [fal("fal-ai/flux-2/klein/4b"), gemini("gemini-3.1-flash-lite-image-preview"), openai("gpt-image-1-mini")],
  "video.broll": [fal(SEEDANCE_T2V), fal("alibaba/wan-3.0/text-to-video"), fal("google/gemini-omni-flash/v1.1/text-to-video")],
  "video.cinematic": [fal(SEEDANCE_T2V), fal("bytedance/seedance-2.0/text-to-video"), fal("alibaba/wan-3.0/text-to-video")],
  "video.social": [fal(SEEDANCE_T2V), fal("alibaba/wan-3.0/text-to-video"), fal("google/gemini-omni-flash/v1.1/text-to-video")],
  "video.animate": [fal("bytedance/seedance-2.5/image-to-video"), fal("alibaba/wan-3.0/image-to-video"), fal("minimax/h3/image-to-video")],
  "video.talking_head": [fal(KLING_AVATAR_PRO), fal("fal-ai/bytedance/omnihuman/v1.5")],
  "video.talking_head_long": [fal(KLING_AVATAR_PRO), fal("fal-ai/bytedance/omnihuman/v1.5"), fal("veed/fabric-1.0")],
  "video.talking_head_standard": [fal(KLING_AVATAR_STANDARD), fal(KLING_AVATAR_PRO)],
  "video.edit": [fal("alibaba/wan-3.0/reference-to-video"), fal("bytedance/seedance-2.5/reference-to-video")],
  "audio.voiceover": [fal("elevenlabs/tts/eleven-v4"), fal("fal-ai/elevenlabs/tts/eleven-v3"), gemini("gemini-2.5-flash-preview-tts"), openai("gpt-4o-mini-tts")],
};

export function activeRoute(task: MediaTask): RouteEntry {
  const e = ROUTES[task].find((r) => r.enabled);
  if (!e) throw new Error(`media-router: no enabled route for ${task}`);
  return e;
}
