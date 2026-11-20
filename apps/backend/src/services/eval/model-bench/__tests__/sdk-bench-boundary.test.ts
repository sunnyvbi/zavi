import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "ok", stderr: "", exit_code: 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "LIVE-TENANT-BOX"),
}));

import { getSandboxIdForRun } from "@/services/sandbox/lifecycle";
import { execCommand } from "@/services/sandbox/e2b-client";
import { mcpSandbox } from "@/services/agents/sdk/mcp-sandbox";
import { resolveShadowOrLiveSandboxId } from "@/services/sandbox/shadow-lifecycle";
import { makeDispatchTool, type MakeDispatchToolDeps } from "@/services/agents/engine/dispatch-tool";
import { isShadowReadAllowedByName } from "@/services/agents/engine/shadow-tool-policy";
import { preToolUsePolicyHook } from "@/services/agents/pre-tool-use-policy";
import type { McpCallResult } from "@/services/mcp/types";
import { HarnessFailure } from "@/services/eval/shadow-harness";
import { assertBenchSdkServers, benchSdkToolDecision } from "../modes";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const dispatcherSrc = readFileSync(
  join(__dirname, "../../../agents/generic-dispatcher.ts"),
  "latin1",
);
const body = dispatcherSrc.slice(dispatcherSrc.indexOf("export async function runGeneric("));

beforeEach(() => {
  vi.mocked(getSandboxIdForRun).mockClear();
  vi.mocked(execCommand).mockClear();
});

