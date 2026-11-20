import { extractPlanBlock } from "./plan-emit";
import type { OperatorTierPreCheckState } from "./operator-policy";

export function makeOperatorTurnLatch(state: OperatorTierPreCheckState) {
  return (t: { text: string }): void => {
    if (!t.text) return;
    state.iter += 1;
    const parsed = extractPlanBlock(t.text);
    if (parsed?.classify) state.currentClassify = parsed.classify;
  };
}

export function wireAltFunnelOperatorGate<P, S>(args: {
  gateRequired: boolean;
  engineHonorsTurnHook: boolean;
  state: OperatorTierPreCheckState | null;
  operatorPreCheck: P | undefined;
  operatorSettle: S | undefined;
}): {
  operatorPreCheck?: P;
  operatorSettle?: S;
  onAssistantTurn?: (t: { text: string }) => void;
} {
  if (!args.gateRequired) return {};
  if (!args.engineHonorsTurnHook || !args.state || !args.operatorPreCheck || !args.operatorSettle) {
    throw new Error("staff_model: operator gate could not be wired on the alt funnel; refusing run");
  }
  return {
    operatorPreCheck: args.operatorPreCheck,
    operatorSettle: args.operatorSettle,
    onAssistantTurn: makeOperatorTurnLatch(args.state),
  };
}
