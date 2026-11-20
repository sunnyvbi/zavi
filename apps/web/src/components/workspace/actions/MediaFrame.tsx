"use client";

import { useState } from "react";
import { Download } from "lucide-react";

const FRAME = "rounded-lg border border-rule";

export function MediaMissing({ children }: { children: React.ReactNode }) {
  return (
    <p
      data-testid="media-missing"
      className={`${FRAME} border-dashed px-4 py-6 text-center text-[16px] text-inkMuted`}
    >
      {children}
    </p>
  );
}

export function ImageFrame({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaMissing>That image could not be loaded. Add your own, or ask Zavi to make one.</MediaMissing>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote, run-generated media; next/image needs a configured host
    <img
      src={url}
      alt={alt}
      onError={() => setFailed(true)}
      className={`${FRAME} max-h-80 w-full object-cover`}
    />
  );
}

export function VideoFrame({
  url,
  poster,
  downloadUrl,
}: {
  url: string;
  poster?: string;
  downloadUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaMissing>That video could not be loaded. Add your own, or ask Zavi to make one.</MediaMissing>;
  const video = (
    <video
      src={url}
      poster={poster}
      controls
      playsInline
      onError={() => setFailed(true)}
      className="block max-h-[480px] max-w-full rounded-xl bg-black object-contain"
    />
  );
  if (!downloadUrl) return <div className="flex justify-center overflow-hidden rounded-xl bg-black">{video}</div>;
  return (
    <div className="space-y-2.5">
      <div className="mx-auto w-fit max-w-full overflow-hidden rounded-2xl bg-black shadow-lg ring-1 ring-black/20">
        {video}
      </div>
      {downloadUrl && (
        <div className="flex justify-center">
          <a
            href={downloadUrl}
            download
            data-testid="video-download"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-rule bg-cream px-3.5 text-[14px] font-semibold text-ink hover:bg-bone"
          >
            <Download aria-hidden className="h-4 w-4" />
            Download video
          </a>
        </div>
      )}
    </div>
  );
}
