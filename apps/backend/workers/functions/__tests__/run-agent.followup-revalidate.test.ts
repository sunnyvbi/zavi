
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
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
  resolveCheckoutBase: vi.fn(),
}));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/services/sandbox/e2b-client", () => ({ extendSandboxTimeout: vi.fn() }));
vi.mock("@/services/sandbox/keepalive-flag", () => ({ getTenantSandboxKeepalive: vi.fn() }));
vi.mock("@/services/sandbox/browser-mcp/anchor-backend", () => ({
  closeAnchorRun: vi.fn(), anchorBackend: { runOp: vi.fn() },
  getBrowserActionEmitter: vi.fn(() => ({ emit: vi.fn() })),
  BROWSER_ACTION_DECISION_CLASS: "browser_action",
}));
vi.mock("@/services/sandbox/browser-mcp/backend", () => ({ _clearRunBrowserState: vi.fn() }));
vi.mock("@/services/agents/engine/capture-ledger", () => ({ clearCaptureLedger: vi.fn() }));
vi.mock("@/services/agents/engine/investor-db-ledger", () => ({ clearInvestorDbLedger: vi.fn() }));
vi.mock("@/services/connectors/github/oauth", () => ({ mintInstallationToken: vi.fn() }));
vi.mock("@/services/agents/cron-summary", () => ({ writeCronRunSummary: vi.fn() }));
vi.mock("@/services/sandbox/repo-picker", () => ({ pickRepoForTask: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/agents/predictions", () => ({ recordPredictions: vi.fn() }));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({ assertProvisionedRepoTarget: vi.fn(), realProvisionedRepoGateDeps: {} }));
vi.mock("@/services/agents/usage-limit-alert", () => ({ maybeSendUsageLimitAlert: vi.fn() }));
vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: vi.fn() }));
vi.mock("@/services/agents/run-agent-concurrency", () => ({ resolveRunAgentGlobalConcurrency: vi.fn() }));
vi.mock("./finalize-run", () => ({ finalizeRun: vi.fn() }));

import {
  downgradeFollowupToNewPr,
  engineerFollowupTargetIsLive,
} from "../run-agent";

const FOLLOWUP = {
  kind: "engineer_pr_followup",
  checkout_ref: "engineer/del-399-x",
  target_pr_number: 285,
  target_pr_repo: "rravi149/OraiCarAndroid",
  target_pr_url: "https://github.com/rravi149/OraiCarAndroid/pull/285",
  source: "slack",
  instruction: "Apply this to PR #285",
  slack: { channel_id: "C1", thread_ts: "1.1" },
};

const okRes = (obj: unknown) => ({ is_error: false, content: JSON.stringify(obj) });
const errRes = (content: string) => ({ is_error: true, content });

describe("downgradeFollowupToNewPr", () => {
  it("strips every follow-up key + adds superseded/repo_hint, keeps slack block", () => {
    const out = downgradeFollowupToNewPr(FOLLOWUP);
    expect(out.kind).toBeUndefined();
    expect(out.checkout_ref).toBeUndefined();
    expect(out.head_branch).toBeUndefined();
    expect(out.target_pr_number).toBeUndefined();
    expect(out.target_pr_repo).toBeUndefined();
    expect(out.target_pr_url).toBeUndefined();
    expect(out.superseded_pr_number).toBe(285);
    expect(out.superseded_pr_repo).toBe("rravi149/OraiCarAndroid");
    expect(out.repo_hint).toBe("rravi149/OraiCarAndroid");
    expect(out.slack).toEqual({ channel_id: "C1", thread_ts: "1.1" });
  });

  it("also strips a legacy head_branch override", () => {
    const out = downgradeFollowupToNewPr({ ...FOLLOWUP, head_branch: "engineer/del-399-x" });
    expect(out.head_branch).toBeUndefined();
    expect(out.checkout_ref).toBeUndefined();
  });
});

describe("engineerFollowupTargetIsLive", () => {
  it("MERGED PR (state=closed merged=true) → not live (the prod bug)", async () => {
    const callMcpTool = vi.fn().mockResolvedValue(
      okRes({ number: 285, state: "closed", merged: true, head_branch: "engineer/del-399-x" }),
    );
    const live = await engineerFollowupTargetIsLive("t", "r", FOLLOWUP, { callMcpTool: callMcpTool as never });
    expect(live).toBe(false);
    expect(callMcpTool).toHaveBeenCalledWith(
      { tenant_id: "t", run_id: "r" }, "github", "get_pr",
      { owner: "rravi149", repo: "OraiCarAndroid", pull_number: 285 },
    );
  });

  it("OPEN PR with matching head → live (still pushes to the same PR)", async () => {
    const callMcpTool = vi.fn().mockResolvedValue(
      okRes({ number: 285, state: "open", merged: false, head_branch: "engineer/del-399-x" }),
    );
    expect(await engineerFollowupTargetIsLive("t", "r", FOLLOWUP, { callMcpTool: callMcpTool as never })).toBe(true);
  });

  it("OPEN PR whose live head DRIFTED from checkout_ref → not live (don't push wrong branch)", async () => {
    const callMcpTool = vi.fn().mockResolvedValue(
      okRes({ number: 285, state: "open", merged: false, head_branch: "engineer/something-else" }),
    );
    expect(await engineerFollowupTargetIsLive("t", "r", FOLLOWUP, { callMcpTool: callMcpTool as never })).toBe(false);
  });

  it("closed-not-merged PR → not live (supersede → new PR)", async () => {
    const callMcpTool = vi.fn().mockResolvedValue(
      okRes({ number: 285, state: "closed", merged: false, head_branch: "engineer/del-399-x" }),
    );
    expect(await engineerFollowupTargetIsLive("t", "r", FOLLOWUP, { callMcpTool: callMcpTool as never })).toBe(false);
  });

  it("get_pr 404/not_found → not live (PR gone)", async () => {
    const callMcpTool = vi.fn().mockResolvedValue(errRes("not_found: 285"));
    expect(await engineerFollowupTargetIsLive("t", "r", FOLLOWUP, { callMcpTool: callMcpTool as never })).toBe(false);
  });

  it("get_pr transient error → conservatively LIVE (worktree fellBack is the net)", async () => {
    const callMcpTool = vi.fn().mockResolvedValue(errRes("github HTTP 503"));
    expect(await engineerFollowupTargetIsLive("t", "r", FOLLOWUP, { callMcpTool: callMcpTool as never })).toBe(true);
  });

  it("non-follow-up payload → live (nothing to revalidate, no probe)", async () => {
    const callMcpTool = vi.fn();
    expect(await engineerFollowupTargetIsLive("t", "r", { kind: "manual" }, { callMcpTool: callMcpTool as never })).toBe(true);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("malformed follow-up (missing target_pr_repo) → live, no probe", async () => {
    const callMcpTool = vi.fn();
    const bad = { ...FOLLOWUP, target_pr_repo: undefined };
    expect(await engineerFollowupTargetIsLive("t", "r", bad as never, { callMcpTool: callMcpTool as never })).toBe(true);
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});
