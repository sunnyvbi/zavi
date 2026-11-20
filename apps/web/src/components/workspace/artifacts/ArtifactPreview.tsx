"use client";

import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Globe2,
  Presentation,
  Video,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { harden } from "../HtmlPreviewFrame";
import { artifactRenderMode, MAX_INLINE_BYTES, parseCsv } from "./artifactRender";
import { useArtifactContent } from "./useArtifactContent";
import type { Artifact } from "./types";

const SNIPPET_CHARS = 320;
const CSV_PREVIEW_BYTES = 48 * 1024;
const CSV_PREVIEW_ROWS = 4;
const CSV_PREVIEW_COLUMNS = 3;

export type PreviewFit = "cover" | "natural";

function frameClass(compact: boolean): string {
  return cn(
    "relative shrink-0 overflow-hidden bg-creamDeep",
    compact ? "h-16 w-24 rounded-lg" : "h-44 w-full rounded-t-xl",
  );
}

const RATIO_STORAGE_KEY = "zavi:artifact-ratios";
const MAX_REMEMBERED_RATIOS = 500;
const ratioCache = new Map<string, number>();
let ratiosRestored = false;

function restoreRatios(): void {
  if (ratiosRestored) return;
  ratiosRestored = true;
  try {
    const raw = window.localStorage.getItem(RATIO_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    for (const [id, ratio] of Object.entries(parsed)) {
      if (typeof ratio === "number" && ratio > 0) ratioCache.set(id, ratio);
    }
  } catch {
    ratioCache.clear();
  }
}

function rememberRatio(id: string, ratio: number): void {
  restoreRatios();
  ratioCache.delete(id);
  ratioCache.set(id, ratio);
  while (ratioCache.size > MAX_REMEMBERED_RATIOS) {
    const oldest = ratioCache.keys().next().value;
    if (oldest === undefined) break;
    ratioCache.delete(oldest);
  }
  try {
    window.localStorage.setItem(
      RATIO_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(ratioCache)),
    );
  } catch {
    return;
  }
}

export function knownAspectRatio(id: string): number | null {
  restoreRatios();
  return ratioCache.get(id) ?? null;
}

export function resetAspectRatiosForTests(): void {
  ratioCache.clear();
  ratiosRestored = false;
}

function useNearViewport<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, near };
}

export function ArtifactTypeIcon({ artifact, className = "h-10 w-10" }: { artifact: Artifact; className?: string }) {
  return <TypeIcon artifact={artifact} className={className} />;
}

function TypeIcon({ artifact, className = "h-10 w-10" }: { artifact: Artifact; className?: string }) {
  switch (artifact.type) {
    case "image":
      return <FileImage className={className} aria-hidden="true" />;
    case "video":
      return <Video className={className} aria-hidden="true" />;
    case "spreadsheet":
      return <FileSpreadsheet className={className} aria-hidden="true" />;
    case "presentation":
      return <Presentation className={className} aria-hidden="true" />;
    case "website":
      return <Globe2 className={className} aria-hidden="true" />;
    case "dashboard":
      return <BarChart3 className={className} aria-hidden="true" />;
    case "document":
      return <FileText className={className} aria-hidden="true" />;
    default:
      return <File className={className} aria-hidden="true" />;
  }
}

function IconBody({ artifact, compact }: { artifact: Artifact; compact: boolean }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center text-inkMuted">
      <TypeIcon artifact={artifact} />
      {!compact && <span className="line-clamp-2 text-base font-medium text-ink">{artifact.title}</span>}
    </div>
  );
}

function IconThumbnail({ artifact, compact }: { artifact: Artifact; compact: boolean }) {
  return (
    <div
      role="img"
      aria-label={`${artifact.title} ${artifact.type} preview`}
      className={frameClass(compact)}
    >
      <IconBody artifact={artifact} compact={compact} />
    </div>
  );
}

function HtmlThumbnail({
  artifact,
  compact,
  fill = false,
}: {
  artifact: Artifact;
  compact: boolean;
  fill?: boolean;
}) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const { text } = useArtifactContent(artifact, near);

  return (
    <div
      ref={ref}
      role="img"
      data-fit={fill ? "fill" : "cover"}
      aria-label={`${artifact.title} ${artifact.type} preview`}
      className={cn(fill ? "absolute inset-0 overflow-hidden" : frameClass(compact), "bg-white")}
    >
      {text === null ? (
        fill ? (
          <div data-pending="true" className="h-full w-full animate-pulse bg-bone" aria-hidden="true" />
        ) : (
          <IconBody artifact={artifact} compact={compact} />
        )
      ) : (
        <iframe
          srcDoc={harden(text)}
          title={`Preview of ${artifact.title}`}
          sandbox=""
          referrerPolicy="no-referrer"
          loading="lazy"
          tabIndex={-1}
          aria-hidden="true"
          style={{
            width: "400%",
            height: fill ? "400%" : compact ? 256 : 704,
            transform: "scale(0.25)",
            transformOrigin: "top left",
          }}
          className="pointer-events-none border-0 bg-white"
        />
      )}
    </div>
  );
}

