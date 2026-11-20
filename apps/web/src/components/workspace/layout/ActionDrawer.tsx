"use client";

import { useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cx, FOCUS_RING } from "./shared";
import { DeliverableBlock } from "./DeliverableBlock";
import { PostPreview } from "../PostPreview";
import { SOCIAL_PUBLISH_CLASS } from "./InlineActionBody";
import { CLASS_CONSEQUENCE, bulkSendConsequence } from "@zavi/shared";
import {
  decisionTitle,
  dispatchCardHeadline,
  handlerPreview,
  isHighStakesDecision,
  stakesClassOf,
} from "@/app/approvals/approvalsHelpers";

export type DrawerDecision = {
  id: string;
  decision_class: string;
  body: Record<string, unknown>;
  handler: string | null;
  emitted_at: string;
  agent_slug?: string | null;
  thread_id?: string | null;
  channel_slug?: string | null;
  exec_class?: string | null;
};

export type DeliveryMode = "advise" | "produce" | "execute";

import { Markdown } from "@/components/workspace/Markdown";
import {
  RECIPE_STEP_CLASS,
  recipeMarkdown,
  recipeSteps,
  recipeStepHeadline,
  singleRecipeStep,
  recipeStepPosition,
} from "@/lib/workspace/recipeStep";

const PILL =
  "h-10 rounded-full px-4 text-[16px] font-medium transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50";

