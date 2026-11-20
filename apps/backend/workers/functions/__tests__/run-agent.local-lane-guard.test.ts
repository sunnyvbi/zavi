
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

vi.mock("@/services/agents/runner", () => ({
  AgentNotFoundError: class AgentNotFoundError extends Error {},
  buildContext: vi.fn(), claimAgentRun: vi.fn(), enqueueAgentRun: vi.fn(),
  persistTerminal: vi.fn(), postRunDistill: vi.fn(), runDispatch: vi.fn(),
}));
vi.mock("@/services/memory/takes-service", () => ({ recordAgentTake: vi.fn() }));
vi.mock("@/agents/index", () => ({ postProcessors: {} }));
vi.mock("@/services/agents/progress", () => ({ makeEmitProgress: () => vi.fn() }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/agents/model-router", () => ({ resolveModelForRun: vi.fn() }));
vi.mock("@/services/agents/ensure-runnable", () => ({ ensureAgentRunnable: vi.fn() }));
vi.mock("@/services/notifications/push-fanout", () => ({ sendPushForEvent: vi.fn() }));
vi.mock("@/services/sandbox/lifecycle", () => ({
  bootstrapRepoIfNeeded: vi.fn(), injectSandboxSecrets: vi.fn(), pauseAndMarkPaused: vi.fn(),
  resolveSandboxForRun: vi.fn(), resolveStoredDefaultBranch: vi.fn(), wipeSandboxSecrets: vi.fn(),
}));
vi.mock("@/services/sandbox/run-worktree", () => ({
  createRunWorktree: vi.fn(), reapOrphanWorktrees: vi.fn(), removeRunWorktree: vi.fn(),
}));
vi.mock("@/services/sandbox/e2b-client", () => ({ extendSandboxTimeout: vi.fn() }));
vi.mock("@/services/sandbox/keepalive-flag", () => ({ getTenantSandboxKeepalive: vi.fn() }));
vi.mock("@/services/sandbox/browser-mcp/anchor-backend", () => ({
  closeAnchorRun: vi.fn(),
  anchorBackend: { runOp: vi.fn() },
  getBrowserActionEmitter: vi.fn(() => ({ emit: vi.fn() })),
  BROWSER_ACTION_DECISION_CLASS: "browser_action",
}));
vi.mock("@/services/sandbox/browser-mcp/backend", () => ({
  _clearRunBrowserState: vi.fn(),
}));
vi.mock("@/services/agents/engine/capture-ledger", () => ({ clearCaptureLedger: vi.fn() }));
vi.mock("@/services/connectors/github/oauth", () => ({ mintInstallationToken: vi.fn() }));
vi.mock("@/services/agents/cron-summary", () => ({ writeCronRunSummary: vi.fn() }));
vi.mock("@/services/sandbox/repo-picker", () => ({ pickRepoForTask: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/agents/predictions", () => ({ recordPredictions: vi.fn() }));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({
  assertProvisionedRepoTarget: vi.fn(),
  realProvisionedRepoGateDeps: {},
}));

import { isLocalDelegatedRun } from "../run-agent";

const RUN_ID = "11111111-1111-1111-1111-111111111111";

function makeSb(row: unknown) {
  const eqCalls: Array<[string, unknown]> = [];
  const fromCalls: string[] = [];
  const sb = {
    from: (table: string) => {
      fromCalls.push(table);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return builder;
        },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return builder;
    },
  };
  return { sb, eqCalls, fromCalls };
}

beforeEach(() => {
  mocks.serviceClientMock.mockReset();
});

describe("isLocalDelegatedRun — Mac local-lane guard", () => {
  it("returns true when a local-lane work item is linked to the run", async () => {
    const { sb } = makeSb({ id: "wi-1" });
    const result = await isLocalDelegatedRun(
      sb as unknown as ReturnType<typeof import("@/services/supabase").serviceClient>,
      RUN_ID,
    );
    expect(result).toBe(true);
  });

  it("returns false when no local-lane work item links the run (cloud run, common case)", async () => {
    const { sb } = makeSb(null);
    const result = await isLocalDelegatedRun(
      sb as unknown as ReturnType<typeof import("@/services/supabase").serviceClient>,
      RUN_ID,
    );
    expect(result).toBe(false);
  });

  it("queries agent_work_items filtered by agent_run_id AND lane='local' (no e2b-lane false positives)", async () => {
    const { sb, eqCalls, fromCalls } = makeSb({ id: "wi-1" });
    await isLocalDelegatedRun(
      sb as unknown as ReturnType<typeof import("@/services/supabase").serviceClient>,
      RUN_ID,
    );
    expect(fromCalls).toEqual(["agent_work_items"]);
    expect(eqCalls).toContainEqual(["agent_run_id", RUN_ID]);
    expect(eqCalls).toContainEqual(["lane", "local"]);
  });
});
