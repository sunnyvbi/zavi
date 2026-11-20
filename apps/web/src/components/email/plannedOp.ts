
import type { PlannedOnCard } from "./EmailCampaignCard";

export type PlanOpKind = "schedule" | "withdraw";
export type PlanOpAnswer = { ok: true; replayed?: boolean; status?: string } | { refused: string };
export type PlanOp = {
  kind: PlanOpKind;
  requestId: string | null;
  answer?: PlanOpAnswer;
  resolved?: boolean;
  intent?: { variant: number; schedule_gen: number; content_version: number };
};

export function sameIntent(op: PlanOp, kind: PlanOpKind, intent: PlanOp["intent"]): boolean {
  if (op.kind !== kind) return false;
  if (kind !== "schedule") return true;
  return !!op.intent && !!intent && op.intent.variant === intent.variant && op.intent.schedule_gen === intent.schedule_gen && op.intent.content_version === intent.content_version;
}
export type PlanRead = PlannedOnCard | null | "failed" | undefined;
export type PlanNotice = { tone: "ok" | "error"; title: string; body?: string; refresh?: boolean };

export const DONT_SEND_LINE = "The draft waits. Approve it for the planned time, or send it now.";
export const PLANNED_STOP_LINE = "You can stop it with Don't send until then. Once it starts sending it can't be stopped.";

const STARTED = new Set(["sending", "sent", "reconciling"]);
const MOVED_ON = new Set(["skipped", "blocked", "planned", "drafting"]);

const plan = (r: PlanRead): PlannedOnCard | null => (r && r !== "failed" ? r : null);
const confirmedBy = (a: PlanOpAnswer | undefined): boolean => !!a && "ok" in a && a.replayed === false;
const refusal = (a: PlanOpAnswer | undefined): string | null => (a && "refused" in a ? a.refused : null);

const letter = (n: number) => String.fromCharCode(64 + n);

export function withPlanOpAnswer<T extends PlanOp & { startSeq: number }>(op: T | null, kind: PlanOpKind, startSeq: number, answer: PlanOpAnswer): T | null {
  return op && op.kind === kind && op.startSeq === startSeq ? { ...op, answer } : op;
}

function planMovedOn(op: PlanOp, p: PlannedOnCard): boolean {
  return !!op.intent && (p.schedule_gen > op.intent.schedule_gen || p.content_version > op.intent.content_version);
}

function scheduledAsAsked(op: PlanOp, p: PlannedOnCard): boolean {
  if (p.status !== "scheduled" || !p.scheduled) return false;
  if (!op.intent) return true;
  return p.scheduled.variant === op.intent.variant && p.schedule_gen === op.intent.schedule_gen && p.content_version === op.intent.content_version;
}

export function planOpResolved(op: PlanOp | null, read: PlanRead): boolean {
  if (!op) return true;
  if (op.resolved || refusal(op.answer) !== null) return true;
  const p = plan(read);
  if (!p) return false;
  if (STARTED.has(p.status) || MOVED_ON.has(p.status)) return true;
  const answered = !!op.answer && "ok" in op.answer;
  if (op.kind === "schedule") {
    if (scheduledAsAsked(op, p)) return true;
    if (planMovedOn(op, p)) return true;
    if (p.status === "scheduled") return false;
    if (p.status === "ready" && p.vetoed) return answered || (!!op.intent && p.schedule_gen > op.intent.schedule_gen);
    return answered && p.status === "ready";
  }
  if (p.status === "ready" && p.vetoed) return true;
  return answered && p.status === "scheduled";
}

export function planOpNotice(op: PlanOp | null, read: PlanRead): PlanNotice | null {
  if (!op) return null;
  const refused = refusal(op.answer);
  if (refused !== null) return { tone: "error", title: op.kind === "schedule" ? "Not approved" : "Could not stop it", body: refused };
  if (read === undefined) return null;
  const p = plan(read);
  const answered = !!op.answer && "ok" in op.answer;
  const confirmed = op.kind === "schedule" ? confirmedBy(op.answer) : answered;
  const otherVariant = !!p?.scheduled && !!op.intent && p.scheduled.variant !== op.intent.variant;
  return op.kind === "schedule"
    ? scheduleNotice(p, confirmed, answered, !!p && planMovedOn(op, p), !!p && scheduledAsAsked(op, p), otherVariant)
    : stopNotice(p, confirmed, answered);
}

