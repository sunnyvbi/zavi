
export const PREVIEW_RENDER_MESSAGE = "zavi:preview-render";
export const PREVIEW_RENDER_HELLO = "zavi:preview-render-hello";

export type PreviewRenderState = "pending" | "rendered" | "failed" | "empty" | "errored";

const STATES: ReadonlySet<string> = new Set(["pending", "rendered", "failed", "empty", "errored"]);

export function previewRenderMessage(data: unknown, origin: string, expectedOrigin: string): PreviewRenderState | null {
  if (origin !== expectedOrigin || !data || typeof data !== "object") return null;
  const d = data as { type?: unknown; state?: unknown };
  if (d.type !== PREVIEW_RENDER_MESSAGE || typeof d.state !== "string" || !STATES.has(d.state)) return null;
  return d.state as PreviewRenderState;
}

export const PREVIEW_RENDER_RELOAD_MS: readonly number[] = [1_500, 3_000, 5_000, 8_000, 12_000, 20_000, 30_000, 30_000, 30_000, 30_000];
export const PREVIEW_RENDER_STUCK_MS = 25_000;

export const PREVIEW_RENDER_EMPTY_RELOADS = 1;

export function awaitingPreviewRender(state: PreviewRenderState | null, at: { building: boolean; reloads: number }): boolean {
  if (state === "pending" || state === "failed") return true;
  if (state === "empty") return at.reloads < PREVIEW_RENDER_EMPTY_RELOADS;
  if (state === "errored") return at.building;
  return false;
}

export function previewRenderReloadDelay(state: PreviewRenderState | null, reloads: number): number | null {
  if (reloads >= PREVIEW_RENDER_RELOAD_MS.length) return null;
  if (state === "pending") return PREVIEW_RENDER_STUCK_MS;
  if (state === "failed") return PREVIEW_RENDER_RELOAD_MS[reloads]!;
  if (state === "empty") return reloads < PREVIEW_RENDER_EMPTY_RELOADS ? PREVIEW_RENDER_RELOAD_MS[reloads]! : null;
  return null;
}

export function previewRenderGaveUp(state: PreviewRenderState | null, reloads: number): boolean {
  return (state === "pending" || state === "failed") && reloads >= PREVIEW_RENDER_RELOAD_MS.length;
}

export const PREVIEW_RENDER_GAVE_UP =
  "Your preview didn't finish loading. Zavi may still be starting it. Try again, or open it in a new tab.";
