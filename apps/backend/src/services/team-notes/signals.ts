
import { createHash } from "node:crypto";
import { EMPTY_COMPLETION_ERROR, detectToolNoOutput } from "@/services/agents/outcome-model";
import { isUsageLimitError } from "@/services/agents/infra-retry";
import type { OperatorFailureShape } from "@/agents/operator/failure-shapes";
import { isGuardRefusal } from "@/services/tools/guard-refusal";

export { isGuardRefusal };

export type CodeSignal =
  | "tool_repeat_failure"
  | "tool_loop"
  | "tool_thrash"
  | "dead_end_punt"
  | "capability_denial"
  | "hard_grounding_flag"
  | "empty_completion"
  | "tool_no_output"
  | "run_failed"
  | "founder_correction"
  | "founder_frustration"
  | "founder_rephrase"
  | "founder_edit";

export type RunEndInput = {
  status: string;
  error: string | null;
  toolCalls:
    | ReadonlyArray<{ name?: string; status?: string; code?: string; input_preview?: string; output_preview?: string }>
    | undefined;
  groundingFlags: ReadonlyArray<{ pattern?: string; severity?: string }> | undefined;
  operatorShapes: ReadonlyArray<OperatorFailureShape> | undefined;
  willRetry: boolean;
  loopThreshold?: number;
  thrashThreshold?: number;
};

export const DEFAULT_TOOL_LOOP_THRESHOLD = 3;
export const DEFAULT_TOOL_THRASH_THRESHOLD = 10;

export type RunEndSignals = {
  signals: CodeSignal[];
  tool: string | null;
  errorCode: string | null;
  failureShape: OperatorFailureShape | null;
};

const SHAPE_SIGNAL: Partial<Record<OperatorFailureShape, CodeSignal>> = {
  "dead-end-punt": "dead_end_punt",
  "capability-denial": "capability_denial",
};

const FAILED_STATUSES = new Set(["failed", "dispatch_error", "parse_failed"]);

function isExcludedFailure(error: string, willRetry: boolean): boolean {
  if (willRetry) return true;
  if (error === "run_cancelled") return true;
  if (error.includes("insufficient_credits")) return true;
  if (isUsageLimitError(error)) return true;
  return false;
}

function normalizeInput(preview: unknown): string {
  return typeof preview === "string" ? preview.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

function threshold(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 2 ? Math.floor(v) : fallback;
}

export type RunErrorClass = "infra_reap" | "provider_capacity" | "timeout" | "parse" | "other";

export function classifyRunError(error: string | null): RunErrorClass {
  const e = (error ?? "").toLowerCase();
  if (/\b(watchdog_reap|boot_reap|stale_reap)\b|\breap(ed)?\b|orphaned/.test(e)) return "infra_reap";
  if (/\b(429|529)\b|overloaded|rate[ _-]?limit/.test(e)) return "provider_capacity";
  if (/timeout|timed out/.test(e)) return "timeout";
  if (/parse|envelope|json/.test(e)) return "parse";
  return "other";
}

const NON_REPLY_ERROR_CLASSES: ReadonlySet<RunErrorClass> = new Set(["infra_reap", "provider_capacity"]);

export function isHardRunFailure(status: string | null | undefined, error: string | null | undefined): boolean {
  if (!status || status === "success" || status === "cancelled") return false;
  if (!FAILED_STATUSES.has(status)) return false;
  const e = typeof error === "string" ? error.trim() : "";
  if (e && isExcludedFailure(e, false)) return false;
  return !NON_REPLY_ERROR_CLASSES.has(classifyRunError(e));
}

export type NoteSurface = "strip" | "flag";

export function noteSurface(args: { signals: readonly string[]; errorClass: RunErrorClass | string | null }): NoteSurface {
  const set = new Set(args.signals);
  if (set.has("founder_correction") || set.has("founder_frustration")) return "strip";
  if ((set.has("run_failed") || set.has("empty_completion"))
      && !NON_REPLY_ERROR_CLASSES.has(args.errorClass as RunErrorClass)) {
    return "strip";
  }
  return "flag";
}

export function detectRunEndSignals(input: RunEndInput): RunEndSignals {
  const out: RunEndSignals = { signals: [], tool: null, errorCode: null, failureShape: null };
  try {
    const error = typeof input.error === "string" ? input.error.trim() : "";
    const isEmpty = input.status === "failed" && error === EMPTY_COMPLETION_ERROR;
    if (input.status === "cancelled") return out;

    if (input.status !== "success" && !isEmpty) {
      if (FAILED_STATUSES.has(input.status) && error.length > 0 && !isExcludedFailure(error, input.willRetry)) {
        out.signals.push("run_failed");
        out.errorCode = classifyRunError(error);
      }
      return out;
    }

    const calls = input.toolCalls ?? [];
    const failures = new Map<string, { n: number; code: string | null; recovered: boolean }>();
    for (const tc of calls) {
      if (!tc?.name) continue;
      const prev = failures.get(tc.name);
      if (tc.status === "ok") {
        if (prev && prev.n >= 2) prev.recovered = true;
        continue;
      }
      if (isGuardRefusal(tc.code)) continue;
      failures.set(tc.name, {
        n: (prev?.n ?? 0) + 1, code: prev?.code ?? tc.code ?? null, recovered: prev?.recovered ?? false,
      });
    }
    for (const [name, f] of failures) {
      if (f.n >= 2 && !f.recovered) {
        out.signals.push("tool_repeat_failure");
        out.tool = name;
        out.errorCode = f.code;
        break;
      }
    }

    const loopN = threshold(input.loopThreshold, DEFAULT_TOOL_LOOP_THRESHOLD);
    const thrashN = threshold(input.thrashThreshold, DEFAULT_TOOL_THRASH_THRESHOLD);
    const perInput = new Map<string, number>();
    const perTool = new Map<string, number>();
    let loopTool: string | null = null;
    let thrashTool: string | null = null;
    for (const tc of calls) {
      if (!tc?.name) continue;
      const inputKey = normalizeInput(tc.input_preview);
      if (inputKey) {
        const k = `${tc.name}\u0000${inputKey}`;
        const n = (perInput.get(k) ?? 0) + 1;
        perInput.set(k, n);
        if (n >= loopN) loopTool ??= tc.name;
      }
      const t = (perTool.get(tc.name) ?? 0) + 1;
      perTool.set(tc.name, t);
      if (t >= thrashN) thrashTool ??= tc.name;
    }
    if (loopTool) {
      out.signals.push("tool_loop");
      out.tool ??= loopTool;
    }
    if (thrashTool) {
      out.signals.push("tool_thrash");
      out.tool ??= thrashTool;
    }

    for (const shape of input.operatorShapes ?? []) {
      const sig = SHAPE_SIGNAL[shape];
      if (sig && !out.signals.includes(sig)) {
        out.signals.push(sig);
        out.failureShape ??= shape;
      }
    }

    if ((input.groundingFlags ?? []).some((f) => f?.severity === "hard")) out.signals.push("hard_grounding_flag");
    if (isEmpty) out.signals.push("empty_completion");

    const noOutput = detectToolNoOutput(calls as Parameters<typeof detectToolNoOutput>[0]);
    if (noOutput) {
      out.signals.push("tool_no_output");
      out.tool ??= noOutput.tool;
    }

    if (out.signals.length === 1 && out.signals[0] === "tool_thrash") {
      return { signals: [], tool: null, errorCode: null, failureShape: null };
    }
  } catch {
    return { signals: [], tool: null, errorCode: null, failureShape: null };
  }
  return out;
}

export const TOOL_FACT_SIGNALS: ReadonlySet<string> = new Set(["tool_repeat_failure", "tool_loop", "tool_thrash"]);
const MAX_FACT_TOOLS = 5;

function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) || "unnamed_tool";
}

