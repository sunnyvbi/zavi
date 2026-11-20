import { describe, it, expect, vi, beforeEach } from "vitest";
import { moneyCardFingerprint } from "@/services/approvals/money-card";

const mocks = vi.hoisted(() => ({
  pay: vi.fn(),
  remit: vi.fn(),
  held: null as null | Record<string, unknown>,
}));

vi.mock("@/services/tools/stripe/create_payment", () => ({ createPaymentTool: { name: "stripe_create_payment", execute: mocks.pay } }));
vi.mock("@/services/tools/stripe/remit_to_tenant", () => ({ remitToTenantTool: { name: "stripe_remit_to_tenant", execute: mocks.remit } }));
vi.mock("@/services/tools/stripe/held-funds", () => ({ findHeldFundByRef: async () => mocks.held }));
vi.mock("@/services/tools/stripe/submit_dispute_evidence", () => ({ submitDisputeEvidenceTool: { name: "x", execute: vi.fn() } }));
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

function decision(cls: string, fields: Record<string, unknown>) {
  const body = { ...fields, governed_by: "chokepoint" };
  return {
    id: "d-1", tenant_id: "t-1", agent_run_id: "run-1", decision_class: cls, status: "approved", handler: cls,
    body: { ...body, fingerprint: moneyCardFingerprint(cls, body) } as Record<string, unknown>,
  };
}
const CHARGE = { amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "order-7", receipt_email: "a@b.co" };
const PAYOUT = { client_reference: "order-7", description: null, held_fund_id: "hf-1", currency: "usd", gross_minor: 10_000, reserve_minor: 1_000, fee_minor: 500, net_minor: 8_500 };
const HELD = { id: "hf-1", client_reference: "order-7", status: "held", currency: "usd", amount_minor: 10_000, reserve_held_minor: 1_000, platform_fee_minor: 500 };

beforeEach(() => {
  mocks.pay.mockReset().mockResolvedValue({ status: "requires_payment_method" });
  mocks.remit.mockReset().mockResolvedValue({ transfer_id: "tr_1" });
  mocks.held = { ...HELD };
});

describe("stripe.create_payment handler", () => {
  it("charges exactly the card's fields, for the decision's tenant", async () => {
    const r = await HANDLERS["stripe.create_payment"](decision("stripe.create_payment", CHARGE) as never);
    expect(r.ok).toBe(true);
    expect(mocks.pay).toHaveBeenCalledTimes(1);
    const [ctx, input] = mocks.pay.mock.calls[0];
    expect(ctx.tenant_id).toBe("t-1");
    expect(input).toEqual(CHARGE);
  });
  it("a body edited after approval charges nothing", async () => {
    const d = decision("stripe.create_payment", CHARGE);
    d.body.amount = 199_900;
    const r = await HANDLERS["stripe.create_payment"](d as never);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stale_card/);
    expect(mocks.pay).not.toHaveBeenCalled();
  });
  it("a tool refusal (cap, rail off) fails the card with its reason", async () => {
    mocks.pay.mockRejectedValue(new Error("payment_cap_exceeded: daily cap reached"));
    const r = await HANDLERS["stripe.create_payment"](decision("stripe.create_payment", CHARGE) as never);
    expect(r).toMatchObject({ ok: false, error: "payment_cap_exceeded: daily cap reached" });
  });
});

describe("stripe.remit_to_tenant handler", () => {
  it("pays out the held collection the card showed", async () => {
    const r = await HANDLERS["stripe.remit_to_tenant"](decision("stripe.remit_to_tenant", PAYOUT) as never);
    expect(r.ok).toBe(true);
    expect(mocks.remit.mock.calls[0][1]).toEqual({ client_reference: "order-7" });
  });
  it.each([
    ["the row was paid out since", { status: "remitted" }],
    ["the reserve changed", { reserve_held_minor: 0 }],
    ["the gross changed", { amount_minor: 20_000 }],
    ["a different row now has that reference", { id: "hf-2" }],
  ])("%s: nothing is paid out", async (_l, patch) => {
    mocks.held = { ...HELD, ...patch };
    const r = await HANDLERS["stripe.remit_to_tenant"](decision("stripe.remit_to_tenant", PAYOUT) as never);
    expect(r.error).toMatch(/stale_card/);
    expect(mocks.remit).not.toHaveBeenCalled();
  });
  it("a transfer that may have gone through is outcome unknown, never failed", async () => {
    mocks.remit.mockImplementation(async () => {
      mocks.held = { ...HELD, status: "remitting" };
      throw new Error("stripe_api_error: timeout");
    });
    const r = await HANDLERS["stripe.remit_to_tenant"](decision("stripe.remit_to_tenant", PAYOUT) as never);
    expect(r).toMatchObject({ ok: false, outcome_unknown: true });
  });
  it("a transfer Stripe rejected (row back to held) is a plain failure", async () => {
    mocks.remit.mockRejectedValue(new Error("stripe_api_error: invalid destination"));
    const r = await HANDLERS["stripe.remit_to_tenant"](decision("stripe.remit_to_tenant", PAYOUT) as never);
    expect(r).toMatchObject({ ok: false, error: "stripe_api_error: invalid destination" });
    expect(r.outcome_unknown).toBeUndefined();
  });
  it("no held row: nothing is paid out", async () => {
    mocks.held = null;
    const r = await HANDLERS["stripe.remit_to_tenant"](decision("stripe.remit_to_tenant", PAYOUT) as never);
    expect(r.ok).toBe(false);
    expect(mocks.remit).not.toHaveBeenCalled();
  });
  it("a body edited after approval pays out nothing", async () => {
    const d = decision("stripe.remit_to_tenant", PAYOUT);
    d.body.net_minor = 10_000;
    expect((await HANDLERS["stripe.remit_to_tenant"](d as never)).error).toMatch(/stale_card/);
    expect(mocks.remit).not.toHaveBeenCalled();
  });
});
