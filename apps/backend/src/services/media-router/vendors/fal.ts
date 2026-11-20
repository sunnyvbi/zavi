import type { JobRef, MediaFailReason, MediaRequest, PollResult, SubmitResult, SpokenWord } from "../types";
import { wordsFromCharTimings } from "../word-timings";

const QUEUE = "https://queue.fal.run";
const TIMEOUT_MS = 30_000;

function headers(key: string): Record<string, string> {
  return {
    Authorization: `Key ${key}`,
    "Content-Type": "application/json",
    "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: 3600 }),
    "X-Fal-Store-IO": "0",
  };
}

const IMAGE_SIZE: Record<string, string | { width: number; height: number }> = { "1:1": "square_hd", "4:5": { width: 1024, height: 1280 }, "9:16": "portrait_16_9", "16:9": "landscape_16_9" };
const PRESET_ONLY: Record<string, string> = { "1:1": "square_hd", "4:5": "portrait_4_3", "9:16": "portrait_16_9", "16:9": "landscape_16_9" };
const SEEDREAM_SIZE: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "4:5": { width: 1024, height: 1280 },
  "9:16": { width: 864, height: 1536 },
  "16:9": { width: 1536, height: 864 },
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const SEEDANCE_ASPECT: Record<string, string> = { "1:1": "1:1", "4:5": "3:4", "9:16": "9:16", "16:9": "16:9" };
const WAN_ASPECT: Record<string, string> = { "1:1": "1:1", "4:5": "3:4", "9:16": "9:16", "16:9": "16:9" };
const tallOrWide = (a?: string) => (a === "9:16" || a === "4:5" ? "9:16" : "16:9");

export const AVATAR_DELIVERY_PROMPT = "The presenter talks directly to the camera in a natural, friendly way, with subtle head movement and natural blinks.";

