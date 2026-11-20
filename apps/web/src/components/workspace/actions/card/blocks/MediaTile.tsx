"use client";

import { useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { MediaExpand } from "./MediaExpand";

export function MediaTile({ url, alt, video = false, overlay }: { url: string; alt: string; video?: boolean; overlay?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  return (
    <span className="group/media relative block aspect-ad-feed w-ca-media shrink-0 overflow-hidden rounded-lg bg-ca-subtle">
      {!failed && (video
        ? <video src={url} controls={playing} autoPlay={playing} playsInline preload="metadata" aria-label={alt || "Video"} onError={() => setFailed(true)} className="size-full object-cover" />
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={url} alt={alt} onError={() => setFailed(true)} className="size-full object-cover" />)}
      {video && !playing && !failed && (
        <button type="button" aria-label="Play video" onClick={() => setPlaying(true)} className="absolute left-1/2 top-1/2 inline-flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70 focus-visible:shadow-ca-focus focus-visible:outline-none">
          <Play className="size-4" aria-hidden />
        </button>
      )}
      {failed && <span data-testid="media-missing" className="absolute inset-0 grid place-items-center p-3 text-center text-ca-action text-ca-secondary">This {video ? "video" : "image"} could not be loaded.</span>}
      {!playing && overlay}
      {!failed && !playing && <MediaExpand url={url} alt={alt} video={video} cover={!video} />}
    </span>
  );
}

export function WithMedia({ media, children }: { media: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-5 compact:flex-col">
      {media}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
