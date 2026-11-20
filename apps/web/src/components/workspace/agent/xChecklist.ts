import { checklistOrder, type CheckState } from "../actions/checklist";
import type { XChecklistSignal, XPayload } from "./XAgentDashboard";

export type XCheckFix = { label: string; title: string; href?: string; chatDraft?: string };
export type XCheckItem = { key: string; label: string; note: string; state: CheckState; fix: XCheckFix | null };

const TODO_LABEL: Partial<Record<XChecklistSignal["key"], string>> = {
  cadence: "Post at least 3 times a week",
  reply_rate: "Reply to at least half the replies you get",
};

const stateOf = (s: XChecklistSignal): CheckState => (s.status === "fix" ? "fail" : s.status === "unknown" ? "unknown" : "pass");

function fixFor(s: XChecklistSignal, label: string): XCheckFix {
  if (s.link) return { label: "Fix on X", href: s.link, title: `Open X to fix: ${label}` };
  return {
    label: "Fix with Zavi",
    title: `Ask Zavi to help fix: ${label}`,
    chatDraft: `Help me fix this on my X profile: ${label}. Right now: ${s.note}. Tell me exactly what to do, and draft it for me.`,
  };
}

export function xChecklistItems(checklist: XPayload["checklist"]): XCheckItem[] {
  return checklistOrder(checklist?.signals ?? [], stateOf).map(({ item: s }) => {
    const state = stateOf(s);
    const label = (state === "fail" && TODO_LABEL[s.key]) || s.label;
    return { key: s.key, label, note: s.note, state, fix: state === "fail" ? fixFor(s, label) : null };
  });
}
