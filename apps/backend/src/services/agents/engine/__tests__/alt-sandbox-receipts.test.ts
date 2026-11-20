import { describe, it, expect, vi } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import { attachAltSandboxReceipts } from "../alt-sandbox-receipts";
import { extractTestReceipt } from "@/agents/engineer/engineer-verify-receipt";
import type { EngineEvent, EngineToolResult } from "../types";
import type { ToolCallTrace } from "@/services/tools/types";

function harness(exec: EngineToolResult, withHook = true) {
  const toolCalls: ToolCallTrace[] = [];
  const callMcpTool = vi.fn().mockResolvedValue({ ok: true, content: '{"exit_code":0}', is_error: false, ms: 1 });
  const onEvent = (e: EngineEvent) => {
    if (e.type === "tool_call") {
      toolCalls.push({
        name: String(e.name ?? "unknown").slice(0, 100),
        input_preview: "",
        output_preview: "",
        ms: e.ms,
        status: e.code === "ok" ? "ok" : "tool_error",
      } as ToolCallTrace);
    }
  };
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callMcpTool as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "engineer",
    baseCallCtx: { tenant_id: "t1", run_id: "r1" },
    onEvent,
    iter: { value: 0 },
    sandboxExecutor: vi.fn().mockResolvedValue(exec),
    sandboxMode: "live",
    ...(withHook
      ? { onSandboxResult: (n: string, i: unknown, r: EngineToolResult) => attachAltSandboxReceipts(toolCalls, n, i, r) }
      : {}),
  };
  return { dispatch: makeDispatchTool(deps), toolCalls, callMcpTool };
}

const call = (verb: string, input: unknown) => ({
  tool_name: `sandbox__${verb}`,
  server_id: "sandbox",
  bare_tool_name: verb,
  input,
  tool_use_id: `tu-${verb}`,
});

describe("alt funnel build proof (staff ?model= live sandbox)", () => {
  it("a passing run_tests yields a passing test receipt on its trace row", async () => {
    const content = JSON.stringify({ exit_code: 0, stdout: "Tests: 3 passed", stderr: "" });
    const h = harness({ is_error: false, content, ms: 5 });
    await h.dispatch(call("run_tests", { command: "npm test" }));
    expect(h.toolCalls).toHaveLength(1);
    expect(h.toolCalls[0].test_receipt).toMatchObject({ tool: "sandbox__run_tests", status: "passed", exit_code: 0 });
    expect(h.toolCalls[0].test_receipt).toEqual(
      extractTestReceipt("sandbox__run_tests", content, false, { command: "npm test" }),
    );
  });

  it("a failing run_tests yields a failing test receipt", async () => {
    const content = JSON.stringify({ exit_code: 1, stdout: "FAIL src/a.test.ts\n1 failed", stderr: "" });
    const h = harness({ is_error: false, content, ms: 5 });
    await h.dispatch(call("run_tests", { command: "npm test" }));
    expect(h.toolCalls[0].test_receipt).toMatchObject({ status: "failed", exit_code: 1 });
  });

  it("a run_bash typecheck yields a typecheck receipt", async () => {
    const h = harness({ is_error: false, content: JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }), ms: 5 });
    await h.dispatch(call("run_bash", { command: "npx tsc --noEmit" }));
    expect(h.toolCalls[0].typecheck_receipt).toMatchObject({ status: "passed", exit_code: 0, command: "npx tsc --noEmit" });
    expect(h.toolCalls[0].test_receipt).toBeNull();
  });

  it("no hook (non-staff / Claude funnel shape): rows carry no receipts, as before", async () => {
    const h = harness({ is_error: false, content: JSON.stringify({ exit_code: 0 }), ms: 5 }, false);
    await h.dispatch(call("run_tests", { command: "npm test" }));
    expect(h.toolCalls[0].test_receipt).toBeUndefined();
  });

  it("a non-sandbox tool never reaches the hook", async () => {
    const h = harness({ is_error: false, content: "{}", ms: 5 });
    await h.dispatch({ tool_name: "github__get_pr", server_id: "github", bare_tool_name: "get_pr", input: {}, tool_use_id: "x" });
    expect(h.callMcpTool).toHaveBeenCalledTimes(1);
    expect(h.toolCalls[0].test_receipt).toBeUndefined();
  });

  it("name guard: never writes onto a different call's row", () => {
    const rows = [{ name: "sandbox__view", input_preview: "", output_preview: "", ms: 1, status: "ok" } as ToolCallTrace];
    attachAltSandboxReceipts(rows, "sandbox__run_tests", { command: "npm test" }, { is_error: false, content: '{"exit_code":0}', ms: 1 });
    expect(rows[0].test_receipt).toBeUndefined();
  });
});
