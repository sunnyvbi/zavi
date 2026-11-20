
import { ExpectedToolError } from "@/services/tools/types";

type ShapedRequest = { path: string; params: Record<string, string> };

export const LIBRARY_AD_STATUS = "PAUSED" as const;

const CREATIVE_NAME_MAX = 100;
const VIDEO_TITLE_MAX = 255;

function requireNonEmpty(value: string | undefined | null, field: string, code: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new ExpectedToolError(code, `${field} is required`);
  return v;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

export function shapeUploadLibraryVideoRequest(input: {
  ad_account_id: string;
  file_url: string;
  name: string;
}): ShapedRequest {
  const account = requireNonEmpty(input.ad_account_id, "ad_account_id", "meta_ads_invalid_target");
  const url = requireNonEmpty(input.file_url, "file_url", "meta_ads_invalid_video_url");
  if (!/^https:\/\//i.test(url)) {
    throw new ExpectedToolError(
      "meta_ads_invalid_video_url",
      "the video URL handed to Meta must be https",
    );
  }
  const name = clamp(requireNonEmpty(input.name, "name", "meta_ads_invalid_name"), VIDEO_TITLE_MAX);
  return {
    path: `${account}/advideos`,
    params: { file_url: url, name, title: name },
  };
}

export function shapeLibraryAdCreativeRequest(input: {
  ad_account_id: string;
  page_id: string;
  video_id: string;
  thumbnail_url: string;
  name: string;
  message?: string;
  tracking_tag?: string;
}): ShapedRequest {
  const account = requireNonEmpty(input.ad_account_id, "ad_account_id", "meta_ads_invalid_target");
  const page_id = requireNonEmpty(input.page_id, "page_id", "meta_ads_page_required");
  const video_id = requireNonEmpty(input.video_id, "video_id", "meta_ads_invalid_target");
  const image_url = requireNonEmpty(
    input.thumbnail_url,
    "thumbnail_url",
    "meta_ads_video_thumbnail_missing",
  );
  const name = clamp(requireNonEmpty(input.name, "name", "meta_ads_invalid_name"), CREATIVE_NAME_MAX);

  const video_data: Record<string, unknown> = { video_id, image_url };
  const message = (input.message ?? "").trim();
  if (message) video_data.message = message;

  const params: Record<string, string> = {
    name,
    object_story_spec: JSON.stringify({ page_id, video_data }),
  };
  const tag = (input.tracking_tag ?? "").trim();
  if (tag) params.url_tags = `utm_campaign=${encodeURIComponent(tag)}&utm_source=zavi_creator`;

  return { path: `${account}/adcreatives`, params };
}

export function boostObjectStoryId(page_id: string, post_id: string): string {
  const page = requireNonEmpty(page_id, "page_id", "meta_ads_page_required");
  const post = requireNonEmpty(post_id, "post_id", "meta_ads_invalid_post");
  if (!/^[0-9]+$/.test(page) || !/^[0-9]+(_[0-9]+)?$/.test(post)) {
    throw new ExpectedToolError("meta_ads_invalid_post", "post_id and page_id must be Meta ids");
  }
  if (!post.includes("_")) return `${page}_${post}`;
  if (!post.startsWith(`${page}_`)) {
    throw new ExpectedToolError("meta_ads_post_not_on_page", "That post is not on the Page you picked.");
  }
  return post;
}

export function shapeBoostPostCreativeRequest(input: {
  ad_account_id: string;
  page_id: string;
  post_id: string;
  name: string;
}): ShapedRequest {
  const account = requireNonEmpty(input.ad_account_id, "ad_account_id", "meta_ads_invalid_target");
  const name = clamp(requireNonEmpty(input.name, "name", "meta_ads_invalid_name"), CREATIVE_NAME_MAX);
  return {
    path: `${account}/adcreatives`,
    params: { name, object_story_id: boostObjectStoryId(input.page_id, input.post_id) },
  };
}

export function shapeLibraryAdRequest(input: {
  ad_account_id: string;
  ad_set_id: string;
  creative_id: string;
  name: string;
}): ShapedRequest {
  const account = requireNonEmpty(input.ad_account_id, "ad_account_id", "meta_ads_invalid_target");
  const adset_id = requireNonEmpty(input.ad_set_id, "ad_set_id", "meta_ads_ad_set_required");
  const creative_id = requireNonEmpty(input.creative_id, "creative_id", "meta_ads_invalid_target");
  const name = clamp(requireNonEmpty(input.name, "name", "meta_ads_invalid_name"), CREATIVE_NAME_MAX);

  return {
    path: `${account}/ads`,
    params: {
      name,
      adset_id,
      creative: JSON.stringify({ creative_id }),
      status: LIBRARY_AD_STATUS,
    },
  };
}

export type VideoProcessingState = "ready" | "processing" | "error" | "unknown";

export function readVideoProcessingState(node: unknown): VideoProcessingState {
  if (!node || typeof node !== "object") return "unknown";
  const status = (node as { status?: unknown }).status;
  if (!status || typeof status !== "object") return "unknown";
  const v = (status as { video_status?: unknown }).video_status;
  if (v === "ready" || v === "processing" || v === "error") return v;
  return "unknown";
}

export function pickThumbnailUri(body: unknown): string | null {
  const data = (body as { data?: Array<{ uri?: string; is_preferred?: boolean }> } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const preferred = data.find((t) => t.is_preferred === true && typeof t.uri === "string" && t.uri);
  if (preferred?.uri) return preferred.uri;
  const first = data.find((t) => typeof t.uri === "string" && t.uri);
  return first?.uri ?? null;
}
