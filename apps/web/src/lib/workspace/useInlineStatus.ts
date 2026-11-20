"use client";

import { useEffect, useRef, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { humanizeToolName, isInternalToolName } from "./humanizeToolName";
import { useRealtimeChannel } from "./useRealtimeChannel";
import type { ThreadEventRow } from "./useChatThread";
import type { InlineStatusState } from "./types";

export const TERMINAL_AGENT_RUN_STATUSES = new Set<string>([
  "success",
  "failed",
  "parse_failed",
  "cancelled",
  "dispatch_error",
]);

export const PAUSED_AWAITING_APPROVAL_STATUS = "paused_awaiting_approval";

export const PAUSED_AWAITING_CHILD_STATUS = "paused_awaiting_child";

const POLL_INTERVAL_MS = 8000;

function isTerminalPhase(phase: InlineStatusState["phase"]): boolean {
  return (
    phase === "done" ||
    phase === "error" ||
    phase === "cancelled" ||
    phase === "waiting"
  );
}

const INITIAL: InlineStatusState = {
  phase: "spawning",
  detail: "spawning",
  elapsedSec: 0,
  costUsd: null,
};

type Opts = {
  agentSlug: string;
  runId: string;
  onComplete?: (
    status: "success" | "error" | "failed" | "cancelled",
    costUsd: number | null,
  ) => void;
};

export function useInlineStatus({
  agentSlug,
  runId,
  onComplete,
}: Opts): InlineStatusState {
  const [state, setState] = useState<InlineStatusState>(INITIAL);
  const startRef = useRef<number>(Date.now());
  const runIdRef = useRef<string>(runId);

  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);

  useEffect(() => {
    if (isTerminalPhase(state.phase)) return;
    const id = window.setInterval(() => {
      setState((prev) =>
        isTerminalPhase(prev.phase)
          ? prev
          : {
              ...prev,
              elapsedSec: Math.floor((Date.now() - startRef.current) / 1000),
            },
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.phase]);

  useEffect(() => {
    if (isTerminalPhase(state.phase)) return;
    const sb = createBrowserSupabase();
    let cancelled = false;
    const id = window.setInterval(async () => {
      if (cancelled || runIdRef.current !== runId) return;
      const { data, error } = await sb
        .from("agent_runs")
        .select("status, cost_usd, outcome, output_text, ask_waiting_on:payload->>ask_waiting_on")
        .eq("id", runId)
        .maybeSingle();
      if (cancelled || runIdRef.current !== runId || error || !data) return;
      const status = (data as { status?: string }).status;
      if (status === PAUSED_AWAITING_APPROVAL_STATUS || status === PAUSED_AWAITING_CHILD_STATUS) {
        const waitingOn = (data as unknown as { ask_waiting_on?: unknown }).ask_waiting_on;
        const detail =
          status === PAUSED_AWAITING_CHILD_STATUS
            ? typeof waitingOn === "string" && /^[a-z0-9_-]{1,64}$/i.test(waitingOn)
              ? `waiting on @${waitingOn}`
              : "waiting on another agent"
            : "waiting for your approval";
        setState((prev) =>
          isTerminalPhase(prev.phase)
            ? prev
            : {
                ...prev,
                phase: "waiting",
                detail,
                elapsedSec: Math.floor((Date.now() - startRef.current) / 1000),
              },
        );
        return;
      }
      if (typeof status === "string" && TERMINAL_AGENT_RUN_STATUSES.has(status)) {
        const row = data as {
          outcome?: { deliverable?: string | null } | null;
          output_text?: string | null;
        };
        const deliverable = row.outcome?.deliverable;
        const answered =
          status === "success" ||
          (typeof deliverable === "string" && deliverable.trim().length > 0) ||
          (!row.outcome &&
            typeof row.output_text === "string" &&
            row.output_text.trim().length > 0);
        const phase =
          status === "cancelled" ? "cancelled" : answered ? "done" : "error";
        const costUsd =
          typeof (data as { cost_usd?: number }).cost_usd === "number"
            ? (data as { cost_usd: number }).cost_usd
            : null;
        setState((prev) =>
          isTerminalPhase(prev.phase)
            ? prev
            : {
                ...prev,
                phase,
                detail:
                  phase === "error"
                    ? "error"
                    : phase === "cancelled"
                      ? "stopped"
                      : "done",
                costUsd,
                elapsedSec: Math.floor((Date.now() - startRef.current) / 1000),
              },
        );
        onComplete?.(
          phase === "error"
            ? "error"
            : phase === "cancelled"
              ? "cancelled"
              : "success",
          costUsd,
        );
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [state.phase, runId, onComplete]);

  useRealtimeChannel<ThreadEventRow>({
    table: "thread_event",
    scopeKey: `agent_slug:${agentSlug}`,
    filter: `agent_slug=eq.${agentSlug}`,
    onInsert: (row) => {
      if (row.agent_run_id !== runId) return;
      switch (row.kind) {
        case "run_start":
          setState((p) =>
            isTerminalPhase(p.phase)
              ? p
              : { ...p, phase: "spawning", detail: "spawning" },
          );
          return;
        case "reasoning":
          setState((p) =>
            isTerminalPhase(p.phase)
              ? p
              : { ...p, phase: "drafting", detail: "drafting" },
          );
          return;
        case "tool_call": {
          const b = row.body as { tool_name?: string };
          const rawTool = b?.tool_name ?? "";
          if (isInternalToolName(rawTool)) return;
          const isMemory = /(^|__)memory[._]/i.test(rawTool) || rawTool.startsWith("memory.");
          setState((p) =>
            isTerminalPhase(p.phase)
              ? p
              : {
                  ...p,
                  phase: isMemory ? "reading" : "calling",
                  detail: isMemory
                    ? "reading memory"
                    : `calling ${humanizeToolName(rawTool)}`,
                },
          );
          return;
        }
        case "file_read":
          setState((p) =>
            isTerminalPhase(p.phase)
              ? p
              : { ...p, phase: "reading", detail: "reading file" },
          );
          return;
        case "file_edit":
        case "file_create":
          setState((p) =>
            isTerminalPhase(p.phase)
              ? p
              : { ...p, phase: "drafting", detail: "writing file" },
          );
          return;
        case "run_end": {
          const b = row.body as { status?: string; cost_usd?: number; answered?: boolean };
          const phase =
            b.status === "cancelled"
              ? "cancelled"
              : b.answered
                ? "done"
                : b.status === "error" || b.status === "failed"
                  ? "error"
                  : "done";
          setState((p) => ({
            ...p,
            phase,
            detail:
              phase === "error"
                ? "error"
                : phase === "cancelled"
                  ? "stopped"
                  : "done",
            costUsd: b.cost_usd ?? null,
            elapsedSec: Math.floor((Date.now() - startRef.current) / 1000),
          }));
          onComplete?.(
            phase === "error"
              ? "error"
              : phase === "cancelled"
                ? "cancelled"
                : "success",
            b.cost_usd ?? null,
          );
          return;
        }
        default:
          return;
      }
    },
  });

  return state;
}