export function buildFalInput(model: string, req: MediaRequest): Record<string, unknown> {
  const size = IMAGE_SIZE[req.aspect_ratio ?? "1:1"] ?? "square_hd";
  if (model.startsWith("openai/gpt-image-2.5/")) {
    const base = { prompt: req.prompt, image_size: size, quality: "high", output_format: "png", num_images: 1 };
    return model.endsWith("/edit") ? { ...base, image_urls: [req.reference_url] } : base;
  }
  const preset = PRESET_ONLY[req.aspect_ratio ?? "1:1"] ?? "square_hd";
  if (model.startsWith("fal-ai/recraft/")) return { prompt: req.prompt, image_size: preset, ...(req.colors?.length ? { colors: req.colors } : {}) };
  if (model.startsWith("fal-ai/flux-2/")) return { prompt: req.prompt, image_size: preset };
  if (model.startsWith("google/gemini-omni-flash/")) {
    const base: Record<string, unknown> = { prompt: req.prompt, aspect_ratio: tallOrWide(req.aspect_ratio), duration: clamp(req.duration_s ?? 8, 4, 10), resolution: "720p" };
    return model.includes("image-to-video") ? { ...base, image_url: req.image_url } : base;
  }
  if (model.startsWith("fal-ai/kling-video/v3/")) {
    const a = req.aspect_ratio === "1:1" ? "1:1" : tallOrWide(req.aspect_ratio);
    return { prompt: req.prompt, aspect_ratio: a, duration: String(clamp(req.duration_s ?? 5, 3, 15)) };
  }
  if (model.startsWith("minimax/h3")) {
    const base: Record<string, unknown> = { prompt: req.prompt, prompt_expansion_mode: "balanced", duration: clamp(req.duration_s ?? 5, 5, 10), resolution: "768P" };
    return model.includes("image-to-video") ? { ...base, image_url: req.image_url } : base;
  }
  if (model === "fal-ai/bytedance/omnihuman/v1.5") return { image_url: req.image_url, audio_url: req.audio_url, resolution: "720p", prompt: AVATAR_DELIVERY_PROMPT };
  if (model === "fal-ai/kling-video/ai-avatar/v2/pro" || model === "fal-ai/kling-video/ai-avatar/v2/standard") return { image_url: req.image_url, audio_url: req.audio_url, prompt: AVATAR_DELIVERY_PROMPT };
  if (model === "veed/fabric-1.0") return { image_url: req.image_url, audio_url: req.audio_url, resolution: "720p" };
  if (model.includes("elevenlabs/tts/")) {
    const base: Record<string, unknown> = { text: req.text, voice: req.voice ?? "Brian" };
    if (req.voice_stability != null) base.stability = Math.max(0, Math.min(1, req.voice_stability));
    if (req.voice_timestamps) base.timestamps = true;
    return base;
  }
  if (model.startsWith("bytedance/seedream/v5/")) {
    const base = { prompt: req.prompt, image_size: SEEDREAM_SIZE[req.aspect_ratio ?? "1:1"] ?? SEEDREAM_SIZE["1:1"], output_format: "png", num_images: 1 };
    return model.endsWith("/edit") ? { ...base, image_urls: [req.reference_url] } : base;
  }
  if (model.startsWith("bytedance/seedance-2")) {
    const maxS = model.includes("seedance-2.5") ? 30 : 15;
    const base: Record<string, unknown> = { prompt: req.prompt, resolution: "720p", generate_audio: true, duration: String(clamp(req.duration_s ?? 8, 4, maxS)), aspect_ratio: SEEDANCE_ASPECT[req.aspect_ratio ?? "16:9"] };
    if (model.endsWith("/image-to-video")) return { ...base, aspect_ratio: "auto", image_url: req.image_url };
    if (model.endsWith("/reference-to-video")) {
      if (req.video_url) return { ...base, video_urls: [req.video_url], task: "editing" };
      return { ...base, prompt: req.prompt ?? "The person in the image speaks the words in the audio directly to camera, natural head movement.", image_urls: [req.image_url], audio_urls: [req.audio_url] };
    }
    return base;
  }
  if (model.startsWith("alibaba/wan-3.0/")) {
    const base: Record<string, unknown> = { prompt: req.prompt, resolution: "720p", aspect_ratio: WAN_ASPECT[req.aspect_ratio ?? "16:9"], duration: clamp(req.duration_s ?? 5, 2, 15), audio: true };
    if (model.endsWith("/image-to-video")) return { ...base, start_image_url: req.image_url };
    if (model.endsWith("/reference-to-video")) return { ...base, reference_video_urls: [req.video_url] };
    return base;
  }
  throw new Error(`fal: no input mapping for ${model}`);
}

export function classifyFalError(status: number, body: string): MediaFailReason {
  const b = (body || "").toLowerCase();
  if (b.includes("content_policy") || b.includes("nsfw")) return "refused";
  if (status === 402 || b.includes("balance") || b.includes("exhausted") || b.includes("insufficient") || b.includes("locked")) return "out_of_credits";
  if (status === 401 || status === 403) return "not_configured";
  return "vendor_error";
}

