import type { SetupResponse, SetupState, StepStatus } from "./types";

export type SetupGate = "loading" | "active" | "inactive";

const canRun = (role: string | null | undefined) => role === "owner" || role === "admin";

export function isSetupLocked(s: SetupResponse | null | undefined, role: string | null | undefined): boolean {
  return !!s && s.enabled === true && !s.done && canRun(role);
}

export function setupGateOf(input: {
  role: string | null | undefined;
  data: SetupResponse | undefined;
  pending: boolean;
}): SetupGate {
  if (input.role === undefined) return "loading";
  if (!canRun(input.role)) return "inactive";
  if (input.data) return isSetupLocked(input.data, input.role) ? "active" : "inactive";
  return input.pending ? "loading" : "inactive";
}

export function stepStatuses(s: SetupState): [StepStatus, StepStatus, StepStatus] {
  return [s.docs.status, s.connectors.status, s.done ? "done" : "pending"];
}

export function currentStep(s: SetupState): 1 | 2 | 3 {
  const [s1, s2] = stepStatuses(s);
  if (s1 === "pending") return 1;
  if (s2 === "pending") return 2;
  return 3;
}

export function cookingView(s: SetupState): { pct: number; ready: boolean } {
  if (s.docs.status === "pending") return { pct: 20, ready: false };
  if (s.connectors.status === "pending") return { pct: 50, ready: false };
  if (s.draft.status === "none") return { pct: 90, ready: false };
  return { pct: 100, ready: s.draft.status === "done" };
}

export function strategyCardState(s: SetupResponse | null | undefined, canManage: boolean): "writing" | "ready" | "failed" | null {
  if (!canManage || !s || s.enabled !== true || !s.done || s.home_seen) return null;
  if (s.draft.status === "failed") return "failed";
  if (s.draft.status === "done") return s.has_plan === false ? null : "ready";
  return s.has_plan ? "ready" : "writing";
}

export function shouldAutoStartDraft(s: SetupState): boolean {
  return s.connectors.status !== "pending" && s.draft.status === "none";
}

export function staysDuringSetup(firstSegment: string | undefined, buildOpen: boolean): boolean {
  if (firstSegment === "growth-setup" || firstSegment === "invite" || firstSegment === "reset-password") return true;
  return buildOpen && firstSegment === "build";
}
