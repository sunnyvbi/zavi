"use client";

import { Video } from "lucide-react";
import { ActionCard } from "../ActionCard";
import { PostCard } from "../PostCard";
import { MediaMissing, VideoFrame } from "../MediaFrame";
import { mediaOf, type ActionBodyProps } from "../types";

export function VideoPost(props: ActionBodyProps) {
  if (props.action.executable) return <ActionCard {...props} kindLabel="Video" />;
  const m = mediaOf(props.action);
  const media =
    m && m.kind === "video" ? (
      <VideoFrame url={m.url} downloadUrl={m.downloadUrl} />
    ) : (
      <MediaMissing>No video yet. Film it from the script above, or ask Zavi to make one.</MediaMissing>
    );
  return <PostCard {...props} icon={Video} media={media} />;
}
