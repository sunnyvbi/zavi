
import { inngest } from "@/../workers/client";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import type { OperatorFailureShape } from "@/agents/operator/failure-shapes";
import {
  DEFAULT_TOOL_LOOP_THRESHOLD, DEFAULT_TOOL_THRASH_THRESHOLD,
  detectRunEndSignals, sortBySignalPrecedence, teamNoteFingerprint, type RunEndInput,
} from "./signals";

async function numberOr(key: "team_note_tool_loop_threshold" | "team_note_tool_thrash_threshold", fallback: number): Promise<number> {
  try {
    return await getNumberSetting(key);
  } catch {
    return fallback;
  }
}

export async function emitTeamNoteRunEnd(args: {
  runId: string;
  tenantId: string;
  agentSlug: string;
  trigger: string | null;
  paused: boolean;
  status: string;
  error: string | null;
  willRetry: boolean;
  toolCalls: RunEndInput["toolCalls"];
  groundingFlags: RunEndInput["groundingFlags"];
  operatorShapes: ReadonlyArray<OperatorFailureShape> | undefined;
}): Promise<void> {
  try {
    if (args.trigger !== "chat" || args.paused) return;
    const [loopThreshold, thrashThreshold] = await Promise.all([
      numberOr("team_note_tool_loop_threshold", DEFAULT_TOOL_LOOP_THRESHOLD),
      numberOr("team_note_tool_thrash_threshold", DEFAULT_TOOL_THRASH_THRESHOLD),
    ]);
    const found = detectRunEndSignals({
      status: args.status,
      error: args.error,
      toolCalls: args.toolCalls,
      groundingFlags: args.groundingFlags,
      operatorShapes: args.operatorShapes,
      willRetry: args.willRetry,
      loopThreshold,
      thrashThreshold,
    });
    if (found.signals.length === 0) return;
    if (!(await getBoolSetting("team_note_enabled", args.tenantId))) return;
    const signals = sortBySignalPrecedence(found.signals);
    await inngest.send({
      name: "team_note.candidate",
      data: {
        run_id: args.runId,
        source: "run_end",
        signals,
        fingerprint: teamNoteFingerprint({
          agentSlug: args.agentSlug,
          signal: signals[0],
          tool: found.tool,
          errorCode: found.errorCode,
          failureShape: found.failureShape,
        }),
      },
    });
  } catch (e) {
    console.warn(`[team-note] run-end emit skipped for ${args.runId}: ${(e as Error).message}`);
  }
}