function TextThumbnail({ artifact, compact }: { artifact: Artifact; compact: boolean }) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const { text } = useArtifactContent(artifact, near);
  const snippet = (text ?? "")
    .replace(/^---[\s\S]*?---\n/, "")
    .replace(/[#*_`>|]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, SNIPPET_CHARS);

  if (!snippet) {
    return (
      <div
        ref={ref}
        role="img"
        aria-label={`${artifact.title} ${artifact.type} preview`}
        className={frameClass(compact)}
      >
        <IconBody artifact={artifact} compact={compact} />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="img"
      aria-label={`${artifact.title} ${artifact.type} preview`}
      className={cn(frameClass(compact), "bg-white")}
    >
      <p
        className={cn(
          "whitespace-pre-wrap break-words p-3 text-left leading-snug text-inkMuted",
          compact ? "text-[7px]" : "text-[9px]",
        )}
      >
        {snippet}
      </p>
    </div>
  );
}

function CsvThumbnail({
  artifact,
  compact,
  fill,
}: {
  artifact: Artifact;
  compact: boolean;
  fill: boolean;
}) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const { text } = useArtifactContent(artifact, near, CSV_PREVIEW_BYTES);
  const rows = parseCsv(text ?? "", CSV_PREVIEW_ROWS + 1);
  const [header = [], ...body] = rows;
  const columns = header.slice(0, CSV_PREVIEW_COLUMNS);
  const frame = fill
    ? "h-full w-full rounded-lg"
    : frameClass(compact);

  return (
    <div
      ref={ref}
      role="img"
      data-preview="csv"
      aria-label={`${artifact.title} spreadsheet preview`}
      className={cn(frame, "relative overflow-hidden border border-emerald-700/15 bg-white")}
    >
      {columns.length === 0 ? (
        <div className="grid h-full grid-cols-3 gap-px bg-emerald-700/10 p-px" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <span
              key={index}
              className={cn(
                "bg-white",
                index < 3 && "animate-pulse bg-emerald-50 motion-reduce:animate-none",
              )}
            />
          ))}
        </div>
      ) : (
        <table className="h-full w-full table-fixed border-collapse text-left text-[7px] leading-[10px]" aria-hidden="true">
          <thead>
            <tr className="bg-emerald-50 text-emerald-950">
              {columns.map((cell, index) => (
                <th key={index} className="truncate border-b border-r border-emerald-700/15 px-1.5 py-1 font-semibold last:border-r-0">
                  {cell || `Column ${index + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, CSV_PREVIEW_ROWS).map((row, rowIndex) => (
              <tr key={rowIndex} className="even:bg-emerald-50/35">
                {columns.map((_, columnIndex) => (
                  <td key={columnIndex} className="truncate border-b border-r border-rule/70 px-1.5 py-1 text-inkMuted last:border-r-0">
                    {row[columnIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-white to-transparent" aria-hidden="true" />
    </div>
  );
}

const THUMB_REUSE_MS = 8 * 60 * 1000;
const thumbCache = new Map<string, { url: string; at: number }>();

export const THUMB_BATCH_WAIT_MS = 30;
export const THUMB_BATCH_MAX = 40;
type Waiter = (url: string | null) => void;
const thumbQueue = new Map<string, Waiter[]>();
let thumbFlush: ReturnType<typeof setTimeout> | null = null;

async function flushThumbnailQueue(): Promise<void> {
  thumbFlush = null;
  const batch = [...thumbQueue.entries()].slice(0, THUMB_BATCH_MAX);
  for (const [id] of batch) thumbQueue.delete(id);
  if (thumbQueue.size > 0) thumbFlush = setTimeout(() => void flushThumbnailQueue(), 0);
  const ids = batch.map(([id]) => id);
  let urls: Record<string, string | null> = {};
  try {
    const response = await apiFetch("/api/run-artifacts/thumbnails", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    if (response.ok) {
      const payload = (await response.json()) as { thumbnails?: Record<string, string | null> };
      urls = payload.thumbnails ?? {};
    }
  } catch {
    urls = {};
  }
  const now = Date.now();
  for (const [id, waiters] of batch) {
    const url = urls[id] ?? null;
    if (url) thumbCache.set(id, { url, at: now });
    for (const resolve of waiters) resolve(url);
  }
}

function fetchThumbnailUrl(id: string): Promise<string | null> {
  const hit = thumbCache.get(id);
  if (hit && Date.now() - hit.at < THUMB_REUSE_MS) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    thumbQueue.set(id, [...(thumbQueue.get(id) ?? []), resolve]);
    if (!thumbFlush) thumbFlush = setTimeout(() => void flushThumbnailQueue(), THUMB_BATCH_WAIT_MS);
  });
}

function useImageThumbnail(id: string, enabled: boolean): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(() => {
    const hit = thumbCache.get(id);
    return hit && Date.now() - hit.at < THUMB_REUSE_MS ? hit.url : undefined;
  });
  useEffect(() => {
    if (!enabled || url !== undefined) return;
    let cancelled = false;
    void fetchThumbnailUrl(id).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, id, url]);
  return url;
}

function MediaThumbnail({
  artifact,
  compact,
  mode,
  fit,
}: {
  artifact: Artifact;
  compact: boolean;
  mode: "image" | "video";
  fit: PreviewFit;
}) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const natural = fit === "natural" && !compact && mode === "image";
  const naturalVideo = fit === "natural" && !compact && mode === "video";
  const [ratio, setRatio] = useState<number | null>(() => knownAspectRatio(artifact.id));
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const withinCap = mode === "image" || artifact.bytes <= MAX_INLINE_BYTES;
  const canLoad =
    near &&
    withinCap &&
    !!artifact.preview_url &&
    failedUrl !== artifact.preview_url;
  const thumb = useImageThumbnail(artifact.id, canLoad && mode === "image");
  const [failedThumb, setFailedThumb] = useState<string | null>(null);
  const imageSrc =
    thumb && failedThumb !== thumb ? thumb : thumb === undefined ? null : artifact.preview_url;

  const frame = natural
    ? cn(
        "relative w-full overflow-hidden rounded-xl bg-creamDeep",
        ratio === null && "min-h-32",
      )
    : naturalVideo
      ? cn("relative w-full overflow-hidden rounded-xl bg-ink", ratio === null && "aspect-video")
      : cn(frameClass(compact), mode === "video" && "bg-ink");

  return (
    <div
      ref={ref}
      data-fit={natural || naturalVideo ? "natural" : "cover"}
      className={frame}
      style={(natural || naturalVideo) && ratio !== null ? { aspectRatio: String(ratio) } : undefined}
    >
      {!canLoad || (mode === "image" && !imageSrc) ? (
        natural && (thumb === undefined || !!artifact.preview_url) && failedUrl !== artifact.preview_url ? (
          <div
            data-pending="true"
            className={cn("h-full w-full animate-pulse bg-bone", ratio === null && "min-h-32")}
            aria-hidden="true"
          />
        ) : (
          <div className={natural ? "flex h-44 w-full" : "h-full w-full"}>
            <IconBody artifact={artifact} compact={compact} />
          </div>
        )
      ) : mode === "image" ? (
        <img
          src={imageSrc!}
          alt={`Preview of ${artifact.title}`}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            if (!natural) return;
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              const next = naturalWidth / naturalHeight;
              rememberRatio(artifact.id, next);
              setRatio(next);
            }
          }}
          onError={() => {
            if (imageSrc === thumb) {
              thumbCache.delete(artifact.id);
              setFailedThumb(thumb);
            } else setFailedUrl(imageSrc);
          }}
          className={natural ? "block h-auto w-full" : "h-full w-full object-cover"}
        />
      ) : (
        <video
          src={artifact.preview_url!}
          aria-label={`Preview of ${artifact.title}`}
          preload="metadata"
          playsInline
          muted
          onLoadedMetadata={(event) => {
            if (!naturalVideo) return;
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth > 0 && videoHeight > 0) {
              const next = videoWidth / videoHeight;
              rememberRatio(artifact.id, next);
              setRatio(next);
            }
          }}
          className={naturalVideo ? "absolute inset-0 h-full w-full object-cover" : "h-full w-full object-cover"}
        />
      )}
    </div>
  );
}

export function ArtifactPreview({
  artifact,
  compact = false,
  fit = "cover",
  fill = false,
}: {
  artifact: Artifact;
  compact?: boolean;
  fit?: PreviewFit;
  fill?: boolean;
}) {
  const mode = artifactRenderMode(artifact.mime, artifact.filename);

  if (mode === "image" || mode === "video") {
    return (
      <MediaThumbnail artifact={artifact} compact={compact} mode={mode} fit={fit} />
    );
  }

  if (mode === "html") {
    return <HtmlThumbnail artifact={artifact} compact={compact} fill={fit === "natural" && !compact} />;
  }
  if (mode === "csv") {
    return <CsvThumbnail artifact={artifact} compact={compact} fill={fill} />;
  }
  if (mode === "markdown" || mode === "text") {
    return <TextThumbnail artifact={artifact} compact={compact} />;
  }

  return <IconThumbnail artifact={artifact} compact={compact} />;
}