function artifactText(body: Record<string, unknown>): string | null {
  for (const key of ["artifact", "draft", "content", "copy", "text", "message"]) {
    const v = body[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export function ActionDrawer({
  decision,
  postEdit,
  approveBlockedReason,
  onEditPost,
  mode,
  busy,
  error,
  onClose,
  onApprove,
  onReject,
  onDidIt,
  onDidntDoIt,
  onNotNow,
  onOpenThread,
}: {
  decision: DrawerDecision | null;
  postEdit?: { text: string; thread?: string[] };
  approveBlockedReason?: string | null;
  onEditPost?: (next: { text: string; thread?: string[] }) => void;
  mode: DeliveryMode;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  onDidIt: () => void;
  onDidntDoIt: () => void;
  onNotNow: () => void;
  onOpenThread: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const decisionId = decision?.id;

  useEffect(() => {
    if (!decisionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [decisionId]);

  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  if (!decision) return null;

  const d = decision;
  const high = isHighStakesDecision(stakesClassOf(d), d.handler, d.body);
  const { verbLabel } = decisionTitle(d.decision_class, d.body);
  const dispatch = dispatchCardHeadline(d.body);
  const preview = handlerPreview(d.handler, d.body)?.replace(/^[\s→·–—-]+/, "");
  const isRecipe = d.decision_class === RECIPE_STEP_CLASS;
  const recipeHeadline = isRecipe ? recipeStepHeadline(d.body) : null;
  const title =
    recipeHeadline || dispatch?.headline || preview || verbLabel || d.decision_class;
  const singleStep = isRecipe ? singleRecipeStep(d.body) : null;
  const stepPosition = isRecipe ? recipeStepPosition(d.body) : null;
  const steps = singleStep ? [singleStep] : isRecipe ? recipeSteps(d.body) : [];
  const analysis = isRecipe ? recipeMarkdown(d.body) : null;
  const artifact = artifactText(d.body);
  const manual = mode !== "execute";
  const post =
    d.decision_class === SOCIAL_PUBLISH_CLASS &&
    typeof d.body.channel === "string" &&
    !!d.body.payload &&
    typeof d.body.payload === "object" &&
    !Array.isArray(d.body.payload)
      ? { channel: d.body.channel, payload: d.body.payload as Record<string, unknown> }
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end bg-black/35"
    >
      <div
        ref={panelRef}
        onClick={stop}
        className="flex h-full w-full max-w-[min(760px,92vw)] flex-col border-l border-rule bg-cream shadow-elev"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-3">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cx("rounded-cta p-1.5 text-ink hover:bg-bone", FOCUS_RING)}
          >
            <X className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </div>

        <div className="ws-scroll min-h-0 flex-1 px-4 py-3.5">
          <p className="text-[16px] leading-6 text-ink [overflow-wrap:anywhere]">
            {d.decision_class === "bulk_outbound.send"
              ? (bulkSendConsequence(d.body) ?? CLASS_CONSEQUENCE["bulk_outbound.send"]).approve
              : manual
                ? "This one is yours to do. Zavi cannot post here on your behalf yet, so it has done the part it can."
                : "Zavi will carry this out as soon as you approve it."}
          </p>

          {steps.length > 0 && (
            <ol className="mt-3.5 space-y-2.5">
              {steps.map((s, i) => (
                <li
                  key={`${i}-${s.title}`}
                  className="rounded-2xl border border-rule bg-white p-3.5"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-[13px] font-semibold text-inkMuted">
                      {stepPosition ? stepPosition.position : i + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[16px] font-semibold leading-6 text-ink [overflow-wrap:anywhere]">
                        {s.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {s.blocking && (
                          <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-medium text-cream">
                            Blocking
                          </span>
                        )}
                        {s.effort && (
                          <span className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-inkMuted">
                            {s.effort}
                          </span>
                        )}
                      </div>
                      {s.deliverable && (
                        <DeliverableBlock deliverable={s.deliverable} className="mt-2" />
                      )}
                      {s.body && (
                        <div className="mt-1.5 text-ink [overflow-wrap:anywhere] [&_p]:text-[16px] [&_li]:text-[16px] [&_p]:leading-6 [&_li]:leading-6">
                          <Markdown source={s.body} breaks disableActionLinks />
                        </div>
                      )}
                      {s.evidence.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {s.evidence.map((e, j) => (
                            <li
                              key={j}
                              className="text-[13px] leading-5 text-inkMuted [overflow-wrap:anywhere]"
                            >
                              {e}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {analysis &&
            (singleStep ? (
              <details className="mt-3.5 rounded-2xl border border-rule bg-white p-3.5">
                <summary
                  className={cx(
                    "cursor-pointer list-none text-[13px] font-medium text-inkMuted hover:text-ink",
                    FOCUS_RING,
                  )}
                >
                  Show the full audit for this run
                </summary>
                <div className="mt-2.5">
                  <Markdown source={analysis} disableActionLinks />
                </div>
              </details>
            ) : (
              <div className="mt-3.5 rounded-2xl border border-rule bg-white p-3.5">
                <Markdown source={analysis} disableActionLinks />
              </div>
            ))}

          {post && (
            <div className="mt-1.5">
              {onEditPost && <p className="mb-2 text-sm text-inkMuted">Edit the caption below. Your changes are sent only when you approve.</p>}
              <PostPreview
                channel={post.channel}
                payload={postEdit ? { ...post.payload, ...postEdit } : post.payload}
                onEdit={busy ? undefined : onEditPost}
                scheduledAt={d.body.scheduled_at}
                readiness={d.body.readiness}
              />
            </div>
          )}

          {artifact && (
            <div className="mt-3.5 rounded-2xl border border-rule bg-white p-3.5">
              <p className="whitespace-pre-wrap text-[16px] leading-6 text-ink [overflow-wrap:anywhere]">
                {artifact}
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={onOpenThread}
            className={cx(
              "mt-3.5 block text-[13px] font-medium text-inkMuted underline hover:text-ink",
              FOCUS_RING,
            )}
          >
            See how Zavi got here
          </button>

          {approveBlockedReason && <p role="alert" className="mt-3.5 text-sm text-coral">{approveBlockedReason}</p>}
          {error && (
            <p role="alert" className="mt-3.5 rounded-xl bg-dangerBg px-3 py-2.5 text-[12px] font-medium text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-rule px-3 py-3">
          {manual ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onNotNow}
                className={cx(PILL, "border border-rule bg-cream text-ink hover:bg-creamDeep", FOCUS_RING)}
              >
                Not now
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onDidntDoIt}
                className={cx(PILL, "border border-rule bg-cream text-ink hover:bg-creamDeep", FOCUS_RING)}
              >
                Didn&apos;t do it
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onDidIt}
                className={cx(PILL, "bg-ink text-cream hover:bg-inkSoft", FOCUS_RING)}
              >
                Did it
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onReject}
                className={cx(PILL, "border border-rule bg-cream text-ink hover:bg-creamDeep", FOCUS_RING)}
              >
                Reject
              </button>
              <button
                type="button"
                disabled={busy || !!approveBlockedReason}
                onClick={high ? onOpenThread : onApprove}
                className={cx(PILL, "bg-ink text-cream hover:bg-inkSoft", FOCUS_RING)}
              >
                {high ? "Review" : "Approve"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
