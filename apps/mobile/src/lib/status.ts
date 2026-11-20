import type { AgentRunStatus as TerminalRunStatus } from "@zavi/shared";

export type RunStatus =
  | "queued"
  | "running"
  | "failed"
  | "cancelled"
  | TerminalRunStatus;

const TERMINAL: ReadonlySet<string> = new Set([
  "success",
  "parse_failed",
  "dispatch_error",
  "failed",
  "cancelled",
]);

export function isTerminal(status: string | null | undefined): boolean {
  return !!status && TERMINAL.has(status);
}

export function isSettled(run: { status?: string | null } | null | undefined): boolean {
  return (
    run?.status === "paused_awaiting_approval" ||
    run?.status === "paused_awaiting_child" ||
    isTerminal(run?.status)
  );
}

export function isInFlight(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

export function isFailure(status: string | null | undefined): boolean {
  return status === "parse_failed" || status === "dispatch_error";
}
