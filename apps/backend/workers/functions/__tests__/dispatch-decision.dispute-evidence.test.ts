
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  submitMock: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

vi.mock("@/services/tools/stripe/submit_dispute_evidence", () => ({
  submitDisputeEvidenceTool: {
    name: "stripe_submit_dispute_evidence",
    execute: mocks.submitMock,
  },
}));

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
    ensure: vi.fn(),
    teardown: vi.fn(),
  }),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn(() => ({ rpc: vi.fn(), from: vi.fn() })) }));
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
vi.mock("@/services/agents/class-cap", () => ({ consumeClassBudget: vi.fn() }));
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
vi.mock("@/services/tools/meta-ads/write/_user-initiated", () => ({ minMergeCap: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: vi.fn() }));
vi.mock("@/services/comms/outbound-send", () => ({ sendOutbound: vi.fn() }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  extractSlackRouting: vi.fn(),
}));
vi.mock("@/services/tools/slack/mrkdwn", () => ({ mdToMrkdwn: vi.fn() }));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({ assertProvisionedRepoTarget: vi.fn() }));
vi.mock("@/services/provisioning/user-repo-gate", () => ({ assertUserRepoTarget: vi.fn() }));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const validBody = {
  evidence_packet: {
    dispute_id: "dp_abc",
    evidence_fields: {
      customer_communication: "buyer↔seller chat",
      uncategorized_text: "drafted rebuttal",
    },
    recommendation: "fight" as const,
    win_band: "High" as const,
  },
};

const baseDecision = {
  id: "d-1",
  tenant_id: "t-1",
  agent_run_id: "run-1",
  decision_class: "dispute-response.submit-evidence",
  body: validBody as Record<string, unknown>,
  status: "approved",
  handler: "stripe.submit_dispute_evidence",
};

function stripeOk() {
  return {
    id: "dp_abc",
    status: "needs_response",
    submitted_at: null,
    evidence_due_by: 1_700_000_000,
    submission_count: 0,
  };
}

beforeEach(() => {
  mocks.submitMock.mockReset();
  mocks.submitMock.mockResolvedValue(stripeOk());
});

describe("stripe.submit_dispute_evidence dispatch handler — money path", () => {
  it("FIRST Stripe call is submit:false (save-as-draft) by default", async () => {
    const res = await HANDLERS["stripe.submit_dispute_evidence"](baseDecision);
    expect(res.ok).toBe(true);
    expect(res.notice).toMatch(/DRAFT/i);
    expect(mocks.submitMock).toHaveBeenCalledTimes(1);
    const [, input] = mocks.submitMock.mock.calls[0];
    expect(input).toMatchObject({
      dispute_id: "dp_abc",
      submit: false,
      evidence: { customer_communication: "buyer↔seller chat", uncategorized_text: "drafted rebuttal" },
    });
  });

  it("does NOT final-submit unless submit_final:true (the second gate)", async () => {
    await HANDLERS["stripe.submit_dispute_evidence"](baseDecision);
    expect(mocks.submitMock.mock.calls[0][1].submit).toBe(false);
    mocks.submitMock.mockClear();

    const res = await HANDLERS["stripe.submit_dispute_evidence"]({
      ...baseDecision,
      body: { ...validBody, submit_final: true } as Record<string, unknown>,
    });
    expect(res.ok).toBe(true);
    expect(res.notice).toMatch(/closed for further evidence/i);
    expect(mocks.submitMock.mock.calls[0][1].submit).toBe(true);
  });

  it("rejects a PII-smuggled body (customer_name) BEFORE any Stripe call", async () => {
    const res = await HANDLERS["stripe.submit_dispute_evidence"]({
      ...baseDecision,
      body: {
        evidence_packet: {
          dispute_id: "dp_abc",
          evidence_fields: { customer_name: "Jane Cardholder" },
        },
      } as Record<string, unknown>,
    });
    expect(res.ok).toBe(false);
    expect(mocks.submitMock).not.toHaveBeenCalled();
  });

  it("rejects a non-dp_ dispute id BEFORE any Stripe call", async () => {
    const res = await HANDLERS["stripe.submit_dispute_evidence"]({
      ...baseDecision,
      body: {
        evidence_packet: { dispute_id: "nope", evidence_fields: { receipt: "r" } },
      } as Record<string, unknown>,
    });
    expect(res.ok).toBe(false);
    expect(mocks.submitMock).not.toHaveBeenCalled();
  });

  it("surfaces a Stripe tool error as ok:false (no throw escapes)", async () => {
    mocks.submitMock.mockRejectedValueOnce(new Error("stripe 402 evidence rejected"));
    const res = await HANDLERS["stripe.submit_dispute_evidence"](baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/402/);
  });

  it("is registered in the HANDLERS registry (no stub, no missing handler)", () => {
    expect(typeof HANDLERS["stripe.submit_dispute_evidence"]).toBe("function");
  });
});