const UNKNOWN_APPROVAL: PlanNotice = {
  tone: "error",
  title: "Approval status unknown",
  body: "Zavi could not confirm whether this is approved for its time. Refresh to see where it stands. Approving again is the same request, so it cannot be approved twice.",
  refresh: true,
};
const UNKNOWN_STOP: PlanNotice = {
  tone: "error",
  title: "Not sure it was stopped",
  body: "Zavi could not confirm whether this was stopped. Refresh to see where it stands.",
  refresh: true,
};

function scheduleNotice(
  p: PlannedOnCard | null,
  confirmed: boolean,
  answered: boolean,
  movedOn: boolean,
  asAsked: boolean,
  otherVariant: boolean,
): PlanNotice {
  if (!p) {
    return confirmed
      ? { tone: "ok", title: "Zavi accepted the approval. Checking…", body: "This card has not shown it yet. Refresh if it does not update.", refresh: true }
      : UNKNOWN_APPROVAL;
  }
  if (p.status === "scheduled" && p.scheduled) {
    if (asAsked) return { tone: "ok", title: `Approved ${letter(p.scheduled.variant)} for ${p.planned_label}`, body: PLANNED_STOP_LINE };
    if (movedOn) return { tone: "error", title: "The plan changed", body: "This email changed since that approval was sent. Check its approval and time." };
    return UNKNOWN_APPROVAL;
  }
  if (STARTED.has(p.status)) {
    const where = p.status === "sent" ? "It went out at its planned time." : p.status === "sending" ? "It is sending now." : "Zavi is checking whether it went out.";
    if (movedOn || otherVariant) return { tone: "error", title: "The plan changed", body: `${where} It is not what this approval asked for.` };
    return { tone: "ok", title: "It has already started sending", body: where };
  }
  if (p.status === "skipped" || p.status === "blocked") return { tone: "error", title: "Not approved for its time", body: p.reason ?? undefined };
  if (p.status === "planned" || p.status === "drafting") return { tone: "error", title: "The plan changed", body: "Zavi is drafting a new version. Approve that one when it is ready." };
  if (p.status === "ready" && p.vetoed) {
    if (!answered && !movedOn) return UNKNOWN_APPROVAL;
    return { tone: "error", title: "Stopped with Don't send", body: "It is not approved for its time. Approve it again to send it then." };
  }
  if (movedOn) return { tone: "error", title: "The plan changed", body: "This email changed since that approval was sent. Approve it again to send it then." };
  if (!answered) return UNKNOWN_APPROVAL;
  return {
    tone: "error",
    title: "Not approved",
    body: confirmed
      ? "Zavi accepted the approval, but this email no longer shows it. Approve it again to send it then."
      : "It is not approved for its time now. Approve it again to send it then.",
  };
}

function stopNotice(p: PlannedOnCard | null, confirmed: boolean, answered: boolean): PlanNotice {
  if (!p) {
    return confirmed
      ? { tone: "ok", title: "Zavi accepted the stop. Checking…", body: "This card has not shown it yet. Refresh if it does not update.", refresh: true }
      : UNKNOWN_STOP;
  }
  if (p.status === "ready" && p.vetoed) return { tone: "ok", title: "Not sending", body: DONT_SEND_LINE };
  if (STARTED.has(p.status)) return { tone: "error", title: "It had already started", body: "It could not be stopped." };
  if (MOVED_ON.has(p.status)) return { tone: "ok", title: "Not sending at its time", body: p.reason ?? undefined };
  if (p.status === "scheduled" && answered) {
    return {
      tone: "error",
      title: "Still approved for its time",
      body: confirmed ? "Zavi accepted the stop, but this email shows it approved again. Press Don't send again to stop it." : "Press Don't send again to stop it.",
      refresh: true,
    };
  }
  return UNKNOWN_STOP;
}
