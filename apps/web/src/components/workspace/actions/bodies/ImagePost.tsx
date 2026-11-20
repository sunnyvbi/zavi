"use client";

import { Image as ImageIcon } from "lucide-react";
import { PostCard } from "../PostCard";
import { ImageFrame } from "../MediaFrame";
import { mediaOf, type ActionBodyProps } from "../types";

export function ImagePost(props: ActionBodyProps) {
  const m = mediaOf(props.action);
  const media =
    m && m.kind === "image" ? (
      <ImageFrame url={m.url} alt={m.alt} />
    ) : (
      <p data-testid="image-missing" className="text-[13px] text-inkMuted">
        No image attached. Post sends the text only.
      </p>
    );
  return <PostCard {...props} icon={ImageIcon} media={media} />;
}
