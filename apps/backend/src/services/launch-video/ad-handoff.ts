
import { aspectArtifactFilename } from "./aspect-artifacts";
import type { Aspect, VideoType } from "./brief-mapper";

export type AdPlacement = "reels_stories" | "feed";

export function placementForAspect(aspect: Aspect): AdPlacement {
  return aspect === "9:16" ? "reels_stories" : "feed";
}

export type AdDraftAsset = {
  filename: string;
  aspect: Aspect;
  variant: string | null;
  placement: AdPlacement;
};

export type AdDraftHandoff = {
  target_agent_slug: "performance-marketer";
  channel: "meta";
  status: "draft";
  live: false;
  assets: AdDraftAsset[];
};

export function buildAdDraftHandoff(input: {
  videoType: VideoType;
  outputs: Array<{ aspect: Aspect; label: string }>;
  multiVariant: boolean;
}): AdDraftHandoff | null {
  if (input.videoType !== "ad") return null;
  if (input.outputs.length === 0) return null;
  const assets: AdDraftAsset[] = input.outputs.map((o) => ({
    filename: aspectArtifactFilename(o.aspect, input.multiVariant ? o.label : undefined),
    aspect: o.aspect,
    variant: input.multiVariant ? o.label : null,
    placement: placementForAspect(o.aspect),
  }));
  return { target_agent_slug: "performance-marketer", channel: "meta", status: "draft", live: false, assets };
}

export function adArtifactHandoffMeta(
  aspect: Aspect,
  variant: string | null,
): {
  ad_draft_handoff: {
    target_agent_slug: "performance-marketer";
    channel: "meta";
    status: "draft";
    live: false;
    placement: AdPlacement;
    aspect: Aspect;
    variant: string | null;
  };
} {
  return {
    ad_draft_handoff: {
      target_agent_slug: "performance-marketer",
      channel: "meta",
      status: "draft",
      live: false,
      placement: placementForAspect(aspect),
      aspect,
      variant,
    },
  };
}
