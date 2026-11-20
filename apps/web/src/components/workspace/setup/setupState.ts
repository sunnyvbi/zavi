
import { namesOf, type ReadSummary } from "./importReadState";

export type StepStatus = "pending" | "done" | "skipped";
export type SetupDraftStatus = "none" | "running" | "failed" | "done";

export type SetupState = {
  enabled: true;
  docs: { status: StepStatus; files: number; facts: number };
  connectors: { status: StepStatus };
  done: boolean;
  home_seen: boolean;
  has_plan?: boolean;
  draft: { phase?: "writing" | "checking" | "saving"; save_retry?: boolean; status: SetupDraftStatus; run_id: string | null; attempts: number; can_retry: boolean; free_retry: boolean };
  build_open?: boolean;
  coding_prompt_tucked?: boolean;
  one_state?: boolean;
  skip_no_confirm?: boolean;
  from_scratch?: boolean;
};
export type SetupResponse = SetupState | { enabled: false };

export function isSetupLocked(s: SetupResponse | null, role: string | null | undefined): boolean {
  return !!s && s.enabled === true && !s.done && (role === "owner" || role === "admin");
}

export function isStaleSetup(prev: SetupResponse | null, next: SetupResponse): boolean {
  if (!prev || prev.enabled !== true || next.enabled !== true) return false;
  return (
    (prev.done && !next.done) ||
    (prev.home_seen && !next.home_seen) ||
    (prev.docs.status !== "pending" && next.docs.status === "pending") ||
    (prev.connectors.status !== "pending" && next.connectors.status === "pending")
  );
}

export const SETUP_EXPECTED_KEY = "zavi.setup.expected";

export function markSetupExpected(): void {
  try {
    window.sessionStorage.setItem(SETUP_EXPECTED_KEY, "1");
  } catch {
    return;
  }
}

export function readSetupExpected(): boolean {
  try {
    return window.sessionStorage.getItem(SETUP_EXPECTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSetupExpected(): void {
  try {
    window.sessionStorage.removeItem(SETUP_EXPECTED_KEY);
  } catch {
    return;
  }
}

export type StrategyCardState = "writing" | "ready" | "failed";

export function strategyCardState(s: SetupResponse | null, canManage: boolean, startFailed = false): StrategyCardState | null {
  if (!canManage || !s || s.enabled !== true || !s.done || s.home_seen) return null;
  const status: SetupDraftStatus = s.draft.status;
  if (status === "failed") return "failed";
  if (status === "done") return s.has_plan === false ? null : "ready";
  if (s.has_plan) return "ready";
  if (status === "none" && startFailed) return "failed";
  return "writing";
}

export function isBuildOpen(s: SetupResponse | null): boolean {
  return !!s && s.enabled === true && s.build_open === true;
}

export type CookingView = { pct: number; ready: boolean; waiting: boolean; sub: string | null };

export function cookingView(s: SetupState, reads: ReadSummary): CookingView {
  const readingName = reads.reading.length ? namesOf(reads.reading) : null;
  const from = reads.facts > 0 ? `${reads.facts} facts from ${namesOf(reads.done)}, your website and your details` : "your website and your details";
  if (s.docs.status === "pending") {
    return { pct: 20, ready: false, waiting: false, sub: readingName ? `Reading ${readingName} in the background.` : null };
  }
  if (s.connectors.status === "pending") {
    const sub = readingName
      ? `Reading ${readingName} in the background.`
      : reads.done.length
        ? `Read ${namesOf(reads.done)}: ${reads.facts} facts.`
        : reads.failed.length && !reads.stored.length
          ? `Couldn't read ${namesOf(reads.failed)}. Using your website.`
          : null;
    return { pct: 50, ready: false, waiting: false, sub };
  }
  if (s.draft.status === "none") {
    return readingName
      ? { pct: 90, ready: false, waiting: true, sub: `Reading ${readingName}. The draft starts the moment it's done.` }
      : { pct: 90, ready: false, waiting: false, sub: null };
  }
  if (s.draft.status === "done") return { pct: 100, ready: true, waiting: false, sub: `Built from ${from}.` };
  return { pct: 100, ready: false, waiting: false, sub: `Writing the draft from ${from}.` };
}

export function finishedSteps(s: SetupState): number {
  return (
    (s.docs.status !== "pending" ? 1 : 0) +
    (s.connectors.status !== "pending" ? 1 : 0) +
    (s.done ? 1 : 0)
  );
}
