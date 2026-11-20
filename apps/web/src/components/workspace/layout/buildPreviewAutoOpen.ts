import { BUILD_SPLIT_MIN_PX } from "./buildSplit";

export type PreviewCloseReason = "user" | "surface";

export type PreviewDismissal = string | null | undefined;

export const NOTHING_DISMISSED: PreviewDismissal = undefined;

export function dismissalAfterClose(
  reason: PreviewCloseReason,
  sessionId: string | null,
  previous: PreviewDismissal,
): PreviewDismissal {
  return reason === "user" ? sessionId : previous;
}

export function dismissedForSession(
  dismissedFor: PreviewDismissal,
  sessionId: string | null,
): boolean {
  return dismissedFor !== NOTHING_DISMISSED && dismissedFor === sessionId;
}

export function shouldAutoOpenPreview(state: {
  hasProgress: boolean;
  splitWide: boolean;
  sessionId: string | null;
  dismissedFor: PreviewDismissal;
}): boolean {
  if (!state.hasProgress) return false;
  if (!state.splitWide) return false;
  return !dismissedForSession(state.dismissedFor, state.sessionId);
}

export const AUTO_OPEN_MIN_PX = BUILD_SPLIT_MIN_PX;

export function isAppWorkspaceTarget(
  target: { status: string; kind: string } | null | undefined,
): boolean {
  return !!target && (target.status === "live" || target.kind === "final");
}

export function shouldOpenTargetPreview(state: {
  splitWide: boolean;
  sessionId: string | null;
  dismissedFor: PreviewDismissal;
  openForSession: boolean;
}): boolean {
  if (state.openForSession) return true;
  if (!state.splitWide) return false;
  return !dismissedForSession(state.dismissedFor, state.sessionId);
}

export type AskForChangesPlan = {
  closePreview: boolean;
  expandChat: boolean;
};

export const ASK_FOR_CHANGES_PLAN: AskForChangesPlan = {
  closePreview: true,
  expandChat: true,
};

export function composerReachableAfter(
  before: { splitWide: boolean; chatCollapsed: boolean },
  plan: AskForChangesPlan,
): boolean {
  if (plan.closePreview) return true;
  if (!before.splitWide) return false;
  return !before.chatCollapsed || plan.expandChat;
}

export function buildPreviewStamp(
  target: { url: string; revision?: string } | null | undefined,
): string | null {
  return target ? `${target.url}@${target.revision ?? "initial"}` : null;
}

export function previewSteppedAside(
  hiddenAt: string | null,
  stamp: string | null,
): boolean {
  return hiddenAt !== null && hiddenAt === stamp;
}

export function contextAutoCollapseOnPreview(state: {
  previewOpen: boolean;
  contextHidden: boolean;
  previous: boolean;
}): boolean {
  if (!state.previewOpen) return false;
  if (state.contextHidden) return state.previous;
  return true;
}
