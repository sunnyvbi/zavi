
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureMock: vi.fn(),
  rpcMock: vi.fn(
    async (
      _fn?: string,
      _args?: Record<string, unknown>,
    ): Promise<{ data: unknown; error: { message: string } | null }> => ({
      data: null,
      error: null,
    }),
  ),
  serviceClientMock: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

vi.mock("@/services/provisioning/github-repo", () => {
  class CredentialNotConfigured extends Error {
    constructor(public readonly key: string) {
      super(`missing ${key}`);
      this.name = "CredentialNotConfigured";
    }
  }
  return { CredentialNotConfigured };
});
vi.mock("@/services/provisioning/stripe-connect", () => ({
  createStripeConnectProvisioner: () => ({
    kind: "stripe",
    provider: "stripe-connect",
    ensure: mocks.ensureMock,
    teardown: vi.fn(),
  }),
}));

import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({
  prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
  prProposalProductBuildSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
}));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/decisions/waiver-resolve", () => ({ resolveWaiverState: vi.fn(async () => ({ state: "none" })) }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({ updateAdSetBudgetBodySchema: {}, setStatusBodySchema: {}, createAdSetBodySchema: {} }));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: vi.fn() }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({ assertProvisionedRepoTarget: vi.fn() }));
vi.mock("@/services/provisioning/user-repo-gate", () => ({ assertUserRepoTarget: vi.fn() }));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const baseDecision = {
  id: "d-1",
  tenant_id: "t-1",
  agent_run_id: null,
  decision_class: "stripe.create_connected_account",
  body: { company_name: "Acme" },
  status: "approved",
  handler: "stripe.create_connected_account",
};

beforeEach(() => {
  mocks.ensureMock.mockReset();
  mocks.rpcMock.mockReset();
  mocks.rpcMock.mockResolvedValue({ data: null, error: null });
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({ rpc: mocks.rpcMock }));
});

describe("stripe.create_connected_account dispatch handler", () => {
  it("creates the account + records a 'ready' tenant_resources row on success", async () => {
    mocks.ensureMock.mockResolvedValueOnce({
      external_ref: { stripe_account_id: "acct_999", onboarding_url: "https://connect/x" },
      vault_keys: {},
    });
    const res = await HANDLERS["stripe.create_connected_account"](baseDecision);
    expect(res.ok).toBe(true);
    expect(res.notice).toContain("acct_999");
    const rpcCall = mocks.rpcMock.mock.calls[0];
    expect(rpcCall[0]).toBe("set_tenant_resource");
    expect(rpcCall[1]).toMatchObject({
      p_tenant_id: "t-1",
      p_resource_kind: "stripe",
      p_status: "ready",
      p_vault_key: null,
      p_external_ref: { stripe_account_id: "acct_999", onboarding_url: "https://connect/x" },
    });
  });

  it("records a 'pending' row + succeeds-soft when the E3 gate is off (inert)", async () => {
    mocks.ensureMock.mockRejectedValueOnce(new CredentialNotConfigured("STRIPE_PROVISIONING_ENABLED"));
    const res = await HANDLERS["stripe.create_connected_account"](baseDecision);
    expect(res.ok).toBe(true);
    expect(res.notice).toMatch(/gated off/i);
    const rpcCall = mocks.rpcMock.mock.calls[0];
    expect(rpcCall[1]).toMatchObject({ p_status: "pending", p_external_ref: {} });
  });

  it("rejects a missing company_name", async () => {
    const res = await HANDLERS["stripe.create_connected_account"]({ ...baseDecision, body: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/company_name/);
    expect(mocks.ensureMock).not.toHaveBeenCalled();
  });

  it("surfaces a real (non-credential) provisioner error as ok:false", async () => {
    mocks.ensureMock.mockRejectedValueOnce(new Error("stripe account create failed (402)"));
    const res = await HANDLERS["stripe.create_connected_account"](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/402/);
  });

  it("fails when set_tenant_resource RPC errors", async () => {
    mocks.ensureMock.mockResolvedValueOnce({ external_ref: { stripe_account_id: "acct_1" }, vault_keys: {} });
    mocks.rpcMock.mockResolvedValueOnce({ data: null, error: { message: "rls denied" } });
    const res = await HANDLERS["stripe.create_connected_account"](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/set_tenant_resource failed/);
  });
});
