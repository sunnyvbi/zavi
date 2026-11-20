
export const FIRST_DRAFT_MESSAGE = "zavi:first-draft";
export const FIRST_DRAFT_SILENCE_MS = 5000;

export function firstDraftShownMessage(data: unknown, origin: string, expectedOrigin: string): boolean | null {
  if (origin !== expectedOrigin || !data || typeof data !== "object") return null;
  const d = data as { type?: unknown; shown?: unknown };
  if (d.type !== FIRST_DRAFT_MESSAGE || typeof d.shown !== "boolean") return null;
  return d.shown;
}
