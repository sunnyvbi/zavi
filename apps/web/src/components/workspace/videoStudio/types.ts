export type VideoIntent = "talking_head" | "cinematic" | "social" | "animate";
export type VideoAspect = "9:16" | "1:1" | "4:5" | "16:9" | "auto";
export type PresenterGender = "male" | "female";

export type VideoDraft = {
  intent: VideoIntent;
  aspect_ratio: VideoAspect;
  visual: string;
  script: string | null;
  hook: string | null;
  alt_hooks?: string[];
  presenter_gender: PresenterGender | null;
  image_path?: string | null;
};

export type StudioMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  body: string;
  created_at: string;
  kind: string | null;
  draft_id?: string | null;
  draft: VideoDraft | null;
  render_run_id: string | null;
  run_id: string | null;
  image_path?: string | null;
};

export type RenderStatus = {
  status: "rendering" | "stalled" | "done" | "failed";
  started_at: string;
  videos: Array<{ artifact_id: string; filename: string | null }>;
  queued?: boolean;
  working_since?: string;
  code?: string | null;
};

export type StudioView = {
  thread_id: string | null;
  messages: StudioMessage[];
  renders: Record<string, RenderStatus>;
};

export const STUDIO_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const STUDIO_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const KIND_LABEL: Record<VideoIntent, string> = {
  talking_head: "AI presenter",
  cinematic: "Cinematic",
  social: "Social clip",
  animate: "Animated image",
};

export function kindLabel(intent: VideoIntent | null | undefined, fallback = "AI presenter"): string {
  return (intent && KIND_LABEL[intent]) || fallback;
}

export const STUDIO_PATH = "/api/channels/generated_video/studio";

export type StudioThread = { id: string; title: string; last_message_at: string };

export type GalleryVideo = {
  artifact_id: string;
  filename: string | null;
  created_at: string;
  source: "chat" | "card";
  thread_id: string | null;
  posted_on?: string[];
  posting_on?: string[];
  check_on?: string[];
  failed_on?: string[];
  intent?: VideoIntent | null;
};
