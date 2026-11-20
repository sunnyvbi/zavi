"use client";

import { BusinessControlsApprovalCard } from "@/components/workspace/actions/BusinessControlsApprovalCard";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { approveDecision } from "@/lib/approvals/approveDecision";
import { PostPreview } from "@/components/workspace/PostPreview";
import { LiveDecisionCard } from "./LiveDecisionCard";
import { ChatVideoCard } from "@/components/workspace/actions/ChatVideoCard";
import { originLabel } from "@/lib/workspace/threadTimeline";
import { isXAdsClass } from "@/app/approvals/xAdsDecision";
import { isTiktokAdsClass } from "@/app/approvals/tiktokAdsDecision";
import { NextChevron } from "@/components/ui/NextChevron";
import { EmailCampaignCard } from "@/components/email/EmailCampaignCard";
import { EMAIL_CARD_CLASSES } from "@/components/email/emailCardClasses";
import { useEmailCardHidden } from "@/lib/workspace/emailCardHidden";
import { getChannel } from "@zavi/shared";
import { outcomeAppName } from "@/app/approvals/approvalsHelpers";
import { slipPlatform } from "./slip/decisionSlip";
import { SLIP_PRIMARY, SLIP_QUIET, SlipCard, SlipFlag, SlipSlab } from "./slip/SlipParts";

export type DecisionBody = {
  decision_id: string;
  decision_class: string;
  title: string;
  summary?: string;
  subject?: string;
  before_usd?: number;
  after_usd?: number;
  channel?: string;
  payload?: Record<string, unknown>;
  scheduled_at?: string | null;
  full_card?: boolean;
  run_stopped?: boolean;
  store?: "decision" | "channel_action";
  channel_slug?: string;
  shown_at?: string;
  from_other_chat?: boolean;
  filed_at?: string;
};

export function CardOriginLine({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <p data-testid="card-origin" className="mb-1 text-[12px] text-inkMuted">
      {label}
    </p>
  );
}

export function channelCardLink(slug: string, id: string): string {
  return `/workspace?tab=channels&channel=${encodeURIComponent(slug)}&action=${encodeURIComponent(id)}`;
}

export function ChannelCardInChat({ body }: { body: DecisionBody }) {
  const slug = body.channel_slug;
  const name = slug ? getChannel(slug)?.name ?? slug : null;
  return (
    <section
      role="region"
      aria-label={body.title}
      data-decision-id={body.decision_id}
      data-testid="channel-card-in-chat"
      className="rounded-xl border border-[#f0dca6] bg-[#fffaf0] p-3 shadow-[0_1px_2px_rgba(25,25,25,.05)]"
    >
      <p className="text-[13px] font-medium text-ink">{body.title}</p>
      <p className="mt-0.5 text-[12px] text-inkMuted">{name ? `Waiting for you on the ${name} channel page.` : "Waiting for you on its channel page."}</p>
      {slug && (
        <a
          href={channelCardLink(slug, body.decision_id)}
          className="mt-2 inline-flex h-9 items-center rounded-md bg-ink px-3 text-[13px] font-medium text-white"
        >
          Open the card
        </a>
      )}
    </section>
  );
}

export const RUN_STOPPED_NOTE = "This run was stopped.";
export function RunStoppedNote() {
  return (
    <div className="mt-2 rounded-md border border-rule bg-bone px-2.5 py-1.5 text-[12px] text-ink">
      {RUN_STOPPED_NOTE}
    </div>
  );
}

export type ApprovalResolution = "approved" | "rejected";

export function ApprovalBlock(props: Parameters<typeof ApprovalBlockCard>[0]) {
  const removed = useEmailCardHidden(props.body.decision_id);
  if (removed && props.body.store !== "channel_action" && EMAIL_CARD_CLASSES.has(props.body.decision_class)) return null;
  const label = originLabel(props.body);
  if (!label) return <ApprovalBlockCard {...props} />;
  return (
    <div>
      <CardOriginLine label={label} />
      <ApprovalBlockCard {...props} />
    </div>
  );
}

function ApprovalBlockCard({
  body,
  onReview,
  onResolved,
  viewerRole = null,
}: {
  body: DecisionBody;
  onReview?: (decisionId: string) => void;
  onResolved?: (decisionId: string, resolution: ApprovalResolution) => void;
  viewerRole?: "owner" | "admin" | "member" | "viewer" | null;
}) {
  if (body.store === "channel_action" && body.channel_slug === "generated_video") {
    return <ChatVideoCard id={body.decision_id} title={body.title} fallback={<ChannelCardInChat body={body} />} />;
  }
  if (body.store === "channel_action") return <ChannelCardInChat body={body} />;
  if (body.decision_class === "growth.save_business_controls") return <BusinessControlsApprovalCard decisionId={body.decision_id} onResolved={(resolution) => onResolved?.(body.decision_id, resolution)} />;
  if (EMAIL_CARD_CLASSES.has(body.decision_class)) {
    return <EmailCampaignCard rail="decisions" id={body.decision_id} surface="chat" removable onApproved={() => onResolved?.(body.decision_id, "approved")} onRejected={() => onResolved?.(body.decision_id, "rejected")} />;
  }
  if (body.decision_class.startsWith("composio.") || body.full_card === true || isXAdsClass(body.decision_class) || isTiktokAdsClass(body.decision_class)) {
    return <LiveDecisionCard decisionId={body.decision_id} title={body.title} viewerRole={viewerRole} onResolved={onResolved} runStopped={body.run_stopped === true} shownAt={body.shown_at} surface="chat" />;
  }
  return <PlainApprovalBlock body={body} onReview={onReview} onResolved={onResolved} />;
}

