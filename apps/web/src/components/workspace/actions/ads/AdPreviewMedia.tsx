"use client";

import { useState } from "react";
import Image from "next/image";
import { ImageOff, Sparkles } from "lucide-react";
import type { AdReviewCreative } from "@zavi/shared";
import { cn } from "@/lib/cn";
import type { AdPreviewFormat } from "./adReviewModel";
import { useAdImagePreview } from "./useAdImagePreview";
import { useArtifactImagePreview } from "./useArtifactImagePreview";
import { Skeleton } from "@/components/ui/Skeleton";

export function AdPreviewMedia({ creative, format, aiGenerated, imageShape }: { creative: AdReviewCreative; format: AdPreviewFormat; aiGenerated?: boolean; imageShape?: "linkedin" | "reddit" | "x" }) {
  const [failed, setFailed] = useState(false);
  const image = useAdImagePreview(creative.image_url ?? creative.image_path ?? null);
  const artifact = useArtifactImagePreview(creative.image_url || creative.image_path ? null : creative.image_artifact_id);
  const imageSource = image.src ?? artifact.src ?? creative.image_url ?? null;
  const vertical = format === "vertical";
  if (failed || image.failed || artifact.failed) return <p role="status" className="flex items-center justify-center gap-2 border-y border-rule bg-creamDeep p-6 text-sm text-inkMuted"><ImageOff className="size-4 shrink-0" aria-hidden />This media could not be loaded.</p>;
  if (image.loading || artifact.loading) return <div role="status" aria-label="Loading ad image"><Skeleton className="aspect-ad-feed w-full rounded-none" /></div>;
  if (creative.youtube_video_id) return <iframe className="aspect-video w-full border-0" src={`https://www.youtube-nocookie.com/embed/${creative.youtube_video_id}`} title="Saved YouTube ad video" loading="lazy" allow="fullscreen; picture-in-picture" allowFullScreen />;
  if (creative.video_url) return <div className="relative bg-black"><video src={creative.video_url} poster={creative.image_url} controls playsInline preload="metadata" onError={() => setFailed(true)} className={cn("block w-full object-contain", vertical ? "aspect-ad-vertical" : "aspect-video")} />{aiGenerated && <p className="flex items-center justify-center gap-1.5 bg-creamDeep px-3 py-2 text-xs text-inkMuted"><Sparkles className="size-3.5" aria-hidden />AI-generated</p>}</div>;
  if (imageSource) return <div className={cn("relative overflow-hidden bg-creamDeep", vertical ? "aspect-ad-vertical" : imageShape === "linkedin" ? "aspect-ad-linkedin" : imageShape === "reddit" ? "aspect-ad-reddit" : imageShape === "x" ? "aspect-video" : format === "feed" ? "aspect-ad-feed" : "aspect-video")}><Image src={imageSource} alt={creative.title ?? "Saved ad creative"} fill unoptimized sizes="340px" className="object-cover" onError={() => setFailed(true)} /></div>;
  if (creative.media_kind) return <div className={cn("flex flex-col items-center justify-center gap-3 bg-creamDeep p-6 text-center text-sm leading-relaxed text-inkMuted", vertical ? "aspect-ad-vertical" : "aspect-video")}><ImageOff className="size-6" aria-hidden /><p>{creative.media_kind === "video" ? "A playable video preview is not available for this proposal." : "An image preview is not available for this proposal."}</p></div>;
  return null;
}
