export const VIDEO_AD_FORMATS = [
  "in_stream_skippable",
  "in_stream_non_skippable",
  "bumper",
  "in_feed",
  "responsive",
] as const;

export type VideoAdFormat = (typeof VIDEO_AD_FORMATS)[number];

export const VIDEO_AD_GROUP_TYPES = [
  "VIDEO_TRUE_VIEW_IN_STREAM",
  "VIDEO_NON_SKIPPABLE_IN_STREAM",
  "VIDEO_BUMPER",
  "VIDEO_TRUE_VIEW_IN_DISPLAY",
  "VIDEO_RESPONSIVE",
  "VIDEO_EFFICIENT_REACH",
] as const;

export type VideoAdGroupType = (typeof VIDEO_AD_GROUP_TYPES)[number];

const FORMAT_TO_AD_GROUP_TYPE: Record<VideoAdFormat, VideoAdGroupType> = {
  in_stream_skippable: "VIDEO_TRUE_VIEW_IN_STREAM",
  in_stream_non_skippable: "VIDEO_NON_SKIPPABLE_IN_STREAM",
  bumper: "VIDEO_BUMPER",
  in_feed: "VIDEO_TRUE_VIEW_IN_DISPLAY",
  responsive: "VIDEO_RESPONSIVE",
};

const FORMAT_BID_UNIT: Record<VideoAdFormat, "cpv" | "cpm" | "none"> = {
  in_stream_skippable: "cpv",
  in_stream_non_skippable: "cpm",
  bumper: "cpm",
  in_feed: "cpv",
  responsive: "none",
};

export function adGroupTypeForVideoFormat(format: VideoAdFormat): VideoAdGroupType {
  return FORMAT_TO_AD_GROUP_TYPE[format];
}

export function bidUnitForVideoFormat(format: VideoAdFormat): "cpv" | "cpm" | "none" {
  return FORMAT_BID_UNIT[format];
}

export function isVideoAdGroupType(type: string): type is VideoAdGroupType {
  return (VIDEO_AD_GROUP_TYPES as readonly string[]).includes(type);
}

export function isYoutubeVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

const AD_GROUP_TYPE_TO_FORMAT: Partial<Record<VideoAdGroupType, VideoAdFormat>> = {
  VIDEO_TRUE_VIEW_IN_STREAM: "in_stream_skippable",
  VIDEO_NON_SKIPPABLE_IN_STREAM: "in_stream_non_skippable",
  VIDEO_BUMPER: "bumper",
  VIDEO_TRUE_VIEW_IN_DISPLAY: "in_feed",
  VIDEO_RESPONSIVE: "responsive",
};

export function videoFormatForAdGroupType(type: string): VideoAdFormat | null {
  return AD_GROUP_TYPE_TO_FORMAT[type as VideoAdGroupType] ?? null;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

const ID_BEARING_SEGMENTS = new Set(["shorts", "embed", "live", "v"]);

export function youtubeVideoIdFrom(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (isYoutubeVideoId(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const candidates: string[] = [];
  const v = url.searchParams.get("v");
  if (v) candidates.push(v);
  if (host === "youtu.be" && segments[0]) candidates.push(segments[0]);
  for (let i = 0; i < segments.length - 1; i++) {
    if (ID_BEARING_SEGMENTS.has(segments[i])) candidates.push(segments[i + 1]);
  }
  for (const candidate of candidates) {
    if (isYoutubeVideoId(candidate)) return candidate;
  }
  return null;
}
