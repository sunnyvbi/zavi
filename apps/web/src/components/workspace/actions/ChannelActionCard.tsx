"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CampaignActionReview } from "./managed-campaigns/CampaignActionReview";
import { SponsoredPostReview } from "./managed-campaigns/SponsoredPostReview";
import { clearCampaignReview, usePendingCampaignReview } from "./managed-campaigns/campaignReviewRequest";
import { closeCampaignReview, isCampaignReviewOpen, openCampaignReview } from "./managed-campaigns/openCampaignReview";
import { holdCampaignReview } from "./managed-campaigns/campaignReviewPrefetch";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember, isViewer } from "@/lib/members";
import { PlanDayLine } from "./ChannelSchedule";
import { StatusBanner } from "./StatusBanner";
import { EmailCampaignCard } from "@/components/email/EmailCampaignCard";
import { EmailWorkCard, isEmailWorkCard } from "./EmailWorkCard";
import type { ActionBodyProps, ActionRedoState } from "./types";
import { FamilyCard } from "./card/FamilyCard";
import { topicPickOf } from "./TopicPick";
import { TopicPickCard } from "./organic/TopicPickCard";
import { REDO_LINE } from "./card/redoWords";
import { trackCardEvent, withCardEvents } from "./cardEvents";

function RedoLine({ state }: { state: ActionRedoState }) {
  return (
    <p
      role="status"
      data-testid="action-redoing"
      data-redo-state={state}
      className="mb-2 flex items-center gap-2 text-ca-action text-ca-secondary"
    >
      {state === "working" && (
        <span
          className="size-3 shrink-0 animate-spin rounded-full border-2 border-ca-strong border-t-ca-xdark motion-reduce:animate-none"
          aria-hidden
        />
      )}
      {REDO_LINE[state]}
    </p>
  );
}

export function ChannelActionCard(props: ActionBodyProps) {
  const workspace = useWorkspaceOptional();
  const tenantId = workspace?.tenantId;
  const handlers = useMemo(() => withCardEvents(props.handlers, tenantId), [props.handlers, tenantId]);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      trackCardEvent("card_shown", props.action, tenantId);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.action.id]);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const opener = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-card-open]") : null;
      if (!opener || opener.getAttribute("aria-expanded") === "true") return;
      trackCardEvent("card_opened", props.action, tenantId, { section: opener.dataset.cardOpen ?? null });
    };
    el.addEventListener("click", onClick, true);
    return () => el.removeEventListener("click", onClick, true);
  }, [props.action, tenantId]);
  const [reviewing, setReviewing] = useState(() => !props.action.executable && props.action.status === "pending" && isCampaignReviewOpen(props.action.id));
  const startReview = () => { trackCardEvent("card_primary_clicked", props.action, tenantId, { action: "review" }); openCampaignReview(props.action.id); setReviewing(true); };
  const endReview = () => { closeCampaignReview(props.action.id); setReviewing(false); };
  const [emailApproving, setEmailApproving] = useState(false);
  const [prepared, setPrepared] = useState<ActionBodyProps["action"] | null>(null);
  const action = !props.action.executable && props.action.status === "pending" && prepared?.id === props.action.id ? prepared : props.action;
  const spec = props.platform?.campaignWorkspace;
  const lite = props.platform?.sponsoredPostReview;
  const role = workspace?.role ?? null;
  const readOnly = isMember(role) && props.action.channel_slug === "linkedin_ads";
  const approvalBlocked = isMember(role) && action.approve_needs_admin === true;
  const hideActions = isViewer(role);
  const canReview = !readOnly && (!!spec?.actionReviewPath || !!lite) && !action.executable
    && action.status === "pending" && action.body?.step?.responsibility === "client"
    && action.body?.step?.deliverable?.presentation?.type === "campaign_draft";
  const requested = usePendingCampaignReview();
  const holdPath = reviewing && canReview && lite && !spec?.actionReviewPath ? `${lite.actionReviewPath}/${encodeURIComponent(props.action.id)}/review` : null;
  const holdRevision = props.action.post_revision;
  useLayoutEffect(() => holdPath ? holdCampaignReview(holdPath, holdRevision) : undefined, [holdPath, holdRevision]);
  useEffect(() => {
    if (!canReview || requested !== props.action.id) return;
    clearCampaignReview(requested);
    openCampaignReview(requested);
    setReviewing(true);
  }, [canReview, requested, props.action.id]);
  const bodyProps = {
    ...props,
    action,
    approvalBlocked,
    hideActions,
    handlers: canReview ? { ...handlers, onReviewExecute: startReview } : handlers,
  };
  const review = spec?.actionReviewPath
    ? <CampaignActionReview action={props.action} spec={spec} handlers={handlers} onPrepared={setPrepared} onClose={endReview} />
    : lite
      ? <SponsoredPostReview action={props.action} spec={lite} handlers={handlers} onPrepared={setPrepared} onClose={endReview} />
      : null;
  const [emailPinned, setEmailPinned] = useState(false);
  const emailOpen = action.email_card === true && (emailPinned || (action.status === "pending" && (action.exec_status === null || action.exec_status === "failed")));
  const bodyKey = `${action.id}:${action.post_revision ?? ""}`;
  const family = topicPickOf(action) === null;
  const body = family ? <FamilyCard key={bodyKey} {...bodyProps} /> : <TopicPickCard key={bodyKey} {...bodyProps} />;
  const content = isEmailWorkCard(action, props.platform) ? (
    <EmailWorkCard key={bodyKey} {...bodyProps} />
  ) : emailOpen ? (
    <div data-testid={`action-${action.id}`} data-action-type={action.action_type} data-source={action.source} className="min-w-0 space-y-3">
      {(action.exec_status === "failed" || emailApproving) && (
        <div className="overflow-hidden rounded-2xl border border-ca-strong">
          <StatusBanner a={action} approving={emailApproving} platformName={props.platform?.name ?? "Email campaigns"} execCopy={props.platform?.execCopy} />
        </div>
      )}
      {action.body?.step?.body && <p data-testid="email-step-lead" className="break-words px-1 text-ca-body text-ca-xdark">{action.body.step.body}</p>}
      <EmailCampaignCard
        rail="channel_actions"
        id={action.id}
        removable
        onAskZavi={props.handlers.onOpenChat ? () => props.handlers.onOpenChat!(action) : undefined}
        onNotSent={() => setEmailPinned(true)}
        onChanged={props.handlers.onEmailCardChanged ? () => props.handlers.onEmailCardChanged!(action) : undefined}
        onApprovingChange={setEmailApproving}
        onReject={(note) => handlers.onSetStatus(action, "rejected", note ? { note } : undefined)}
        canCancel={action.status === "pending" && action.exec_status !== "queued" && action.exec_status !== "dispatching"}
      />
    </div>
  ) : (
    <>{body}{reviewing && review}</>
  );
  const move = props.handlers.onMovePlanDay;
  const redoLine = props.redoing && (emailOpen || isEmailWorkCard(action, props.platform)) ? props.redoing : undefined;
  return (
    <div ref={cardRef} className="min-w-0">
      {redoLine && <RedoLine state={redoLine} />}
      {move && <PlanDayLine action={props.action} />}
      {content}
    </div>
  );
}
