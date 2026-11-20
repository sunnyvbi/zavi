
import { describe, it, expect, vi } from "vitest";

vi.mock("../openai-sandbox-tools", () => ({
  SANDBOX_SERVER_ID: "sandbox",
  isCanonicalSandboxTool: () => false,
  CANONICAL_SANDBOX_TOOL_PREFIX: "sandbox__",
  CANONICAL_SANDBOX_READ_ONLY_TOOLS: new Set<string>(),
  SHADOW_EXCLUDED_SANDBOX_TOOLS: new Set<string>(),
  SHADOW_SANDBOX_TOOL_NAMES: [],
}));
vi.mock("../../best-of-n", () => ({ isDraftDeniedTool: () => false }));
vi.mock("../../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("../../deepagent/engine", () => ({}));

import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import { figureWasRead, ledgerIsEmpty, pullsForFigure, refusedReadsFor } from "../figure-ledger";
import type { AccessNote } from "@/services/data-gateway/types";

function deps(run_id: string, result: { ok: boolean; is_error: boolean; content: string; access_notes?: AccessNote[] }): MakeDispatchToolDeps {
  return {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: vi.fn().mockResolvedValue({ ...result, ms: 3 }) as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "cgo",
    baseCallCtx: { tenant_id: "t1", run_id },
    onEvent: () => {},
    iter: { value: 1 },
  };
}

describe("makeDispatchTool — figure ledger (SDK path)", () => {
  it("a successful tool result records its figures against the pull", async () => {
    const dispatch = makeDispatchTool(
      deps("r-ledger-ok", {
        ok: true,
        is_error: false,
        content: JSON.stringify({ totals: { spend_usd: 1546.23, clicks: 8123 } }),
      }),
    );
    await dispatch({ tool_name: "growth__read_ads_perf", input: {}, tool_use_id: "tu-1" });
    expect(figureWasRead("r-ledger-ok", "1546.23")).toBe(true);
    expect(pullsForFigure("r-ledger-ok", "8123")).toEqual([{ tool: "growth__read_ads_perf", nth: 1 }]);
  });

  it("an error result records nothing", async () => {
    const dispatch = makeDispatchTool(
      deps("r-ledger-err", {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "meta_ads_timeout", retry_after: 4242 }),
      }),
    );
    await dispatch({ tool_name: "meta_ads__list_campaigns", input: {}, tool_use_id: "tu-2" });
    expect(ledgerIsEmpty("r-ledger-err")).toBe(true);
  });

  it("a database read's access notes ride onto the pull; a refused read is kept for the answer", async () => {
    const note: AccessNote = { log_id: "aaaaaaaa-1111-4111-8111-111111111111", mode: "connector", tables: ["bookings"], rows: 3, result: "allowed" };
    await makeDispatchTool(
      deps("r-ledger-db", { ok: true, is_error: false, content: '{"rows":[{"n":7788}]}', access_notes: [note] }),
    )({ tool_name: "operator_db__query", input: {}, tool_use_id: "tu-3" });
    expect(pullsForFigure("r-ledger-db", "7788")).toEqual([{ tool: "operator_db__query", nth: 1, access: [note] }]);
    const refused: AccessNote = { ...note, result: "refused", refused_by: "connector", reason: "x", rows: 0 };
    await makeDispatchTool(
      deps("r-ledger-db", { ok: false, is_error: true, content: '{"error":"data_access_refused"}', access_notes: [refused] }),
    )({ tool_name: "operator_db__query", input: {}, tool_use_id: "tu-4" });
    expect(refusedReadsFor("r-ledger-db")).toEqual([refused]);
  });
});
