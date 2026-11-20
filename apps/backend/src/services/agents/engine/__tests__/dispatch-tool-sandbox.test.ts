
import { describe, it, expect, vi } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import type { EngineEvent, EngineToolCall, EngineToolResult } from "../types";
import type { McpCallResult } from "@/services/mcp/types";

function baseDeps(overrides: Partial<MakeDispatchToolDeps> = {}) {
  const events: EngineEvent[] = [];
  const okResult: McpCallResult = {
    ok: true,
    content: JSON.stringify({ result: "real-output" }),
    is_error: false,
    ms: 12,
  };
  const callSpy = vi.fn().mockResolvedValue(okResult);
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "engineer",
    baseCallCtx: { tenant_id: "t1", run_id: "r1" },
    onEvent: (e) => events.push(e),
    iter: { value: 0 },
    ...overrides,
  };
  return { deps, events, callSpy };
}

const runBashCall: EngineToolCall = {
  tool_name: "sandbox__run_bash",
  server_id: "sandbox",
  bare_tool_name: "run_bash",
  input: { command: "ls" },
  tool_use_id: "tu-sb",
};

describe("dispatch-tool — shadow sandbox executor branch (P0.c)", () => {
  it("ROUTES sandbox__run_bash to the executor, NEVER callMcpTool", async () => {
    const execSpy = vi.fn().mockResolvedValue({
      is_error: false,
      content: JSON.stringify({ stdout: "files" }),
      ms: 7,
      denied: false,
    } satisfies EngineToolResult);
    const { deps, events, callSpy } = baseDeps({
      shadow_mode: true,
      sandboxExecutor: execSpy,
    });
    const res = await makeDispatchTool(deps)(runBashCall);

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy).toHaveBeenCalledWith("run_bash", { command: "ls" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.is_error).toBe(false);
    expect(res.content).toContain("files");
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(1);
    expect((toolCalls[0] as { code: string }).code).toBe("ok");
  });

  it("an executor error result emits the error code (no throw)", async () => {
    const execSpy = vi.fn().mockResolvedValue({
      is_error: true,
      content: JSON.stringify({ error: "exec_failed", message: "boom" }),
      ms: 3,
      code: "exec_failed",
      denied: false,
    } satisfies EngineToolResult);
    const { deps, events } = baseDeps({ shadow_mode: true, sandboxExecutor: execSpy });
    const res = await makeDispatchTool(deps)(runBashCall);
    expect(res.is_error).toBe(true);
    const tc = events.find((e) => e.type === "tool_call") as { code: string };
    expect(tc.code).toBe("exec_failed");
  });

  it("the read-only-on-info gate STILL fires for a canonical mutator name", async () => {
    const execSpy = vi.fn();
    const { deps } = baseDeps({
      shadow_mode: true,
      sandboxExecutor: execSpy,
      cto_chat_intent: "info",
    });
    const res = await makeDispatchTool(deps)({
      tool_name: "sandbox__write_file",
      server_id: "sandbox",
      bare_tool_name: "write_file",
      input: { path: "x.ts", content: "y" },
      tool_use_id: "tu-w",
    });
    expect(res.code).toBe("cto_info_readonly");
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("the read-only-on-info gate ALLOWS a canonical read verb (routes to executor)", async () => {
    const execSpy = vi.fn().mockResolvedValue({
      is_error: false,
      content: JSON.stringify({ content: "...", reads_used: 1 }),
      ms: 2,
      denied: false,
    } satisfies EngineToolResult);
    const { deps } = baseDeps({
      shadow_mode: true,
      sandboxExecutor: execSpy,
      cto_chat_intent: "info",
    });
    const res = await makeDispatchTool(deps)({
      tool_name: "sandbox__read_file",
      server_id: "sandbox",
      bare_tool_name: "read_file",
      input: { path: "x.ts" },
      tool_use_id: "tu-r",
    });
    expect(res.is_error).toBe(false);
    expect(execSpy).toHaveBeenCalledWith("read_file", { path: "x.ts" });
  });

  it("emit_artifact in shadow → executor refusal (no side effect)", async () => {
    const execSpy = vi.fn().mockResolvedValue({
      is_error: true,
      content: JSON.stringify({ error: "shadow_emit_artifact_disabled" }),
      ms: 0,
      code: "shadow_emit_artifact_disabled",
      denied: true,
    } satisfies EngineToolResult);
    const { deps, callSpy } = baseDeps({ shadow_mode: true, sandboxExecutor: execSpy });
    const res = await makeDispatchTool(deps)({
      tool_name: "sandbox__emit_artifact",
      server_id: "sandbox",
      bare_tool_name: "emit_artifact",
      input: { path: "out/r.pdf", filename: "r.pdf" },
      tool_use_id: "tu-e",
    });
    expect(res.code).toBe("shadow_emit_artifact_disabled");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("WITHOUT a sandboxExecutor, a shadow sandbox name hits the gate-0 allowlist DENY", async () => {
    const { deps, callSpy } = baseDeps({ shadow_mode: true  });
    const res = await makeDispatchTool(deps)(runBashCall);
    expect(res.is_error).toBe(true);
    expect(res.denied).toBe(true);
    expect(res.code).toBe("shadow_no_side_effect");
    expect(callSpy).not.toHaveBeenCalled();
  });
});

describe("dispatch-tool — NON-shadow OpenAI dispatch is byte-identical (no sandbox branch)", () => {
  it("a non-shadow engineer dispatch never builds/uses a sandbox branch", async () => {
    const { deps, events, callSpy } = baseDeps();
    const res = await makeDispatchTool(deps)({
      tool_name: "github__get_file",
      input: { path: "README.md" },
      tool_use_id: "tu-gh",
    });
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: "r1", tool_use_id: "tu-gh" }),
      "github",
      "get_file",
      { path: "README.md" },
    );
    expect(res.is_error).toBe(false);
    expect(events.filter((e) => e.type === "tool_call").length).toBe(1);
  });

  it("even a `sandbox__`-named tool with NO executor + NO shadow_mode routes to callMcpTool unchanged", async () => {
    const { deps, callSpy } = baseDeps({ agent_slug: "operator" });
    await makeDispatchTool(deps)(runBashCall);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(
      expect.anything(),
      "sandbox",
      "run_bash",
      { command: "ls" },
    );
  });
});

describe("dispatch-tool — sandbox branch requires shadow_mode + engineer (P2 invariant)", () => {
  it("executor present but NON-shadow → does NOT route to the executor", async () => {
    const execSpy = vi.fn();
    const { deps, callSpy } = baseDeps({
      agent_slug: "engineer",
      sandboxExecutor: execSpy,
    });
    await makeDispatchTool(deps)(runBashCall);
    expect(execSpy).not.toHaveBeenCalled();
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(
      expect.anything(),
      "sandbox",
      "run_bash",
      { command: "ls" },
    );
  });

  it("executor present + shadow but NON-engineer → does NOT route to the executor (gate-0 deny)", async () => {
    const execSpy = vi.fn();
    const { deps, callSpy } = baseDeps({
      agent_slug: "operator",
      shadow_mode: true,
      sandboxExecutor: execSpy,
    });
    const res = await makeDispatchTool(deps)(runBashCall);
    expect(execSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("shadow_no_side_effect");
  });
});

describe("dispatch-tool — LIVE sandbox executor mode (staff ?model=)", () => {
  const okExec = () =>
    vi.fn().mockResolvedValue({ is_error: false, content: "ok", ms: 1, denied: false } satisfies EngineToolResult);
  const viewCall: EngineToolCall = {
    tool_name: "sandbox__view",
    server_id: "sandbox",
    bare_tool_name: "view",
    input: { path: "README.md" },
    tool_use_id: "tu-v",
  };

  it("live sandboxMode routes canonical sandbox__ calls to the executor without shadow_mode", async () => {
    const exec = okExec();
    const { deps, callSpy } = baseDeps({ sandboxExecutor: exec, sandboxMode: "live", shadow_mode: false });
    await makeDispatchTool(deps)(viewCall);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("view", { path: "README.md" });
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("product-builder is allowed in live mode", async () => {
    const exec = okExec();
    const { deps, callSpy } = baseDeps({ agent_slug: "product-builder", sandboxExecutor: exec, sandboxMode: "live" });
    await makeDispatchTool(deps)(viewCall);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("live mode keeps the slug pin: an executor passed for any other agent is never reached", async () => {
    const exec = okExec();
    const { deps } = baseDeps({ agent_slug: "research", sandboxExecutor: exec, sandboxMode: "live" });
    await makeDispatchTool(deps)(viewCall);
    expect(exec).not.toHaveBeenCalled();
  });

  it("live mode is never taken on a shadow run (shadow_mode wins → gate-0)", async () => {
    const exec = okExec();
    const { deps, callSpy } = baseDeps({ sandboxExecutor: exec, sandboxMode: "live", shadow_mode: true });
    const r = await makeDispatchTool(deps)(viewCall);
    expect(exec).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(r.denied).toBe(true);
  });

  it("no sandboxMode + no shadow_mode → sandbox call not routed to executor (byte-identical default)", async () => {
    const exec = vi.fn();
    const { deps } = baseDeps({ sandboxExecutor: exec, shadow_mode: false });
    await makeDispatchTool(deps)(viewCall);
    expect(exec).not.toHaveBeenCalled();
  });

  it("the gate chain still runs first in live mode (read-only-on-info denies a mutator)", async () => {
    const exec = okExec();
    const { deps } = baseDeps({ sandboxExecutor: exec, sandboxMode: "live", cto_chat_intent: "info" });
    const r = await makeDispatchTool(deps)(runBashCall);
    expect(exec).not.toHaveBeenCalled();
    expect(r.code).toBe("cto_info_readonly");
  });

  it("the kill switch still stops a live sandbox call", async () => {
    const exec = okExec();
    const { deps } = baseDeps({ sandboxExecutor: exec, sandboxMode: "live", isAgentKilled: async () => true });
    const r = await makeDispatchTool(deps)(viewCall);
    expect(exec).not.toHaveBeenCalled();
    expect(r.code).toBe("kill_switch");
  });
});

describe("dispatch-tool — live add_site_images routing (staff ?model=)", () => {
  const siteImagesCall: EngineToolCall = {
    tool_name: "sandbox__add_site_images",
    server_id: "sandbox",
    bare_tool_name: "add_site_images",
    input: { images: [] },
    tool_use_id: "tu-si",
  };
  it("live product-builder: routes to the executor, never callMcpTool", async () => {
    const execSpy = vi.fn().mockResolvedValue({ is_error: false, content: "{}", ms: 1 } satisfies EngineToolResult);
    const { deps, callSpy } = baseDeps({ agent_slug: "product-builder", sandboxExecutor: execSpy, sandboxMode: "live" });
    await makeDispatchTool(deps)(siteImagesCall);
    expect(execSpy).toHaveBeenCalledWith("add_site_images", { images: [] });
    expect(callSpy).not.toHaveBeenCalled();
  });
  it("shadow mode: add_site_images is NOT a sandbox-executor call", async () => {
    const execSpy = vi.fn();
    const { deps } = baseDeps({ shadow_mode: true, sandboxExecutor: execSpy });
    await makeDispatchTool(deps)(siteImagesCall);
    expect(execSpy).not.toHaveBeenCalled();
  });
});

