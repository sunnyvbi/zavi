import type { ActionItem } from "../types";

const INTENT_WORD: Record<string, string> = {
  fix_setup: "Fix",
  improve: "Improve results",
  create: "Create",
  reach_out: "Reach out",
  review: "Review",
  answer: "Question",
};

const TYPE_WORD: Record<string, string> = {
  text_post: "Create",
  image_post: "Create",
  video_post: "Create",
  reply: "Create",
  page: "Create",
  send_message: "Reach out",
  fix: "Fix",
  setup: "Fix",
  check: "Review",
};

export function isBrief(a: ActionItem): boolean {
  return a.body?.step?.deliverable?.kind === "brief";
}

export function eyebrowKind(a: ActionItem): string {
  if (a.card_kind === "plan") return "Plan";
  if (isBrief(a)) return "Brief";
  const intent = a.body?.intent ?? a.body?.step?.intent;
  if (typeof intent === "string" && INTENT_WORD[intent]) return INTENT_WORD[intent];
  return TYPE_WORD[a.action_type] ?? (a.card_kind === "message" ? "Reach out" : a.card_kind === "copy_to_site" ? "Improve results" : "To do");
}

export function blockingChip(a: ActionItem): string | null {
  return a.blocking && a.status === "pending" ? "Do this first" : null;
}
