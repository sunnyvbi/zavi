import type { ActionRedoState } from "../types";

export const REDO_LINE: Record<ActionRedoState, string> = {
  working: "Zavi is redoing this. The new version replaces this card when it lands.",
  no_replacement: "Nothing has replaced this yet. You can still work this card as it is.",
  failed: "Zavi could not finish this redo, so nothing replaced this card. Try Redo again, or work this card as it is.",
};

export function redoLine(state: ActionRedoState, note: string | null): string {
  if (state === "working" && note) return `Zavi is redoing this: ${note.charAt(0).toLowerCase()}${note.slice(1)}`;
  return REDO_LINE[state];
}
