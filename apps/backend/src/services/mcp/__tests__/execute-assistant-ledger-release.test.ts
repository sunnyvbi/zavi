import { describe, it, expect, vi } from "vitest";

const report = vi.fn();
let guardSaw: "result" | "throw" | null = null;
vi.mock("../tool-effect-ledger", () => ({
  isToolEffectLedgerEnabled: () => true,
  runWithToolEffectGuard: async (_c: unknown, _t: unknown, _a: unknown, raw: () => Promise<unknown>) => {
    try {
      const r = await raw();
      guardSaw = "result";
      return r;
    } catch (e) {
      guardSaw = "throw";
      throw e;
    }
  },
}));
vi.mock("../tool-effect-classifier", () => ({ isSideEffectingTool: () => true }));
vi.mock("../governance-enforce", () => ({ governActionOrBlock: async () => ({ block: false }) }));
vi.mock("../discovery", () => ({ getEnabledStreamableServer: async () => null }));
vi.mock("../streamable-client", () => ({ callStreamableTool: vi.fn(), advertisedReadToolNames: () => new Set() }));
vi.mock("../internal/praxis", () => ({ callPraxisTool: vi.fn(), listPraxisTools: () => [] }));
vi.mock("../internal/report", () => ({
  callReportTool: (...a: unknown[]) => report(...(a as [])),
  listReportTools: () => [],
}));
vi.mock("@/services/routines/runner", () => ({ runTenantRoutine: vi.fn(), defaultDeps: {} }));
vi.mock("@/services/agents/skill-runtime", () => ({ handleSkillLoad: vi.fn() }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import { callMcpTool, type CallMcpContext } from "../execute";

const ctx = (trigger: string) =>
  ({ tenant_id: "T1", run_id: "R1", tool_use_id: "U1", agent_slug: "operator", trigger }) as CallMcpContext;

describe("tool-effect ledger on an assistant run", () => {
  it("sees an error result for a purchase-related throw", async () => {
    const e = new Error("out of credits — top up");
    e.name = "InsufficientCreditsError";
    report.mockRejectedValueOnce(e);
    guardSaw = null;
    const r = await callMcpTool(ctx("mcp"), "report", "render_pdf", {});
    expect(guardSaw).toBe("result");
    expect(r.is_error).toBe(true);
  });

  it("still sees the throw on a chat run", async () => {
    const e = new Error("out of credits — top up");
    e.name = "InsufficientCreditsError";
    report.mockRejectedValueOnce(e);
    guardSaw = null;
    await expect(callMcpTool(ctx("chat"), "report", "render_pdf", {})).rejects.toThrow();
    expect(guardSaw).toBe("throw");
  });
});
