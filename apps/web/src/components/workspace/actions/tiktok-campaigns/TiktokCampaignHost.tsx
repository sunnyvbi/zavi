"use client";
import { useEffect, useState } from "react";
import { APPROVALS_CHANGED_EVENT } from "../topActions/api";
import { useChannelPlanLock } from "../channelPlanLock";
import { TIKTOK_CAMPAIGN_NEW, TIKTOK_CAMPAIGN_OPEN } from "./openCampaign";
import { NewTiktokCampaign } from "./NewTiktokCampaign";
import { TiktokCampaignEditor } from "./TiktokCampaignEditor";
import type { TiktokCampaignTarget } from "./types";

export function TiktokCampaignHost({ onChanged }: { onChanged: () => void }) {
  const [target, setTarget] = useState<TiktokCampaignTarget | null>(null);
  const [creating, setCreating] = useState(false);
  const planLock = useChannelPlanLock();
  useEffect(() => {
    const open = (e: Event) => {
      const detail = (e as CustomEvent<TiktokCampaignTarget>).detail;
      if (!detail || !/^\d+$/.test(detail.advertiser_id) || !/^\d+$/.test(detail.campaign_id)) return;
      if (planLock?.tierName) { planLock.upgrade(); return; }
      setTarget(detail);
    };
    const create = () => {
      if (planLock?.tierName) { planLock.upgrade(); return; }
      setCreating(true);
    };
    window.addEventListener(TIKTOK_CAMPAIGN_OPEN, open);
    window.addEventListener(TIKTOK_CAMPAIGN_NEW, create);
    return () => {
      window.removeEventListener(TIKTOK_CAMPAIGN_OPEN, open);
      window.removeEventListener(TIKTOK_CAMPAIGN_NEW, create);
    };
  }, [planLock]);
  const changed = () => { onChanged(); window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT)); };
  if (creating) return <NewTiktokCampaign onClose={() => setCreating(false)} onChanged={changed} />;
  if (!target) return null;
  return <TiktokCampaignEditor key={`${target.advertiser_id}:${target.campaign_id}`} target={target} onClose={() => setTarget(null)} onChanged={changed} />;
}
