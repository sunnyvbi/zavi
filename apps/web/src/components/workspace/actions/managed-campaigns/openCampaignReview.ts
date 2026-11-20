const open = new Map<string, Record<string, unknown>>();

export function openCampaignReview(actionId: string) {
  if (!open.has(actionId)) open.set(actionId, {});
}

export function isCampaignReviewOpen(actionId: string): boolean {
  return open.has(actionId);
}

export function closeCampaignReview(actionId: string) {
  open.delete(actionId);
}

export function campaignReviewDraft<T extends object>(actionId: string): Partial<T> {
  return { ...(open.get(actionId) ?? {}) } as Partial<T>;
}

export function saveCampaignReviewDraft<T extends object>(actionId: string, draft: T) {
  if (open.has(actionId)) open.set(actionId, { ...draft } as Record<string, unknown>);
}
