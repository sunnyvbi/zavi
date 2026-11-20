import { useCallback, useReducer } from "react";

export type CardFlow =
  | { s: "idle" }
  | { s: "working" }
  | { s: "confirming"; copied: boolean }
  | { s: "resolved"; tone: "success" | "muted"; label: string; undo: boolean; moving?: boolean; closing?: boolean; away?: boolean };

export type CardFlowEvent =
  | { t: "start" }
  | { t: "fail" }
  | { t: "await"; copied?: boolean }
  | { t: "back" }
  | { t: "resolve"; tone: "success" | "muted"; label: string; undo: boolean; moving?: boolean; closing?: boolean; away?: boolean }
  | { t: "undo" };

export function cardFlowReducer(state: CardFlow, e: CardFlowEvent): CardFlow {
  switch (e.t) {
    case "start":
      return { s: "working" };
    case "fail":
    case "back":
    case "undo":
      return { s: "idle" };
    case "await":
      return { s: "confirming", copied: e.copied === true };
    case "resolve":
      return { s: "resolved", tone: e.tone, label: e.label, undo: e.undo, ...(e.moving ? { moving: true } : {}), ...(e.closing ? { closing: true } : {}), ...(e.away ? { away: true } : {}) };
  }
}

export function useCardFlow() {
  const [flow, dispatch] = useReducer(cardFlowReducer, { s: "idle" } as CardFlow);
  const send = useCallback((e: CardFlowEvent) => dispatch(e), []);
  return { flow, send };
}
