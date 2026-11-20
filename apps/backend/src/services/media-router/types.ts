
export const MEDIA_TASKS = [
  "image.photo",
  "image.plate",
  "image.hero",
  "image.text",
  "image.edit",
  "image.vector",
  "image.draft",
  "video.broll",
  "video.cinematic",
  "video.social",
  "video.animate",
  "video.talking_head",
  "video.talking_head_long",
  "video.talking_head_standard",
  "video.edit",
  "audio.voiceover",
] as const;
export type MediaTask = (typeof MEDIA_TASKS)[number];

export type MediaVendor = "fal" | "openai" | "gemini" | "higgsfield";

export type RouteEntry = {
  vendor: MediaVendor;
  model: string;
  enabled: boolean;
};

export type MediaAspect = "1:1" | "4:5" | "9:16" | "16:9";

export type MediaRequest = {
  prompt?: string;
  text?: string;
  aspect_ratio?: MediaAspect;
  colors?: Array<{ r: number; g: number; b: number }>;
  reference_url?: string;
  image_url?: string;
  audio_url?: string;
  video_url?: string;
  duration_s?: number;
  voice?: string;
  voice_stability?: number;
  voice_timestamps?: boolean;
};

export type SpokenWord = [text: string, start: number, end: number];

export type MediaFailReason = "not_configured" | "refused" | "out_of_credits" | "vendor_error" | "timeout";

export type JobRef = {
  vendor: MediaVendor;
  model: string;
  id: string;
  status_url?: string;
  response_url?: string;
  cancel_url?: string;
  inline?: { url: string; mime: string };
};

export type SubmitResult = { ok: true; job: JobRef } | { ok: false; reason: MediaFailReason; error: string; http_status?: number };

export type PollResult =
  | { state: "pending" }
  | { state: "done"; url: string; mime?: string; duration_s?: number; words?: SpokenWord[] }
  | { state: "failed"; reason: MediaFailReason; error: string; http_status?: number };

export type MediaResult =
  | { ok: true; url: string; mime?: string; duration_s?: number; words?: SpokenWord[]; vendor: MediaVendor; model: string; cost_usd: number }
  | {
      ok: false;
      reason: MediaFailReason;
      error: string;
      vendor?: MediaVendor;
      model?: string;
      unbilled_at_submit?: boolean;
      http_status?: number;
    };
