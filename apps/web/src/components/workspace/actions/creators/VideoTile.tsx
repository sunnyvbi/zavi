"use client";

import { useState } from "react";
import { Clock, Lock, VideoOff } from "lucide-react";

export function VideoTile({
  url,
  caption,
  waiting = false,
  watermarked = false,
  label,
}: {
  url: string | null;
  caption: string;
  waiting?: boolean;
  watermarked?: boolean;
  label?: string;
}) {
  const name = label ?? caption;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = url !== null && failedUrl === url;
  if (url && !failed) {
    return (
      <div className="mx-auto w-fit max-w-full">
        <div className="relative overflow-hidden rounded-2xl bg-[#000] shadow-[0_8px_24px_rgba(0,0,0,0.25)] ring-1 ring-[rgba(255,255,255,0.06)]">
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            onError={() => setFailedUrl(url)}
            aria-label={watermarked ? `${name} · watermarked preview` : name}
            className="block aspect-[9/16] h-[min(56vh,520px)] w-auto max-w-full bg-[#000] object-contain"
          />
          {watermarked && (
            <span className="pointer-events-none absolute top-2.5 left-2.5 inline-flex items-center gap-1 rounded-full bg-[rgba(0,0,0,0.72)] px-2.5 py-1 text-[11px] font-semibold text-[#ffffff] backdrop-blur-sm">
              <Lock className="h-3 w-3" aria-hidden="true" />
              Watermarked preview
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      role="img"
      aria-label={name}
      data-testid="video-tile-empty"
      className="relative mx-auto flex aspect-[9/16] w-full max-w-[280px] items-center justify-center rounded-2xl bg-gradient-to-br from-[#2b2118] via-[#6b4b33] to-[#d9b38c]"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/40 text-white/80">
        {waiting ? (
          <Clock className="h-5 w-5 motion-safe:animate-pulse" aria-hidden="true" />
        ) : (
          <VideoOff className="h-5 w-5" aria-hidden="true" />
        )}
      </span>
      <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
        {failed ? "The video did not load. Reopen it to try again." : caption}
      </span>
    </div>
  );
}