describe("test 1 — SDK path tool boundary in bench mode", () => {
  it("server discovery fails closed: browser, ui or any new server aborts the run", () => {
    expect(() => assertBenchSdkServers(["server"], { allowSandbox: false })).not.toThrow();
    expect(() => assertBenchSdkServers(["server", "sandbox"], { allowSandbox: true })).not.toThrow();
    for (const extra of ["browser", "ui", "sandbox", "some_new_server"]) {
      expect(() => assertBenchSdkServers(["server", extra], { allowSandbox: false })).toThrow(HarnessFailure);
    }
    expect(() => assertBenchSdkServers(["server", "browser"], { allowSandbox: true })).toThrow(HarnessFailure);
    expect(() => assertBenchSdkServers([], { allowSandbox: false })).toThrow(HarnessFailure);
  });

  it("the funnel (the guarantee) denies every write / non-allowlisted tool and never calls the tool fn", async () => {
    const callSpy = vi.fn().mockResolvedValue({ ok: true, content: "LIVE", is_error: false, ms: 1 } as McpCallResult);
    const deps: MakeDispatchToolDeps = {
      isToolAllowed: async () => ({ allowed: true }),
      evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
      shouldDenyPmOperatorDb: () => false,
      isAgentKilled: async () => false,
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
      tenant_id: TENANT,
      agent_slug: "operator",
      baseCallCtx: { tenant_id: TENANT, run_id: "r" },
      onEvent: () => {},
      shadow_mode: true,
      shadow_tool_results: new Map(),
    };
    const dispatch = makeDispatchTool(deps);
    for (const t of [
      "stripe__create_refund",
      "slack__post_message",
      "github__open_pr",
      "report__render_blog",
      "composio__execute",
      "praxis__handoff",
      "memory__search",
    ]) {
      const r = await dispatch({ tool_name: t, input: { x: 1 }, tool_use_id: "u" });
      expect(r.denied, t).toBe(true);
    }
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("the second layer denies everything outside the boundary", () => {
    const opts = { allowSandbox: false, isShadowRead: (b: string) => isShadowReadAllowedByName(b) };
    const denied = [
      "Bash",
      "WebFetch",
      "WebSearch",
      "AskUserQuestion",
      "Task",
      "Agent",
      "mcp__ui__show_chart",
      "mcp__browser__browser_click",
      "mcp__sandbox__run_bash",
      "mcp__server__stripe__create_refund",
      "mcp__server__slack__post_message",
      "mcp__server__growth__read_cohort",
    ];
    for (const t of denied) expect(benchSdkToolDecision(t, opts).allow, t).toBe(false);
    expect(benchSdkToolDecision("mcp__server__memory__search", opts).allow).toBe(true);
    expect(benchSdkToolDecision("ToolSearch", opts).allow).toBe(true);
    expect(benchSdkToolDecision("StructuredOutput", opts).allow).toBe(true);
    expect(benchSdkToolDecision("mcp__server__StructuredOutput", opts).allow).toBe(false);
  });

  it("engineer: sandbox verbs pass on the throwaway box, emit_artifact / stage_preview never do", () => {
    const opts = { allowSandbox: true, isShadowRead: (b: string) => isShadowReadAllowedByName(b) };
    expect(benchSdkToolDecision("mcp__sandbox__run_bash", opts).allow).toBe(true);
    expect(benchSdkToolDecision("mcp__sandbox__emit_artifact", opts).allow).toBe(false);
    expect(benchSdkToolDecision("mcp__sandbox__stage_preview", opts).allow).toBe(false);
  });

  it("the PreToolUse hook applies the bench boundary FIRST, even if every other dep would allow", async () => {
    const res = await preToolUsePolicyHook({
      isAgentKilled: async () => false,
      isToolAllowed: async () => ({ allowed: true }),
      emitThreadEvent: async () => {},
      ctx: {
        tenant_id: TENANT,
        agent: { slug: "operator" },
        runId: "r",
        thread_id: null,
        killed: { value: false },
        iter: { value: 0 },
        bench_shadow: { allowSandbox: false },
      } as never,
      hookInput: { tool_name: "mcp__ui__show_chart", tool_input: {} } as never,
    });
    expect((res as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("dispatcher wiring: SDK funnel gets shadow gate-0 + the replay map + the bench wrapper", () => {
    expect(body).toMatch(
      /const sdkDispatchTool = benchWrap\(makeDispatchTool\(\{[\s\S]{0,400}?shadow_mode: ctx\.shadow_mode,\s*\n\s*shadow_tool_results: ctx\.shadow_tool_results,/,
    );
    expect(body).toMatch(/dispatchTool: benchWrap\(openAiDispatchTool\)/);
  });

  it("dispatcher wiring: browser + ui are not attached in bench mode, and discovery is asserted before query()", () => {
    expect(body).toMatch(/if \(browserTools\.length > 0 && !isBench\) \{\s*\n\s*const stagingOrigin/);
    expect(body).toMatch(/if \(\(ctx\.trigger === "chat" \|\| handoffThread\) && !isBench\) \{/);
    const assertIdx = body.indexOf("assertBenchSdkServers(Object.keys(mcpServers)");
    const queryIdx = body.indexOf("if (providerForRun === \"anthropic\" && !useAnthropicEngine) {");
    expect(assertIdx).toBeGreaterThan(0);
    expect(assertIdx).toBeLessThan(queryIdx);
  });

  it("dispatcher wiring: every MCP server the SDK path can attach is a KNOWN one (a new server fails this test until it is gated)", () => {
    const attached = [
      ...new Set(
        [...body.matchAll(/\(mcpServers as Record<string, unknown>\)\.(\w+) =/g)].map((m) => m[1]),
      ),
    ].sort();
    expect(attached).toEqual(["browser", "sandbox", "server", "ui"]);
  });

  it("dispatcher wiring: a bench run is forced onto the SDK path, never the legacy direct loop", () => {
    expect(body).toMatch(/forceSdkPath \|\|[\s\S]{0,200}?isBench \|\|/);
  });

  it("dispatcher wiring: bench readiness is asserted at the top of every run", () => {
    expect(body).toMatch(/assertBenchRunReady\(ctx\);\s*\n\s*const isBench = isShadowRun && isBenchRun\(ctx\);/);
  });

  it("PreToolUse hook gets the bench boundary on bench runs only", () => {
    expect(body).toMatch(/bench_shadow: isBench\s*\n?\s*\? \{ allowSandbox:/);
  });
});

describe("test 11 — engineer bench on the SDK path never calls getSandboxIdForRun", () => {
  it("mcpSandbox with the bench resolver runs tools on the throwaway box only", async () => {
    const server = await mcpSandbox({
      tenant_id: TENANT,
      run_id: "bench-eng",
      repo_full_name: "bench-throwaway-box",
      resolveSandboxId: () =>
        resolveShadowOrLiveSandboxId(
          { shadow_mode: true, shadow_sandbox_id: "BENCH-BOX" },
          async () => {
            throw new Error("live resolver must never be called");
          },
        ),
    });
    const tools = (
      server as unknown as {
        instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> };
      }
    ).instance._registeredTools;
    await tools.run_bash.handler({ command: "ls" });
    await tools.git_status.handler({});
    expect(getSandboxIdForRun).not.toHaveBeenCalled();
    for (const c of vi.mocked(execCommand).mock.calls) expect(c[0]).toBe("BENCH-BOX");
  });

  it("a bench resolver with no shadow box id throws instead of falling back to the live box", async () => {
    const server = await mcpSandbox({
      tenant_id: TENANT,
      run_id: "bench-eng-2",
      repo_full_name: "x",
      resolveSandboxId: () =>
        resolveShadowOrLiveSandboxId({ shadow_mode: true, shadow_sandbox_id: undefined }, async () => "LIVE"),
    });
    const tools = (
      server as unknown as {
        instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> };
      }
    ).instance._registeredTools;
    const r = (await tools.run_bash.handler({ command: "ls" })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(getSandboxIdForRun).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("dispatcher wiring: the bench engineer mount uses the shadow resolver, and no bench run enters the live sandbox setup", () => {
    const m = body.match(
      /if \(isBenchClaudeSdkRun && isShadowSandboxRun && sandboxTools\.length > 0\) \{([\s\S]*?)\n    \}\n/,
    );
    expect(m, "bench engineer sandbox mount not found").toBeTruthy();
    expect(m![1]).toMatch(/resolveSandboxId: \(\) =>\s*\n\s*resolveShadowOrLiveSandboxId\(\s*\n\s*\{ shadow_mode: true, shadow_sandbox_id: ctx\.shadow_sandbox_id \}/);
    expect(m![1]).not.toMatch(/getSandboxIdForRun/);
    expect(m![1]).not.toMatch(/lazyProvision/);
    expect(m![1]).toMatch(/BENCH_EXCLUDED_SANDBOX_VERBS/);
    expect(body).toMatch(
      /if \(ctx\.agent\.metadata_praxis\.requires_sandbox && !isShadowSandboxRun && !isBench\)/,
    );
  });
});
