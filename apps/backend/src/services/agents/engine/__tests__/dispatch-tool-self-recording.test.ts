
import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({
  stripe: { balanceTransactions: { list: vi.fn() } },
}));
vi.mock("@/services/tools/stripe/_client", () => ({ stripeClient: vi.fn(async () => m.stripe) }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));

import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import { isSelfRecordingTool, pullsForFigure, toolCallCount } from "../figure-ledger";
import { runGetMetric } from "@/services/tools/analytics/get_metric";
import type { McpCallResult } from "@/services/mcp/types";

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function deps(run_id: string, callMcpTool: MakeDispatchToolDeps["callMcpTool"]): MakeDispatchToolDeps {
  return {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool,
    tenant_id: "t1",
    agent_slug: "cgo",
    baseCallCtx: { tenant_id: "t1", run_id },
    onEvent: () => undefined,
    iter: { value: 0 },
  };
}

describe("SDK dispatch funnel + self-recording tools", () => {
  it("isSelfRecordingTool matches bare and MCP-prefixed names only", () => {
    expect(isSelfRecordingTool("growth__get_metric")).toBe(true);
    expect(isSelfRecordingTool("mcp__growth__get_metric")).toBe(true);
    expect(isSelfRecordingTool("mcp__praxis-server__growth__compute")).toBe(true);
    expect(isSelfRecordingTool("growth__read_revenue")).toBe(false);
    expect(isSelfRecordingTool("other__get_metric")).toBe(false);
  });

  for (const toolName of ["growth__get_metric", "mcp__praxis-server__growth__get_metric"]) {
    it(`a get_metric call (${toolName}) is recorded exactly once`, async () => {
      const run_id = `run-self-${toolName}`;
      m.stripe.balanceTransactions.list.mockResolvedValue({
        data: [{ id: "t1", created: ts("2026-09-21T10:00:00Z"), reporting_category: "charge", currency: "usd", amount: 4567891, net: 4567891 }],
        has_more: false,
      });
      const callMcpTool = vi.fn(async (): Promise<McpCallResult> => {
        const out = await runGetMetric(
          { tenant_id: "t1", run_id, log: () => undefined },
          { metric_id: "gross_revenue", window: { preset: "last_7d" } },
          { now: () => new Date("2026-09-28T15:00:00Z"), resolveTz: async () => ({ tz: "UTC", source: "stored" }), readDataNotes: async () => [] },
        );
        return { ok: true, is_error: false, content: JSON.stringify(out), ms: 3 };
      });
      const dispatch = makeDispatchTool(deps(run_id, callMcpTool as unknown as MakeDispatchToolDeps["callMcpTool"]));
      const res = await dispatch({ tool_name: toolName, input: {}, tool_use_id: "tu-1" });
      expect(res.is_error).toBe(false);
      expect(callMcpTool).toHaveBeenCalledTimes(1);

      expect(pullsForFigure(run_id, "45678.91")).toEqual([{ tool: "growth__get_metric", nth: 1 }]);
      expect(toolCallCount(run_id, "growth__get_metric")).toBe(1);
      expect(toolCallCount(run_id, toolName)).toBe(toolName === "growth__get_metric" ? 1 : 0);
    });
  }

  it("an ordinary tool is still recorded by the funnel", async () => {
    const run_id = "run-ordinary";
    const callMcpTool = vi.fn(async (): Promise<McpCallResult> => ({
      ok: true,
      is_error: false,
      content: JSON.stringify({ spend: 31337 }),
      ms: 1,
    }));
    const dispatch = makeDispatchTool(deps(run_id, callMcpTool as unknown as MakeDispatchToolDeps["callMcpTool"]));
    await dispatch({ tool_name: "growth__read_revenue", input: {}, tool_use_id: "tu-2" });
    expect(pullsForFigure(run_id, "31337")).toEqual([{ tool: "growth__read_revenue", nth: 1 }]);
  });
});
