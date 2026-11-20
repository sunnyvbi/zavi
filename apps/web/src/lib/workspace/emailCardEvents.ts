import { announceChannelHistoryChanged } from "@/components/workspace/actions/useChannelHistory";

export const EMAIL_CARD_CHANGED_EVENT = "zavi:email-card-changed";
export const EMAIL_PLAN_CHANGED_EVENT = "zavi:email-plan-changed";

export type EmailCardChange = { rail: string; id: string; source: string };

export function announceEmailPlanChanged(source?: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<{ source?: string }>(EMAIL_PLAN_CHANGED_EVENT, { detail: { source } }));
}

export function onEmailPlanChanged(listener: (source: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (e: Event) => listener((e as CustomEvent<{ source?: string } | null>).detail?.source ?? null);
  window.addEventListener(EMAIL_PLAN_CHANGED_EVENT, handle);
  return () => window.removeEventListener(EMAIL_PLAN_CHANGED_EVENT, handle);
}

export function announceEmailCardChanged(change: EmailCardChange): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<EmailCardChange>(EMAIL_CARD_CHANGED_EVENT, { detail: change }));
  announceEmailPlanChanged(change.source);
  announceChannelHistoryChanged("email_marketing");
}

export function onEmailCardChanged(listener: (change: EmailCardChange) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (e: Event) => {
    const detail = (e as CustomEvent<EmailCardChange>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(EMAIL_CARD_CHANGED_EVENT, handle);
  return () => window.removeEventListener(EMAIL_CARD_CHANGED_EVENT, handle);
}