function PlainApprovalBlock({
  body,
  onReview,
  onResolved,
}: {
  body: DecisionBody;
  onReview?: (decisionId: string) => void;
  onResolved?: (decisionId: string, resolution: ApprovalResolution) => void;
}) {
  const [state, setState] = useState<"open" | "submitting" | "approved" | "rejected" | "error">(
    "open",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isInlineConfirm = typeof body.summary === "string";
  const confirmLabel = isInlineConfirm ? "Confirm" : "Approve";
  const dismissLabel = isInlineConfirm ? "Dismiss" : "Reject";

  const act = async (action: "approve" | "reject") => {
    setState("submitting");
    setErrorMsg(null);
    try {
      const res =
        action === "approve"
          ? await approveDecision(body.decision_id)
          : await apiFetch(`/api/approvals/${body.decision_id}/reject`, {
              method: "POST",
            });
      if (!res) {
        setState("open");
        return;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const resolution = action === "approve" ? "approved" : "rejected";
      setState(resolution);
      onResolved?.(body.decision_id, resolution);
    } catch (e) {
      setErrorMsg((e as Error).message);
      setState("error");
    }
  };

  const platform = slipPlatform(body.decision_class, {}, outcomeAppName(body.decision_class, {}));
  const mark = (platform.replace(/^the /, "").trim()[0] ?? "Z").toUpperCase();
  const hero =
    body.after_usd !== undefined
      ? { eyebrow: "New daily budget", amount: `$${body.after_usd}/day`, unit: null, was: body.before_usd !== undefined ? `$${body.before_usd}/day` : null, before: `$${body.after_usd}/day`, beforeUnit: null, chip: null }
      : null;
  const stage = state === "approved" ? "queued" : state === "rejected" ? "rejected" : state === "submitting" ? "queued" : "waiting";
  const word = state === "approved" ? "Approved" : state === "rejected" ? "Rejected" : state === "submitting" ? "Sending" : "Needs your yes";

  if (state === "approved" || state === "rejected") {
    return (
      <SlipCard label={body.title} decisionId={body.decision_id}>
        <SlipSlab stage={stage} literal status={word} platform={platform} mark={mark} target={null} title={body.title} hero={null} />
        <p className="px-4 pb-3 pt-3 text-[12.5px] sm:px-5">
          <span className="font-mono text-[11px] text-[#a8977a]">{body.decision_class}</span>{" "}
          <span className="text-[#a8977a]">·</span>{" "}
          <span className="text-ink">
            {state === "approved" ? "Approved" : "Rejected"} · {new Date().toLocaleTimeString()}
          </span>
        </p>
      </SlipCard>
    );
  }

  return (
    <section role="region" aria-labelledby={`approval-${body.decision_id}`} className="w-full min-w-0">
      <SlipCard label={body.title} decisionId={body.decision_id}>
        <SlipSlab stage={stage} literal status={word} platform={platform} mark={mark} target={null} title={body.title} hero={hero}>
          <span id={`approval-${body.decision_id}`} className="sr-only">{body.title}</span>
        </SlipSlab>
        {body.run_stopped === true && <SlipFlag>{RUN_STOPPED_NOTE}</SlipFlag>}
        {}
        {body.after_usd === undefined && body.before_usd !== undefined && (
          <p className="px-4 pt-3 text-[13px] text-ink sm:px-5">
            <span className="text-[#a8977a] line-through">${body.before_usd}/day</span>
          </p>
        )}
        {(body.subject || body.summary) && (
          <div className="px-4 pt-3 sm:px-5">
            {body.subject && <div className="font-mono text-[11px] text-[#7a6a4a]">{body.subject}</div>}
            {body.summary && <p className="mt-1 text-[13px] leading-snug text-[#3f3f3f]">{body.summary}</p>}
          </div>
        )}
        {body.decision_class === "social.publish.v2" && body.channel && body.payload && (
          <div className="px-4 pt-3 sm:px-5">
            <PostPreview channel={body.channel} payload={body.payload} scheduledAt={body.scheduled_at ?? null} />
          </div>
        )}
        {}
        {body.decision_class === "dispute-response.submit-evidence" && (
          <SlipFlag tone="risk">
            <span className="font-semibold">Sends evidence to Stripe.</span> A final submission is <strong>irreversible</strong>: you can&apos;t resubmit or edit it after. Review the evidence before approving.
          </SlipFlag>
        )}
        <div className="px-4 pb-3 pt-3 sm:px-5">
          {state === "error" && errorMsg && <div className="mb-2 text-[12.5px] text-[#be123c]">{errorMsg}</div>}
          <button type="button" disabled={state === "submitting"} onClick={() => act("approve")} className={SLIP_PRIMARY}>
            {state === "submitting" ? "Submitting…" : confirmLabel}
          </button>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-[11px] text-[#a8977a]">{body.decision_class}</span>
            <div className="flex items-center gap-1">
              {}
              {!isInlineConfirm && onReview && (
                <button type="button" onClick={() => onReview(body.decision_id)} className="inline-flex min-h-[44px] items-center px-2 text-[12.5px] font-semibold text-[#8a5a10] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d8881e]">
                  Open in Needs you <NextChevron />
                </button>
              )}
              <button type="button" disabled={state === "submitting"} onClick={() => act("reject")} className={SLIP_QUIET}>
                {dismissLabel}
              </button>
            </div>
          </div>
        </div>
      </SlipCard>
    </section>
  );
}

export { LiveDecisionCardView as ComposioWriteCardView } from "./LiveDecisionCard";
export type { LiveDecisionRow as ComposioDecisionRow } from "@/lib/approvals/decisionApi";
