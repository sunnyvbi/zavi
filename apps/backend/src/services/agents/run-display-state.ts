
export type RunDisplayState = "answered" | "failed" | "running" | "cancelled";

export type DisplayStateInput = {
  status: string | null | undefined;
  outcome?: { deliverable?: string | null } | null;
  outputText?: string | null;
};

const NON_TERMINAL = new Set(["queued", "running", "dispatching", "claimed"]);

function hasText(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

export function runHasDeliverable(input: DisplayStateInput): boolean {
  if (input.status === "success") return true;
  if (hasText(input.outcome?.deliverable)) return true;
  if (!input.outcome && hasText(input.outputText)) return true;
  return false;
}

export function classifyRun(input: DisplayStateInput): {
  displayState: RunDisplayState;
  hasDeliverable: boolean;
} {
  const status = input.status ?? "";
  if (NON_TERMINAL.has(status)) return { displayState: "running", hasDeliverable: false };
  if (status === "cancelled") return { displayState: "cancelled", hasDeliverable: false };
  const hasDeliverable = runHasDeliverable(input);
  return { displayState: hasDeliverable ? "answered" : "failed", hasDeliverable };
}

export function presentationStatus(input: DisplayStateInput): RunDisplayState {
  return classifyRun(input).displayState;
}
