"use client";

import { isCampaignMediaChannel, type CampaignMediaChannel } from "@zavi/shared";
import { useEffect, useState } from "react";
import { CampaignThumbnailView } from "./CampaignThumbnailView";
import { useMetaCampaignThumbnail } from "./useMetaCampaignThumbnail";
import { useAdImagePreview } from "../ads/useAdImagePreview";
import type { CampaignMediaLevel } from "./metaCampaignMedia";

export interface CampaignThumbnailProps {
  channel: string;
  campaignId: string;
  campaignIds?: string;
  name: string;
  images?: readonly string[];
  textOnly?: boolean;
  level?: CampaignMediaLevel;
  fallbackId?: string;
}

export function CampaignThumbnail(props: CampaignThumbnailProps) {
  const { images = [] } = props;
  if (!images.length && isCampaignMediaChannel(props.channel)) return <RemoteCampaignThumbnail {...props} channel={props.channel} />;
  return <SavedCampaignThumbnail key={images.join(",")} {...props} images={images} />;
}

function RemoteCampaignThumbnail({ channel, campaignId, campaignIds, name, textOnly, level, fallbackId }: CampaignThumbnailProps & { channel: CampaignMediaChannel }) {
  const { image, loading, onError } = useMetaCampaignThumbnail(campaignId, campaignIds, channel, level, fallbackId);
  return <CampaignThumbnailView image={image} loading={loading} name={name} textOnly={textOnly} onError={onError} />;
}

function SavedCampaignThumbnail({ images = [], name, textOnly, channel, campaignId, campaignIds }: CampaignThumbnailProps) {
  const [index, setIndex] = useState(0);
  const { src, loading, failed } = useAdImagePreview(images[index] ?? null);
  useEffect(() => { if (failed) setIndex((current) => current + 1); }, [failed]);
  if (index >= images.length && images.length > 0 && isCampaignMediaChannel(channel)) return <RemoteCampaignThumbnail channel={channel} campaignId={campaignId} campaignIds={campaignIds} name={name} textOnly={textOnly} />;
  return <CampaignThumbnailView image={src} name={name} loading={loading} textOnly={textOnly} onError={() => setIndex((current) => current + 1)} />;
}
