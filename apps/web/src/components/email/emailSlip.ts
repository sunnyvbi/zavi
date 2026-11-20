
import type { SlipHero, SlipStage } from "@/components/agents/slip/decisionSlip";
import type { SlipStep } from "@/components/agents/slip/SlipParts";

export type EmailSlipCard = {
  open: boolean;
  status: string;
  route: string;
  list: { name: string; people: number | null };
  may_have_sent?: boolean;
  pause_hold?: "paused" | "resumed" | null;
  sent_count?: number | null;
  chosen_variant: number | null;
};

const SENDING = new Set(["dispatching", "sending", "waiting_for_tomorrow"]);
const FAILED = new Set(["failed", "dispatch_failed"]);

export function emailSlipStage(c: EmailSlipCard, o: { stalled: boolean; scheduled: boolean }): SlipStage {
  if (o.stalled || c.may_have_sent || c.status === "outcome_unknown") return "unknown";
  if (o.scheduled) return "queued";
  if (c.open) return "waiting";
  if (c.pause_hold === "paused" || c.status === "held") return "held";
  if (c.status === "approved" || c.status === "queued") return "queued";
  if (SENDING.has(c.status)) return "sending";
  if (c.status === "sent") return "done";
  if (c.status === "partially_sent") return "partial";
  if (FAILED.has(c.status)) return "failed";
  return "closed";
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function emailSlipHero(c: EmailSlipCard, stage: SlipStage, reach: (n: number) => number): SlipHero | null {
  const sent = typeof c.sent_count === "number" ? c.sent_count : null;
  if (stage === "done" || stage === "partial" || stage === "sending" || (stage === "closed" && sent !== null && sent > 0)) {
    if (sent === null) return null;
    const eyebrow = stage === "sending" ? "Sent so far" : "Sent to";
    return { eyebrow, amount: fmt(sent), unit: sent === 1 ? "person" : "people", was: null, before: fmt(sent), beforeUnit: null, chip: null };
  }
  if (stage === "failed" || stage === "unknown" || stage === "closed") return null;
  if (sent !== null && sent > 0) return { eyebrow: "Sent so far", amount: fmt(sent), unit: sent === 1 ? "person" : "people", was: null, before: fmt(sent), beforeUnit: null, chip: null };
  if (c.list.people === null) return null;
  const n = reach(c.list.people);
  return { eyebrow: "Audience", amount: fmt(n), unit: n === 1 ? "person" : "people", was: null, before: fmt(n), beforeUnit: null, chip: null };
}

export function emailSlipSteps(c: EmailSlipCard, stage: SlipStage, tool: string, inFlight: string): SlipStep[] {
  const label = `Sending via ${tool}`;
  const second: SlipStep =
    stage === "held"
      ? { label, sub: inFlight, state: "warn" }
      : stage === "queued"
        ? { label, sub: inFlight, state: "now" }
        : stage === "sending"
          ? { label, sub: inFlight, state: "now" }
          : stage === "unknown"
            ? { label, sub: "It may have gone out. Do not send it again yet.", state: "warn" }
            : stage === "failed"
              ? { label, sub: "Stopped with an error", state: "fail" }
              : stage === "partial"
                ? { label, sub: "Part of the list got it; the rest did not.", state: "warn" }
                : stage === "closed"
                  ? c.status === "stopped"
                    ? { label, sub: "You stopped the rest.", state: "done" }
                    : { label, sub: "Not sent.", state: "fail" }
                  : { label, sub: "Done", state: "done" };
  return [
    { label: "You approved", sub: null, state: "done" },
    second,
    { label: "Send complete", sub: stage === "done" ? null : stage === "sending" || stage === "queued" ? "Updates here by itself" : null, state: stage === "done" ? "done" : "todo" },
  ];
}

export const STALLED_WORD = "May have gone out";
