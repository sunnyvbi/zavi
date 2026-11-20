"use client";

import type { AdReviewResponse } from "@zavi/shared";
import type { ActionBodyProps, ActionItem } from "../types";
import { AdReviewEditForm } from "../ads/AdReviewEditing";
import { adReviewModel } from "../ads/adReviewModel";
import { useAdReview, useNearScreen } from "../ads/useAdReview";
import { CardButton } from "../card/CardButton";

function hasReviewSurface(a: ActionItem): boolean {
  const model = adReviewModel(a);
  return model.creatives.length > 0 || !!model.schedule?.start || !!model.schedule?.end;
}

export function usePaidAdReview(a: ActionItem) {
  const [ref, near] = useNearScreen<HTMLDivElement>();
  const saved = useAdReview(near && a.executable ? a.id : null, a.body?.ad_review?.revision, [a.status, a.exec_status, a.exec_bucket, a.exec_code].join(":"));
  const review = saved.value && Array.isArray(saved.value.fields) ? saved.value : null;
  const shown: ActionItem = review?.review ? { ...a, body: { ...a.body, ad_review: review.review } } : a;
  const locked = a.status !== "pending" || (!!a.exec_status && a.exec_status !== "failed");
  const editable = !locked && !!review?.editable && !!review.review?.revision;
  const scheduleOnly = !!review?.fields.length && review.fields.every((f) => f.kind === "date" || f.kind === "datetime");
  const limits = review && !review.editable && hasReviewSurface(shown) ? review.limitations ?? [] : [];
  return { ref, review, shown, editable, editLabel: scheduleOnly ? "Edit schedule" : "Edit", limits, error: saved.error, retry: saved.retry };
}

export type PaidAdReview = ReturnType<typeof usePaidAdReview>;

export function ReviewNotes({ saved }: { saved: PaidAdReview }) {
  return (
    <>
      {saved.limits.length > 0 && (
        <div data-testid="ad-review-locked" className="flex flex-col gap-1 text-ca-action text-ca-secondary">
          {saved.limits.map((m) => <p key={m}>{m}</p>)}
        </div>
      )}
      {saved.error && (
        <div role="alert" data-testid="ad-review-error" className="flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
          <span>{saved.error} The preview above may be incomplete.</span>
          <CardButton onClick={saved.retry}>Retry preview</CardButton>
        </div>
      )}
    </>
  );
}

export function PaidAdEdit({ props, review, onClose }: { props: ActionBodyProps; review: AdReviewResponse; onClose: () => void }) {
  const { action: a, handlers, busy } = props;
  if (!review.review?.revision || !handlers.onReviseAd) return null;
  return (
    <AdReviewEditForm
      key={review.review.revision}
      actionId={a.id}
      subtitle={a.title}
      model={adReviewModel({ ...a, body: { ...a.body, ad_review: review.review } })}
      review={review}
      revision={review.review.revision}
      busy={busy}
      saveNote={a.channel_slug !== "linkedin_ads"}
      onSave={(edits) => handlers.onReviseAd!(a, edits)}
      onCancel={onClose}
    />
  );
}