export function buildRunToolFacts(
  toolCalls: unknown,
  opts: { loopThreshold?: number; thrashThreshold?: number } = {},
): string[] {
  try {
    if (!Array.isArray(toolCalls)) return [];
    const loopN = threshold(opts.loopThreshold, DEFAULT_TOOL_LOOP_THRESHOLD);
    const thrashN = threshold(opts.thrashThreshold, DEFAULT_TOOL_THRASH_THRESHOLD);
    const per = new Map<string, { calls: number; ok: number; failed: number; refused: number; inputs: Map<string, number> }>();
    for (const tc of toolCalls as Array<{ name?: unknown; status?: unknown; code?: unknown; input_preview?: unknown }>) {
      if (!tc || typeof tc.name !== "string" || !tc.name) continue;
      const t = per.get(tc.name) ?? { calls: 0, ok: 0, failed: 0, refused: 0, inputs: new Map<string, number>() };
      t.calls += 1;
      if (tc.status === "ok") t.ok += 1;
      else if (isGuardRefusal(tc.code)) t.refused += 1;
      else t.failed += 1;
      const k = normalizeInput(tc.input_preview);
      t.inputs.set(k, (t.inputs.get(k) ?? 0) + 1);
      per.set(tc.name, t);
    }
    const lines: Array<{ calls: number; line: string }> = [];
    for (const [name, t] of per) {
      const sameInput = Math.max(0, ...t.inputs.values());
      const loop = sameInput >= loopN;
      if (!(t.failed >= 2 || loop || t.calls >= thrashN)) continue;
      const parts = [`tool ${safeToolName(name)} called ${t.calls} times`, `${t.ok} ok`, `${t.failed} failed`];
      if (t.refused > 0) parts.push(`${t.refused} refused by Zavi's own guard`);
      if (loop) parts.push(`same input ${sameInput} times`);
      lines.push({ calls: t.calls, line: parts.join(", ") });
    }
    return lines.sort((a, b) => b.calls - a.calls).slice(0, MAX_FACT_TOOLS).map((l) => l.line);
  } catch {
    return [];
  }
}

export const SIGNAL_PRECEDENCE: readonly CodeSignal[] = [
  "founder_correction", "founder_frustration", "founder_edit", "run_failed", "empty_completion",
  "hard_grounding_flag", "tool_repeat_failure", "tool_loop", "tool_thrash", "tool_no_output",
  "dead_end_punt", "capability_denial", "founder_rephrase",
];

export function sortBySignalPrecedence(signals: readonly string[]): CodeSignal[] {
  const set = new Set(signals);
  return SIGNAL_PRECEDENCE.filter((s) => set.has(s));
}

export function teamNoteFingerprint(args: {
  agentSlug: string;
  signal: string;
  tool: string | null;
  errorCode: string | null;
  failureShape: string | null;
}): string {
  return createHash("sha256")
    .update([args.agentSlug, args.signal, args.tool ?? "", args.errorCode ?? "", args.failureShape ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
}
