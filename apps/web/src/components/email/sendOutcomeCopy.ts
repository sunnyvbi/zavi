export const sendPeople = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;

export const stoppedAfter = (n: number | null) => `Stopped after ${n !== null ? sendPeople(n) : "part of the list"}`;

export const STOPPED_REST_LINE = "The rest were not sent.";

export const DELIVERY_UNKNOWN = "Delivery unknown";

export type OutcomeWord = { word: string; tone: "ok" | "wait" | "bad" | "muted" };

const SETTLED_WORDS: Record<string, OutcomeWord> = {
  held: { word: "On hold", tone: "wait" },
  dispatching: { word: "Sending", tone: "wait" },
  sending: { word: "Sending", tone: "wait" },
  waiting_for_tomorrow: { word: "Sending, more tomorrow", tone: "wait" },
  sent: { word: "Sent", tone: "ok" },
  partially_sent: { word: "Partly sent", tone: "bad" },
  outcome_unknown: { word: DELIVERY_UNKNOWN, tone: "bad" },
  stopped: { word: "Stopped", tone: "bad" },
  failed: { word: "Failed", tone: "bad" },
  dispatch_failed: { word: "Failed", tone: "bad" },
  not_sent: { word: "Not sent", tone: "bad" },
  rejected: { word: "Rejected", tone: "muted" },
};

export function outcomeWord(o: { status: string; may_have_sent: boolean; pause_hold?: "paused" | "resumed" | null }): OutcomeWord | null {
  if (o.pause_hold === "paused") return { word: "Email paused", tone: "wait" };
  const settled = SETTLED_WORDS[o.status] ?? null;
  if (o.may_have_sent && (settled === null || settled.tone !== "wait")) return { word: DELIVERY_UNKNOWN, tone: "bad" };
  return settled;
}
