

const CLARIFY_SIGNAL_RE =
  /"clarifications_needed"\s*:\s*\{[^{}]{0,400}"questions"\s*:\s*\[\s*"[^"\\]/;

const CLARIFY_NATIVE_ENVELOPE_RE =
  /"envelope_kind"\s*:\s*"clarifying_questions"/;

export function detectClarifyInPlannerText(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (CLARIFY_SIGNAL_RE.test(text)) return true;
  if (CLARIFY_NATIVE_ENVELOPE_RE.test(text)) return true;
  return false;
}

const SIDE_EFFECTING_TOOL_RE =
  /(?:create_pr|open_pr|pull_request|__commit|gmail__send|slack__|__post|__send|create_issue|create_ticket|emit_decision|deploy|praxis__action|praxis__handoff)/i;

export function hasSideEffectingToolUse(
  toolNames: readonly (string | null | undefined)[],
): boolean {
  for (const n of toolNames) {
    if (typeof n === "string" && n.length > 0 && SIDE_EFFECTING_TOOL_RE.test(n)) {
      return true;
    }
  }
  return false;
}

export type ClarifyGateDecision =
  | { short_circuit: false }
  | {
      short_circuit: true;
      reason: "clarify_before_side_effect" | "clarify_before_chain";
    };

export function decideClarifyGate(args: {
  planner_text: string | null | undefined;
  pending_tool_names: readonly (string | null | undefined)[];
}): ClarifyGateDecision {
  const hasSignal = detectClarifyInPlannerText(args.planner_text);
  if (!hasSignal) return { short_circuit: false };
  const sideEffect = hasSideEffectingToolUse(args.pending_tool_names);
  if (sideEffect) {
    return { short_circuit: true, reason: "clarify_before_side_effect" };
  }
  if (args.pending_tool_names.length === 0) {
    return { short_circuit: true, reason: "clarify_before_chain" };
  }
  return { short_circuit: false };
}
