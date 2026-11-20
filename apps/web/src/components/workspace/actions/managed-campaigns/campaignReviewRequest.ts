import { useSyncExternalStore } from "react";

let pending: string | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export function requestCampaignReview(actionId: string) {
  pending = actionId;
  notify();
}

export function pendingCampaignReview(): string | null {
  return pending;
}

export function clearCampaignReview(actionId: string) {
  if (pending !== actionId) return;
  pending = null;
  notify();
}

export function subscribeCampaignReview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingCampaignReview(): string | null {
  return useSyncExternalStore(subscribeCampaignReview, pendingCampaignReview, () => null);
}
