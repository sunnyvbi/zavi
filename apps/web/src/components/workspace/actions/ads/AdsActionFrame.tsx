"use client";

import type { ReactNode } from "react";
import { UserRound } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { SplitCardItem } from "../SplitCard";
import { isAdTask } from "./adSections";
import { useAdsPresentation } from "./AdsPresentation";
import { deliverableOf, deliverableParts, effortLabel, exactChangeRows } from "../types";
import { findBlanks } from "../blanks";
import { adReviewModel } from "./adReviewModel";
import { AdCreativePreview } from "./AdCreativePreview";
import { AdReviewFacts } from "./AdReviewFacts";
import { AdReviewEditing } from "./AdReviewEditing";
import { useAdReview, useNearScreen } from "./useAdReview";
import { AdPublishingBlocker } from "./AdPublishingBlocker";
import { ActionCardLayout } from "../ActionCardLayout";
import { AdsHowItWorks } from "./AdsHowItWorks";

export interface AdsActionFrameProps {
  a: SplitCardItem;
  kind?: string;
  isNew?: boolean;
  lead?: ReactNode;
  why?: ReactNode;
  bring?: { value: string; caption: string } | null;
  below?: ReactNode;
  right: ReactNode | null;
  footer?: ReactNode;
  status?: ReactNode;
  banner?: ReactNode;
  approving?: boolean;
}

export function AdsActionFrame({ a, kind, isNew, lead, why, bring, below, right, footer, status, banner, approving }: AdsActionFrameProps) {
  const presentation = useAdsPresentation();
  const execAction = presentation?.action;
  const [nearRef, near] = useNearScreen<HTMLDivElement>();
  const saved = useAdReview(near && execAction?.executable ? execAction.id : null, execAction?.body?.ad_review?.revision, [execAction?.status, execAction?.exec_status, execAction?.exec_bucket, execAction?.exec_code].join(":"));
  if (!presentation) return null;
  const { action, platform } = presentation;
  const reviseAd = presentation.handlers.onReviseAd;
  const task = isAdTask(action);
  const model = adReviewModel(saved.value?.review ? { ...action, body: { ...action.body, ad_review: saved.value.review } } : action);
  const split = !task && model.showPreview;
  const showReview = !task && (split || !!model.schedule || saved.value?.editable === true);
  const effort = effortLabel(action) ?? action.body?.step?.effort;
  const owner = action.body?.owner ?? action.body?.step?.owner;
  const ownerLabel = action.channel_slug === "linkedin_ads" ? null : owner === "developer" ? "Your developer" : owner === "founder" || (!owner && action.body?.step?.responsibility === "client") ? "You do it" : null;
  const deliverable = deliverableOf(action);
  const hasBlanks = [deliverable?.content, ...(deliverableParts(action) ?? []).map((part) => part.content)].some((content) => findBlanks(content, deliverable?.kind).length > 0);
  const previewDetails = split && model.creatives.length > 0 && exactChangeRows(action).length === 0 && !hasBlanks;
  const hasInstructions = !!(below || ((task || previewDetails) && right) || (previewDetails && why));
  const controls = footer && <div className="mt-6 min-w-0 [&_button]:min-h-10 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:text-sm [&_button:not([aria-label])]:rounded-xl [&_button:not([aria-label])]:px-4 [&_a]:max-w-full [&_a]:whitespace-normal [&_a.inline-flex]:min-h-10 [&_a.inline-flex]:rounded-xl [&_a.inline-flex]:px-4" data-testid="ads-footer">{footer}</div>;
  const slab = <>
          <div className={cn("flex justify-between", task ? "flex-wrap items-start gap-x-4 gap-y-2" : "flex-wrap items-center gap-3")}>
            {!task && <span className="flex items-center gap-2 text-sm font-semibold leading-5 text-inkSoft">{split ? model.kind : kind}</span>}
            {task && <h4 className="min-w-0 flex-1 basis-64 break-words text-lg font-semibold leading-7 text-ink">{a.title}</h4>}
            <div className="flex flex-wrap items-center gap-3 text-sm text-inkMuted">
              {ownerLabel && <span className="inline-flex items-center gap-1.5"><UserRound className="size-4" aria-hidden />{ownerLabel}{effort && <span> · {effort}</span>}</span>}
              {action.blocking && <Badge className="bg-warnBg px-3 py-1 text-warn">Do this first</Badge>}
              {isNew && <Badge className="bg-brand/5 px-3 py-1 text-brand">New</Badge>}
              {action.ad_recommendation && <Badge tone="brand" title={action.ad_recommendation.reason} className="px-3 py-1">Recommended</Badge>}
              {action.redo_of && <Badge>Rewritten</Badge>}
            </div>
          </div>
          {!task && <h4 className={cn("mt-3 break-words font-semibold text-ink", action.channel_slug === "linkedin_ads" && !split ? "text-lg leading-7" : "text-ad-title tracking-tight")}>{a.title}</h4>}
  </>;
  return <div ref={nearRef}><ActionCardLayout item={a} compact={task} advertising banner={banner} slab={slab} approving={approving} main={<>
          {task ? (
            <div className="mt-1 space-y-2 break-words text-ad-body text-inkSoft">{lead}{why}</div>
          ) : (
            <AdReviewFacts description={previewDetails ? lead : <>{lead}{why}</>} model={model} platformName={platform?.name} />
          )}
          {!task && !previewDetails && right && <div data-testid="ads-action-content" className="mt-6 min-w-0 space-y-4">{right}</div>}
          {bring && <div className="mt-5 text-ink" data-testid="action-bring"><p className="text-2xl font-semibold tabular-nums">{bring.value}</p><p className="text-sm text-inkMuted">{bring.caption}</p></div>}
  </>} previewTestId="ads-preview" preview={split ? <AdCreativePreview model={model} platformName={platform?.name ?? action.channel_slug} aiGenerated={action.body?.media?.ai_generated} onRefresh={action.executable ? saved.retry : undefined} refreshing={saved.loading} /> : null} footer={<>
          {showReview && <AdReviewEditing actionId={action.id} model={model} review={saved.value} busy={presentation.busy} saveNote={action.channel_slug !== "linkedin_ads"} readOnly={action.status !== "pending" || (!!action.exec_status && action.exec_status !== "failed")} onSave={reviseAd ? (edits) => reviseAd(action, edits) : undefined}>{controls}</AdReviewEditing>}
          {saved.error && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-inkMuted"><span>{saved.error}</span><Button type="button" variant="secondary" onClick={saved.retry}>Retry preview</Button></div>}
          {(saved.loading || (!near && !!execAction?.executable)) && <p role="status" className="mt-3 text-sm text-inkMuted">Loading saved preview…</p>}
          <AdPublishingBlocker action={action} platform={platform} connectionBlocker={saved.value?.connection_blocker} />
          {!showReview && controls}
          {status}
          {hasInstructions && <AdsHowItWorks testId={task ? "ads-task-instructions" : "ads-creative-details"}>{previewDetails && why}{(task || previewDetails) && right}{below}</AdsHowItWorks>}
  </>} /></div>;
}
