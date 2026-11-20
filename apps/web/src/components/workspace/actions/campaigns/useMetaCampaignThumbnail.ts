"use client";

import type { CampaignMediaChannel } from "@zavi/shared";

import { useEffect, useState } from "react";
import { loadMetaCampaignThumbnails, type CampaignMediaLevel } from "./metaCampaignMedia";

interface ThumbnailState {
  urls: string[];
  index: number;
  loading: boolean;
  refresh: boolean;
}

export function useMetaCampaignThumbnail(campaignId: string, campaignIds = campaignId, channel: CampaignMediaChannel = "meta_ads", level: CampaignMediaLevel = "campaign", fallbackId?: string) {
  const [state, setState] = useState<ThumbnailState>({ urls: [], index: 0, loading: true, refresh: false });
  useEffect(() => {
    let cancelled = false;
    void loadMetaCampaignThumbnails(campaignIds.split(","), state.refresh, channel, level)
      .then((result) => {
        if (!cancelled) setState((current) => ({ ...current, urls: result[campaignId] ?? (fallbackId ? result[fallbackId] : undefined) ?? [], index: 0, loading: false }));
      }).catch(() => { if (!cancelled) setState((current) => ({ ...current, loading: false })); });
    return () => { cancelled = true; };
  }, [campaignId, campaignIds, state.refresh, channel, level, fallbackId]);
  const onError = () => setState((current) => {
    if (current.index + 1 < current.urls.length) return { ...current, index: current.index + 1 };
    if (!current.refresh) return { urls: [], index: 0, loading: true, refresh: true };
    return { ...current, urls: [], loading: false };
  });
  return { image: state.urls[state.index] ?? null, loading: state.loading, onError };
}
