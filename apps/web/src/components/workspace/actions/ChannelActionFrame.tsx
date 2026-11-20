"use client";

import type { ReactNode } from "react";
import { getChannel } from "@zavi/shared";
import { REDDIT_ORGANIC_SLUG } from "@/lib/agentRegistry";
import { ActionCardLayout } from "./ActionCardLayout";
import { ActionCardFacts } from "./ActionCardFacts";
import { ActionHowItWorks } from "./ActionHowItWorks";
import type { AdsActionFrameProps } from "./ads/AdsActionFrame";

export function ChannelActionFrame({ a, header, lead, why, bring, below, right, footer, status, banner, pick, approving }: AdsActionFrameProps & { header: ReactNode; pick?: ReactNode }) {
  const setup = a.card_kind === "task" || ["fix", "check", "setup"].includes(a.action_type);
  const task = setup && !a.body?.step?.deliverable && !a.body?.exact_change?.rows.length;
  const review = a.body?.ad_review;
  const credits = (a.body as { cost_credits?: unknown } | undefined)?.cost_credits;
  const cost =
    review?.cost ??
    (typeof a.body?.cost === "string" ? a.body.cost : null) ??
    (typeof credits === "number" && Number.isFinite(credits) && credits > 0 ? `${credits.toLocaleString("en-US")} credits, charged only when the video arrives` : null);
  const reddit = a.channel_slug === REDDIT_ORGANIC_SLUG;
  const provenance =
    review?.provenance ??
    (a.source === "channel_action"
      ? reddit && a.run_id
        ? "From a Zavi run"
        : reddit && a.body?.step?.deliverable?.presentation?.type === "reddit_reply"
          ? "Drafted by Zavi from your Reddit scan"
          : "Saved channel proposal"
      : null);
  const missing = a.source === "creator" ? null : "Not supplied";
  const description = lead || why ? <>{lead}{why}</> : a.title;
  const instructions = task ? <>{right}{below}</> : below;
  const slab = <>
    {header}
    <h3 className="mt-2 break-words text-ad-title font-semibold tracking-tight text-ink">{a.title}</h3>
  </>;
  return <ActionCardLayout item={a} compact={task} banner={banner} slab={slab} approving={approving} preview={task ? null : right} main={<>
    {task ? <div className="space-y-2 break-words text-ad-body text-inkSoft">{description}</div> : <ActionCardFacts description={description} cost={reddit || a.channel_slug === "pinterest_organic" ? null : cost ?? (setup ? null : missing)} provenance={provenance ?? missing} destination={getChannel(a.channel_slug)?.name} />}
    {pick}
    {bring && <div data-testid="action-bring" className="mt-4 text-ink"><p className="text-2xl font-semibold tabular-nums">{bring.value}</p><p className="text-sm text-inkMuted">{bring.caption}</p></div>}
  </>} footer={<>
    {footer && <div className="mt-5 min-w-0 [&_button]:min-h-10 [&_a.inline-flex]:min-h-10 [&_button]:max-w-full [&_button]:whitespace-normal [&_a]:max-w-full [&_a]:whitespace-normal">{footer}</div>}
    {status}
    {(below || task && right) && <ActionHowItWorks testId="channel-action-instructions">{instructions}</ActionHowItWorks>}
  </>} />;
}
