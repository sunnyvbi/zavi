"use client";

import { MediaMissing, VideoFrame } from "./MediaFrame";
import { usePostVideoSource } from "./usePostVideoSource";

export function PostVideo({ source }: { source: string }) {
  const video = usePostVideoSource(source);
  if (video.error) return <MediaMissing>{video.error}</MediaMissing>;
  return video.url ? <VideoFrame key={video.url} url={video.url} /> : <p role="status" className="p-5 text-sm text-inkMuted">Loading video…</p>;
}
