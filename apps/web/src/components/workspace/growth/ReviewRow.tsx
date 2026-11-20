"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { adChangeHeadline } from "@zavi/shared";
import { decisionTitle, dispatchCardHeadline, handlerPreview, isAcknowledgeOnly, needsActionText } from "@/app/approvals/approvalsHelpers";

export const BTN_DARK =
  "inline-flex h-8 items-center rounded-cta bg-ink px-3 text-[13px] font-semibold text-cream hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
export const BTN =
  "inline-flex h-8 items-center rounded-cta border border-rule bg-cream px-3 text-[13px] font-semibold text-ink hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-50";
export const CHIP = "rounded-full bg-creamDeep px-2 py-0.5 text-[12px] font-semibold text-inkMuted";

type ReviewDecisionInput = { decision_class: string; handler: string | null; body: Record<string, unknown> };

export function reviewDecisionText(d: ReviewDecisionInput): { title: string; why: string; agent: string } {
  const { agentLabel, verbLabel } = decisionTitle(d.decision_class, d.body);
  if (d.handler === "pm.needs_action") return { ...needsActionText(d.body), agent: agentLabel };
  const dispatch = d.handler === "praxis.dispatch_specialist" ? dispatchCardHeadline(d.body) : null;
  if (dispatch) return { title: dispatch.headline, why: `Hands off to ${dispatch.targetLabel}`, agent: agentLabel };
  const adTitle = adChangeHeadline(d.decision_class, d.body);
  const preview = adTitle ?? (handlerPreview(d.handler, d.body) ?? "").replace(/^[\s→·–—-]+/, "");
  const rawRationale = (d.body as { rationale?: unknown }).rationale;
  const rationale = typeof rawRationale === "string" ? rawRationale.trim() : "";
  const title = preview || rationale || verbLabel || agentLabel;
  const why = preview && rationale && rationale !== preview ? rationale : "";
  return { title, why, agent: agentLabel };
}

export function decisionButtonLabels(d: { handler: string | null; body: Record<string, unknown> | null }): {
  approve: string;
  reject: string | null;
} {
  const body = d.body ?? {};
  if (isAcknowledgeOnly(d.handler, body)) return { approve: "Got it", reject: null };
  if (d.handler === "pm.needs_action") return { approve: "Retry fix", reject: "Drop it" };
  return { approve: "Approve", reject: "Reject" };
}

export function rowWaiting(d: { handler: string | null; body: Record<string, unknown> | null; status?: string | null }): boolean {
  if (d.status && d.status !== "proposed") return false;
  return !isAcknowledgeOnly(d.handler, d.body ?? {});
}

export function decisionChip(agent: string, d: { handler: string | null; body: Record<string, unknown> | null }): string {
  const chip = isAcknowledgeOnly(d.handler, d.body ?? {}) ? "Heads-up" : "You approve";
  return agent ? `${agent} · ${chip}` : chip;
}

export function ReviewRow({
  icon,
  title,
  why,
  chip,
  open,
  onToggle,
  buttons,
  detail,
  error,
  waiting = false,
}: {
  waiting?: boolean;
  icon: ReactNode;
  title: string;
  why: string;
  chip: string | null;
  open: boolean;
  onToggle: () => void;
  buttons: ReactNode;
  detail: ReactNode;
  error: ReactNode;
}) {
  return (
    <div data-testid="review-row" data-waiting={waiting ? "true" : undefined} className={cn("border-t border-rule first:border-t-0", waiting && "shadow-[inset_3px_0_0_#e8c46a]")}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center">{icon}</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="group min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className={cn("block text-[14px] font-medium leading-5 text-ink underline-offset-2 group-hover:underline", !open && "line-clamp-2")}>
            {title}
          </span>
          {why && (
            <span className={cn("mt-0.5 block text-[13px] leading-[18px] text-inkMuted", !open && "line-clamp-1")}>
              {why}
            </span>
          )}
          {chip && <span className={cn(CHIP, "mt-1.5 inline-block")}>{chip}</span>}
        </button>
        <div className="flex shrink-0 items-center gap-2">{buttons}</div>
      </div>
      {open && <div className="px-4 pb-4 pl-14">{detail}</div>}
      {error}
    </div>
  );
}