export async function falSubmit(model: string, req: MediaRequest): Promise<SubmitResult> {
  const key = (process.env.FAL_KEY || "").trim();
  if (!key) return { ok: false, reason: "not_configured", error: "FAL_KEY not set" };
  let input: Record<string, unknown>;
  try {
    input = buildFalInput(model, req);
  } catch (e) {
    return { ok: false, reason: "vendor_error", error: (e as Error).message };
  }
  try {
    const res = await fetch(`${QUEUE}/${model}`, { method: "POST", headers: headers(key), body: JSON.stringify(input), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: classifyFalError(res.status, text), error: `fal submit ${res.status}: ${text.slice(0, 200)}`, http_status: res.status };
    const j = JSON.parse(text) as { request_id?: string; status_url?: string; response_url?: string; cancel_url?: string };
    if (!j.request_id || !j.status_url || !j.response_url) return { ok: false, reason: "vendor_error", error: "fal submit: missing request_id/urls" };
    const job: JobRef = { vendor: "fal", model, id: j.request_id, status_url: j.status_url, response_url: j.response_url };
    if (j.cancel_url) job.cancel_url = j.cancel_url;
    return { ok: true, job };
  } catch (e) {
    return { ok: false, reason: "vendor_error", error: `fal submit: ${(e as Error).message}` };
  }
}

function extract(out: Record<string, unknown>): { url?: string; mime?: string; duration_s?: number; words?: SpokenWord[] } {
  const images = out.images as Array<{ url?: string; content_type?: string }> | undefined;
  const file = (images?.[0] ?? (out.video as { url?: string; content_type?: string } | undefined) ?? (out.audio as { url?: string; content_type?: string } | undefined)) || undefined;
  const duration = typeof out.duration === "number" ? out.duration : undefined;
  const words = out.timestamps === undefined ? [] : wordsFromCharTimings(out.timestamps);
  return { url: file?.url, mime: file?.content_type, duration_s: duration, ...(words.length ? { words } : {}) };
}

const FAL_HOST = "https://queue.fal.run/";

export async function falPollOnce(job: JobRef): Promise<PollResult> {
  const key = (process.env.FAL_KEY || "").trim();
  if (!key) return { state: "failed", reason: "not_configured", error: "FAL_KEY not set" };
  if (!job.status_url?.startsWith(FAL_HOST) || !job.response_url?.startsWith(FAL_HOST)) {
    return { state: "failed", reason: "vendor_error", error: "fal job urls are not on queue.fal.run" };
  }
  try {
    const s = await fetch(job.status_url, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!s.ok) {
      if (s.status >= 500 || s.status === 429) return { state: "pending" };
      const t = await s.text();
      return { state: "failed", reason: classifyFalError(s.status, t), error: `fal status ${s.status}: ${t.slice(0, 200)}`, http_status: s.status };
    }
    const st = (await s.json()) as { status?: string; error?: unknown; error_type?: unknown };
    if (st.status === "IN_QUEUE" || st.status === "IN_PROGRESS") return { state: "pending" };
    if (st.status !== "COMPLETED") {
      return { state: "failed", reason: "vendor_error", error: `fal status ${String(st.status ?? "missing").slice(0, 40)}` };
    }
    if (st.error != null || st.error_type != null) {
      const detail = `${String(st.error_type ?? "")} ${typeof st.error === "string" ? st.error : JSON.stringify(st.error ?? "")}`.trim();
      return { state: "failed", reason: classifyFalError(200, detail), error: `fal completed with error: ${detail.slice(0, 200)}` };
    }
    const r = await fetch(job.response_url, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await r.text();
    if (r.status >= 500 || r.status === 429) return { state: "pending" };
    if (!r.ok) return { state: "failed", reason: classifyFalError(r.status, text), error: `fal result ${r.status}: ${text.slice(0, 200)}`, http_status: r.status };
    const x = extract(JSON.parse(text) as Record<string, unknown>);
    if (!x.url) return { state: "failed", reason: "vendor_error", error: "fal result: no output url" };
    return { state: "done", url: x.url, mime: x.mime, duration_s: x.duration_s, ...(x.words ? { words: x.words } : {}) };
  } catch {
    return { state: "pending" };
  }
}

export type CancelOutcome = "requested" | "too_late" | "not_found" | "error";

export async function falCancel(job: JobRef): Promise<CancelOutcome> {
  const key = (process.env.FAL_KEY || "").trim();
  if (!key) return "error";
  const status = job.status_url ?? "";
  const url = job.cancel_url ?? (/\/status$/.test(status) ? status.replace(/\/status$/, "/cancel") : "");
  if (!url.startsWith(FAL_HOST) || !/\/cancel$/.test(url)) return "error";
  try {
    const r = await fetch(url, { method: "PUT", headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await r.text().catch(() => "")).toUpperCase();
    if (r.status === 202 || (r.ok && body.includes("CANCELLATION_REQUESTED"))) return "requested";
    if (body.includes("ALREADY_COMPLETED")) return "too_late";
    if (r.status === 404 || body.includes("NOT_FOUND")) return "not_found";
    return "error";
  } catch {
    return "error";
  }
}
