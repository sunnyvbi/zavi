
import { HarnessFailure } from "@/services/eval/shadow-harness";
import { isSdkHarnessMetaTool } from "@/services/agents/sdk-builtins";
import { shadowSig } from "@/services/agents/engine/shadow-tool-policy";
import { SHADOW_EXCLUDED_SANDBOX_TOOLS } from "@/services/agents/engine/openai-sandbox-tools";
import type {
  EngineToolCall,
  EngineToolResult,
} from "@/services/agents/engine/types";
import type { EvidenceRecord } from "./fixtures";

export type BenchMode = "build" | "score";
export type BenchEngine = "shared_loop" | "claude_sdk";

export type BenchRunCtx = {
  tenant_id: string;
  shadow_mode?: boolean;
  bench_mode?: BenchMode;
  bench_engine?: BenchEngine;
  shadow_tool_results?: Map<string, { content: string; is_error: boolean }[]>;
};

export function isBenchRun(ctx: { bench_mode?: unknown }): boolean {
  return ctx.bench_mode === "build" || ctx.bench_mode === "score";
}

export function assertBenchRunReady(ctx: BenchRunCtx): void {
  if (ctx.bench_mode === undefined) return;
  if (!isBenchRun(ctx)) {
    throw new HarnessFailure(`bench: unknown bench_mode ${JSON.stringify(ctx.bench_mode)}`);
  }
  if (ctx.shadow_mode !== true) {
    throw new HarnessFailure(
      "bench: a bench run must be a shadow run (gate-0 is the only write block)",
    );
  }
  if (ctx.bench_engine !== "shared_loop" && ctx.bench_engine !== "claude_sdk") {
    throw new HarnessFailure(`bench: bench_engine must be shared_loop|claude_sdk`);
  }
  if (ctx.bench_mode === "score" && !(ctx.shadow_tool_results instanceof Map)) {
    throw new HarnessFailure(
      "bench: score mode requires a fixture map before runGeneric (no live-read fallback)",
    );
  }
  if (ctx.bench_mode === "build" && ctx.shadow_tool_results !== undefined) {
    throw new HarnessFailure(
      "bench: build mode must read live (allowlisted); it may not carry a replay map",
    );
  }
}

export async function runBenchTrial<C extends BenchRunCtx, R>(
  ctx: C,
  runGeneric: (ctx: C) => Promise<R>,
): Promise<R> {
  assertBenchRunReady(ctx);
  return runGeneric(ctx);
}

export type BenchDispatchGuard = {
  runTenant: string;
  expectedTenant: string;
  capture?: (r: EvidenceRecord & { sig: string }) => void;
};

type Dispatch = (call: EngineToolCall) => Promise<EngineToolResult>;

export function wrapBenchDispatch(inner: Dispatch, g: BenchDispatchGuard): Dispatch {
  const check = () => {
    if (g.runTenant !== g.expectedTenant) {
      throw new HarnessFailure(
        `bench: run tenant ${g.runTenant} != task tenant ${g.expectedTenant}`,
      );
    }
  };
  check();
  return async (call) => {
    check();
    const res = await inner(call);
    if (g.capture && !res.denied) {
      g.capture({
        sig: shadowSig(call.tool_name, call.input),
        tenant_id: g.runTenant,
        tool_name: call.tool_name,
        input: call.input,
        content: res.content,
        is_error: res.is_error,
      });
    }
    return res;
  };
}

export function assertBenchSdkServers(
  serverNames: ReadonlyArray<string>,
  opts: { allowSandbox: boolean },
): void {
  const allowed = new Set(["server", ...(opts.allowSandbox ? ["sandbox"] : [])]);
  const bad = serverNames.filter((n) => !allowed.has(n));
  if (bad.length > 0) {
    throw new HarnessFailure(
      `bench: SDK tool server(s) attached outside the bench boundary: ${bad.join(", ")}. ` +
        `Only ${[...allowed].join(" + ")} may be exposed in bench mode.`,
    );
  }
  if (!serverNames.includes("server")) {
    throw new HarnessFailure("bench: the gated `server` MCP funnel is missing");
  }
}

export const BENCH_EXCLUDED_SANDBOX_VERBS: ReadonlySet<string> = SHADOW_EXCLUDED_SANDBOX_TOOLS;

export type BenchToolDecision = { allow: true } | { allow: false; reason: string };

export function benchSdkToolDecision(
  toolName: string,
  opts: { allowSandbox: boolean; isShadowRead: (bareName: string) => boolean },
): BenchToolDecision {
  if (isSdkHarnessMetaTool(toolName)) return { allow: true };
  if (toolName.startsWith("mcp__server__")) {
    const bare = toolName.slice("mcp__server__".length);
    return opts.isShadowRead(bare)
      ? { allow: true }
      : { allow: false, reason: "bench_not_allowlisted_read" };
  }
  if (toolName.startsWith("mcp__sandbox__")) {
    const verb = toolName.slice("mcp__sandbox__".length);
    if (!opts.allowSandbox) return { allow: false, reason: "bench_no_sandbox" };
    if (BENCH_EXCLUDED_SANDBOX_VERBS.has(verb)) {
      return { allow: false, reason: "bench_sandbox_side_effect" };
    }
    return { allow: true };
  }
  return { allow: false, reason: "bench_tool_outside_boundary" };
}

export function benchDenyCodeFromPreview(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  if (preview.includes("bench mode: this tool is disabled")) return "bench_tool_outside_boundary";
  if (preview.includes("shadow mode: this tool is disabled")) return "shadow_no_side_effect";
  return undefined;
}

export function codeFromSdkToolError(preview: string | undefined): string | undefined {
  const errorOf = (v: unknown): string | undefined => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const e = (v as { error?: unknown }).error;
      if (typeof e === "string" && e) return e;
    }
    return undefined;
  };
  const tryJson = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  if (preview) {
    let top = tryJson(preview);
    if (typeof top === "string") top = tryJson(top);
    const direct = errorOf(top);
    if (direct) return direct;
    const blocks = Array.isArray(top) ? top : [];
    for (const b of blocks) {
      const t = (b as { text?: unknown })?.text;
      const inner = typeof t === "string" ? errorOf(tryJson(t)) : undefined;
      if (inner) return inner;
    }
  }
  return benchDenyCodeFromPreview(preview);
}

export const BENCH_TOOL_DENY_BODY =
  "bench mode: this tool is disabled for an offline evaluation run. Continue and " +
  "produce your best answer using only the information already available to you.";
