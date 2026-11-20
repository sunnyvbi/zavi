import type { BuildPreviewRestartState } from "./buildPreviewRestart";

export type PreviewFrame = { url: string | null; revision: string | null; cacheKey: string | null };

export type PreviewHold = { sessionId: string | null; url: string; revision: string | null; cacheKey: string | null };

export type HeldPreviewFrame = PreviewFrame & { updating: boolean; hold: PreviewHold | null };

export function heldPreviewFrame(input: {
  held: PreviewHold | null;
  sessionId: string | null;
  eligible: boolean;
  frame: PreviewFrame;
  changing: boolean;
  previewState: BuildPreviewRestartState | null | undefined;
}): HeldPreviewFrame {
  const { frame } = input;
  if (!input.eligible) return { ...frame, updating: false, hold: null };
  const held = input.held && input.held.sessionId === input.sessionId ? input.held : null;
  if (held && (input.changing || (frame.url === null && input.previewState === "starting"))) {
    return { url: held.url, revision: held.revision, cacheKey: held.cacheKey, updating: true, hold: held };
  }
  return {
    ...frame,
    updating: false,
    hold: frame.url ? { sessionId: input.sessionId, url: frame.url, revision: frame.revision, cacheKey: frame.cacheKey } : null,
  };
}

export function samePreviewHold(a: PreviewHold | null, b: PreviewHold | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sessionId === b.sessionId && a.url === b.url && a.revision === b.revision && a.cacheKey === b.cacheKey;
}
