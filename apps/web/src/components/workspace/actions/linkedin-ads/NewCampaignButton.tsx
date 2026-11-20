"use client";

import { useRef, useState } from "react";
import { useChannelPlanLock } from "../channelPlanLock";
import { platformFor } from "../platforms";
import { campaignFetch } from "../managed-campaigns/api";
import { requestCampaignReview } from "../managed-campaigns/campaignReviewRequest";
import { LAUNCH_LOCK_ID, launchLockWords } from "../managed-campaigns/launchLock";
import { useLiveRole } from "../managed-campaigns/liveRole";
import { isMember } from "@/lib/members";
import { cardButton } from "../card/styles";
import { Plus } from "lucide-react";

const ERROR_ID = "linkedin-new-campaign-error";

export function NewCampaignButton({ label = "Create campaign" }: { label?: string }) {
  const liveRole = useLiveRole();
  const planLock = useChannelPlanLock();
  const latch = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  if (liveRole.unknown || isMember(liveRole.role)) return null;
  const locked = !!launchLockWords(planLock, platformFor("linkedin_ads").name);
  async function start() {
    if (latch.current || locked) return;
    latch.current = true;
    setStarting(true);
    setError("");
    try {
      const out = await campaignFetch<{ action_id: string }>("/api/channels/linkedin_ads/campaign-drafts", { method: "POST", body: "{}" });
      requestCampaignReview(out.action_id);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Zavi could not start a campaign. Try again.");
    } finally {
      latch.current = false;
      setStarting(false);
    }
  }
  return (
    <>
      <button
        type="button"
        data-testid="top-action-new_campaign"
        className={`${cardButton.base} ${cardButton.primary}`}
        disabled={starting || locked}
        aria-describedby={locked ? LAUNCH_LOCK_ID : error ? ERROR_ID : undefined}
        onClick={() => void start()}
      >
        {!starting && <Plus className="size-4" aria-hidden />}
        {starting ? "Starting…" : label}
      </button>
      {error && (
        <p id={ERROR_ID} role="alert" className="basis-full text-[13px] font-medium leading-5 text-danger">
          {error}
        </p>
      )}
    </>
  );
}
