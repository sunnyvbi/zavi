import type { SetupState, StepStatus } from "./setupState";
export function stepStatuses(
  s: SetupState,
): [StepStatus, StepStatus, StepStatus] {
  return [s.docs.status, s.connectors.status, s.done ? "done" : "pending"];
}
export function currentStep(s: SetupState): 1 | 2 | 3 {
  const [s1, s2] = stepStatuses(s);
  if (s1 === "pending") return 1;
  if (s2 === "pending") return 2;
  return 3;
}
