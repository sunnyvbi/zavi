
import { describe, it, expect, vi, beforeEach } from "vitest";

const ledgerKeys: Array<string | undefined> = [];

vi.mock("@/services/mcp/tool-effect-ledger", () => ({
  isToolEffectLedgerEnabled: () => true,
  runWithToolEffectGuard: vi.fn(
    async (ctx: { tool_use_id?: string }, _tool: string, _args: unknown) => {
      ledgerKeys.push(ctx.tool_use_id);
      return { ok: true, content: "{}", is_error: false, ms: 0 };
    },
  ),
}));

vi.mock("@/services/mcp/governance-enforce", () => ({
  governActionOrBlock: async () => ({ block: false }),
}));

vi.mock("@/services/mcp/tool-effect-classifier", () => ({
  isSideEffectingTool: (server_id: string) => server_id !== "tenant_skill",
}));

vi.mock("@/services/routines/runner", () => ({
  runTenantRoutine: vi.fn(
    async (
      _input: unknown,
      deps: {
        callStep: (
          s: string,
          t: string,
          a: unknown,
          i: number,
        ) => Promise<{ is_error: boolean; content: string }>;
      },
    ) => {
      await deps.callStep("nonwired", "step_a", { x: 1 }, 0);
      await deps.callStep("nonwired", "step_b", { x: 2 }, 1);
      return { ok: true, content: "{}" };
    },
  ),
  defaultDeps: () => ({}),
  RoutineRunnerDb: class {},
}));

vi.mock("@/services/routines/tool-name", () => ({ ROUTINE_SERVER_ID: "tenant_skill" }));

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: async () => null }));

import { callMcpTool, type CallMcpContext } from "../execute";

describe("execute — per-step ledger key for replayed routine steps", () => {
  beforeEach(() => {
    ledgerKeys.length = 0;
  });

  it("derives a DISTINCT tool_use_id per routine step (no ledger-key collision)", async () => {
    const ctx: CallMcpContext = {
      tenant_id: "t1",
      run_id: "run-1",
      agent_slug: "cto-engineer",
      tool_use_id: "outer-tu",
    };
    await callMcpTool(ctx, "tenant_skill", "cto-engineer__abc12345", {});

    expect(ledgerKeys).toHaveLength(2);
    expect(new Set(ledgerKeys).size).toBe(2);
    expect(ledgerKeys).not.toContain("outer-tu");
    expect(ledgerKeys[0]).toBe("outer-tu__skillstep_0");
    expect(ledgerKeys[1]).toBe("outer-tu__skillstep_1");
  });
});
