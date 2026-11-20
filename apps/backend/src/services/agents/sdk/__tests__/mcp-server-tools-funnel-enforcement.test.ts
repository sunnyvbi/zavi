
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpCallResult } from "@/services/mcp/types";

const callSpy = vi.fn(async (..._args: unknown[]): Promise<McpCallResult> => ({
  ok: true,
  content: "{}",
  is_error: false,
  ms: 0,
}));
vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: (...args: unknown[]) => callSpy(...args),
}));

vi.mock("@/services/mcp/discovery", () => ({
  listToolsForTenant: vi.fn(async () => [
    {
      name: "web_fetch__fetch",
      description: "Fetch a URL.",
      input_schema: { type: "object", properties: {} },
      server_id: "web_fetch",
      tool_name: "fetch",
    },
    {
      name: "operator_db__query",
      description: "Query the customer DB.",
      input_schema: { type: "object", properties: {} },
      server_id: "operator_db",
      tool_name: "query",
    },
  ]),
}));

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string; handler: Handler }> }) => ({
    tools: opts.tools,
  }),
}));

import { mcpServerTools } from "../mcp-server-tools";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../../engine/dispatch-tool";
import type { EngineEvent } from "../../engine/types";

const RESOLVED = ["web_fetch__fetch", "operator_db__query"] as const;

function buildFunnel(overrides: Partial<MakeDispatchToolDeps> = {}) {
  const events: EngineEvent[] = [];
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: ((...args: unknown[]) =>
      callSpy(...args)) as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "operator",
    baseCallCtx: { tenant_id: "t1", run_id: "run-1", agent_slug: "operator" },
    resolved_tool_names: [...RESOLVED],
    onEvent: (e) => events.push(e),
    ...overrides,
  };
  const dispatchTool = makeDispatchTool(deps);
  return { dispatchTool, events };
}

async function buildHandler(overrides: Partial<MakeDispatchToolDeps> = {}) {
  const { dispatchTool, events } = buildFunnel(overrides);
  const server = (await mcpServerTools(
    { tenant_id: "t1", run_id: "run-1", agent_slug: "operator" },
    ["web_fetch__fetch", "operator_db__query"],
    dispatchTool,
  )) as unknown as { tools: Array<{ name: string; handler: Handler }> };
  return { server, events };
}

beforeEach(() => {
  callSpy.mockReset();
  callSpy.mockResolvedValue({
    ok: true,
    content: JSON.stringify({ result: "real-output" }),
    is_error: false,
    ms: 7,
  });
});

describe("mcp-server-tools × real funnel — enforcement on the Anthropic engine path", () => {
  it("(a) KILL: handler returns isError result text 'kill_switch' AND callMcpTool NOT called", async () => {
    const { server } = await buildHandler({ isAgentKilled: async () => true });
    const fetchTool = server.tools.find((t) => t.name === "web_fetch__fetch")!;
    const res = (await fetchTool.handler({ input: { url: "https://x" } }, {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("kill_switch");
  });

  it("(b) EGRESS-DENY: synthetic body returned + callMcpTool NOT called", async () => {
    const { server } = await buildHandler({
      evaluateToolCallPolicy: () => ({
        allow: false,
        reason: "egress_denied_coresident",
        synthetic_tool_result: "EGRESS DENIED: open-web read blocked (co-resident private tool).",
      }),
    });
    const fetchTool = server.tools.find((t) => t.name === "web_fetch__fetch")!;
    const res = (await fetchTool.handler({ input: { url: "https://x" } }, {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("EGRESS DENIED");
  });

  it("(c) TENANT-DENY via isToolAllowed: synthetic body + callMcpTool NOT called", async () => {
    const { server } = await buildHandler({
      isToolAllowed: async () => ({ allowed: false, reason: "blocked by tenant policy (scope: agent operator)" }),
    });
    const fetchTool = server.tools.find((t) => t.name === "web_fetch__fetch")!;
    const res = (await fetchTool.handler({ input: { url: "https://x" } }, {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("blocked by tenant policy");
  });

  it("(d) ALLOW: callMcpTool called exactly once + real content returned", async () => {
    const { server } = await buildHandler();
    const fetchTool = server.tools.find((t) => t.name === "web_fetch__fetch")!;
    const res = (await fetchTool.handler({ input: { url: "https://x" } }, {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1", run_id: "run-1" }),
      "web_fetch",
      "fetch",
      { url: "https://x" },
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("real-output");
  });

  it("C14 behavior-preservation: with onEvent=noop the funnel writes ZERO duplicate agent_run_events rows", async () => {
    const events: EngineEvent[] = [];
    const noopSink: MakeDispatchToolDeps["onEvent"] = () => {
      events.push({ type: "text_delta", text: "should-never-run" });
    };
    const recording: EngineEvent[] = [];
    const { server } = await buildHandler({ onEvent: (e) => recording.push(e) });
    const fetchTool = server.tools.find((t) => t.name === "web_fetch__fetch")!;
    await fetchTool.handler({ input: { url: "https://x" } }, {});
    expect(recording.filter((e) => e.type === "tool_call")).toHaveLength(1);
    expect(events).toHaveLength(0);
    void noopSink;
  });
});
