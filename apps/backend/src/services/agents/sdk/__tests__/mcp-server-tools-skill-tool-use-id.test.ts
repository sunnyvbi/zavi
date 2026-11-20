
import { describe, it, expect, vi, beforeEach } from "vitest";

const seenCtx: Array<{ tool_use_id?: string }> = [];
vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: vi.fn(async (ctx: { tool_use_id?: string }) => {
    seenCtx.push({ tool_use_id: ctx.tool_use_id });
    return { ok: true, content: "{}", is_error: false, ms: 0 };
  }),
}));

vi.mock("@/services/mcp/discovery", () => ({
  listToolsForTenant: vi.fn(async () => [
    {
      name: "tenant_skill__operator__abc12345",
      description: "Learned tenant skill: x.",
      input_schema: { type: "object", properties: {} },
      server_id: "tenant_skill",
      tool_name: "operator__abc12345",
    },
  ]),
}));

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string; handler: Handler }> }) => ({ tools: opts.tools }),
}));

import { mcpServerTools } from "../mcp-server-tools";

describe("FIX 20 — SDK injected-skill handler supplies a defined unique tool_use_id", () => {
  beforeEach(() => {
    seenCtx.length = 0;
  });

  it("invoking the synthesized skill tool passes a DEFINED tool_use_id to callMcpTool, distinct per invocation", async () => {
    const server = (await mcpServerTools(
      { tenant_id: "t1", run_id: "run-1", agent_slug: "operator" },
      ["tenant_skill__operator__abc12345"],
    )) as unknown as { tools: Array<{ name: string; handler: Handler }> };

    const skillTool = server.tools.find((t) => t.name === "tenant_skill__operator__abc12345")!;
    expect(skillTool).toBeDefined();

    await skillTool.handler({ input: {} }, {});
    await skillTool.handler({ input: {} }, {});

    expect(seenCtx).toHaveLength(2);
    expect(seenCtx[0].tool_use_id).toBeTruthy();
    expect(seenCtx[1].tool_use_id).toBeTruthy();
    expect(seenCtx[0].tool_use_id).not.toBe(seenCtx[1].tool_use_id);
    expect(seenCtx[0].tool_use_id).toBe("run-1__tenant_skill__operator__abc12345__inv0");
    expect(seenCtx[1].tool_use_id).toBe("run-1__tenant_skill__operator__abc12345__inv1");
  });

  it("P1-A funnel: when a dispatchTool is injected, the handler routes through it with the SAME synthesized tool_use_id + server/tool split", async () => {
    const funnelCalls: Array<{ tool_name: string; server_id?: string; bare?: string; tool_use_id: string }> = [];
    const dispatchTool = vi.fn(async (call: { tool_name: string; server_id?: string; bare_tool_name?: string; tool_use_id: string }) => {
      funnelCalls.push({
        tool_name: call.tool_name,
        server_id: call.server_id,
        bare: call.bare_tool_name,
        tool_use_id: call.tool_use_id,
      });
      return { is_error: false, content: "{}", ms: 1 };
    });

    const server = (await mcpServerTools(
      { tenant_id: "t1", run_id: "run-2", agent_slug: "operator" },
      ["tenant_skill__operator__abc12345"],
      dispatchTool,
    )) as unknown as { tools: Array<{ name: string; handler: Handler }> };

    const skillTool = server.tools.find((t) => t.name === "tenant_skill__operator__abc12345")!;
    await skillTool.handler({ input: {} }, {});

    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(funnelCalls).toHaveLength(1);
    expect(funnelCalls[0].tool_name).toBe("tenant_skill__operator__abc12345");
    expect(funnelCalls[0].server_id).toBe("tenant_skill");
    expect(funnelCalls[0].bare).toBe("operator__abc12345");
    expect(funnelCalls[0].tool_use_id).toBe("run-2__tenant_skill__operator__abc12345__inv0");
  });
});
