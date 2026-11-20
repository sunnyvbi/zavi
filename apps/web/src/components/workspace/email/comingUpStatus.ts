import type { CardOutcome, PlanStatus, PlannedEmail } from "@/lib/workspace/emailPlanApi";
import { outcomeWord, type OutcomeWord } from "@/components/email/sendOutcomeCopy";
import type { ChipTone } from "./EmailWorkDesign";

export const ITEM_CHIP: Record<PlanStatus, [string, ChipTone]> = {
  planned: ["Planned", "muted"],
  drafting: ["Drafting", "muted"],
  ready: ["Needs approval", "wait"],
  scheduled: ["Approved", "done"],
  sending: ["Sending", "done"],
  reconciling: ["Checking", "muted"],
  sent: ["Sent", "done"],
  skipped: ["Skipped", "muted"],
  blocked: ["Blocked", "block"],
};

const TONE_OF: Record<OutcomeWord["tone"], ChipTone> = { ok: "done", wait: "wait", bad: "block", muted: "muted" };

export const SENDER_UNAVAILABLE_LINE =
  "Zavi's own sender is stopped right now, so Zavi is not planning emails. Nothing is wrong with your list. Drafts wait until the sender is back.";

export type ComingUpStatus = { label: string; tone: ChipTone; sent: boolean; fromCard: boolean; reason: string | null };

export function cardOutcomeStatus(o: CardOutcome | null | undefined): ComingUpStatus | null {
  if (!o) return null;
  const w = outcomeWord(o);
  if (!w) return null;
  const sent = o.status === "sent" && !o.may_have_sent && o.pause_hold !== "paused";
  return { label: w.word, tone: TONE_OF[w.tone], sent, fromCard: true, reason: sent ? null : o.reason };
}

export function shownPlanStatus(it: Pick<PlannedEmail, "status" | "card_status" | "card">): PlanStatus {
  if (it.status !== "sent" || !it.card) return it.status;
  return it.card_status ? "sending" : "reconciling";
}

export function comingUpStatus(it: Pick<PlannedEmail, "status" | "card_status" | "card">): ComingUpStatus {
  const fromCard = cardOutcomeStatus(it.card_status);
  if (fromCard) return fromCard;
  const status = shownPlanStatus(it);
  const [label, tone] = ITEM_CHIP[status];
  return { label, tone, sent: status === "sent", fromCard: false, reason: null };
}
