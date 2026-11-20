"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useChannelPlanLock } from "../actions/channelPlanLock";
import { TOP_ACTION_AGAIN_EVENT } from "../actions/topActions/api";
import { cn } from "@/lib/cn";
import { cardButton } from "../actions/card/styles";
import { ChannelHeaderSlot } from "../layout/ChannelHeaderRow";
import { OnTab } from "../layout/channelPage";
import { campaignDraftFromInputs, NEW_CAMPAIGN_KEY, NewCampaignDialog, newCampaignSession, type CampaignSession } from "./NewCampaignDialog";

export function EmailHeadTools({ slug, channelName }: { slug: string; channelName: string }) {
  const planLock = useChannelPlanLock();
  const [open, setOpen] = useState(false);
  const session = useRef<CampaignSession | null>(null);
  if (!session.current) session.current = newCampaignSession();
  const tag = planLock?.tierName ?? null;
  const planLockRef = useRef(planLock);
  planLockRef.current = planLock;
  useEffect(() => {
    const again = (e: Event) => {
      const d = (e as CustomEvent<{ slug?: string; key?: string; inputs?: Record<string, unknown> }>).detail;
      if (d?.slug !== slug || d.key !== NEW_CAMPAIGN_KEY) return;
      const lock = planLockRef.current;
      if (lock?.tierName) {
        lock.upgrade();
        return;
      }
      if (d.inputs && session.current) session.current.draft = campaignDraftFromInputs(d.inputs);
      setOpen(true);
    };
    window.addEventListener(TOP_ACTION_AGAIN_EVENT, again);
    return () => window.removeEventListener(TOP_ACTION_AGAIN_EVENT, again);
  }, [slug]);
  return (
    <>
      <ChannelHeaderSlot>
        <OnTab tab="overview">
          <button
            type="button"
            data-testid="new-campaign-button"
            onClick={() => {
              if (tag && planLock) {
                planLock.upgrade();
                return;
              }
              setOpen(true);
            }}
            className={cn(cardButton.base, cardButton.primary, "pl-3.5 pr-4")}
          >
            <Plus aria-hidden className="size-4 shrink-0" />
            New email
            {tag && <span className="rounded bg-ca-on-action/20 px-1 text-[11px] font-semibold">{tag}</span>}
          </button>
        </OnTab>
      </ChannelHeaderSlot>
      {open && <NewCampaignDialog slug={slug} channelName={channelName} session={session.current} onClose={() => setOpen(false)} />}
    </>
  );
}
