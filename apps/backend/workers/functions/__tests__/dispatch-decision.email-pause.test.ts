import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();
const claimDecisionMock = vi.fn();
const isFleetHaltedMock = vi.fn(async () => false);
const metaWriteEnabled = vi.fn(async () => true);
const googleWriteEnabled = vi.fn(async () => true);
const metaSetStatusMock = vi.fn(async () => ({ ok: true }));

const decisionsUpdates: Array<Record<string, unknown>> = [];
const releaseClaimMock = vi.fn(async (..._a: unknown[]) => {});
const pausedMock = vi.fn(async (..._a: unknown[]) => true);
const campaignSendMock = vi.fn(async (..._a: unknown[]) => ({ ok: true, notice: "Sent" }));
const bulkDispatchMock = vi.fn(async (..._a: unknown[]) => ({ ok: false, status: "refused", code: "x", sentence: "x" }));

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
}));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: (...a: unknown[]) => getVisibleAgentSlugs(...a),
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "decisions") {
        return {
          update: (payload: Record<string, unknown>) => {
            decisionsUpdates.push(payload);
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  }),
}));

vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({
  isMetaAdsWriteEnabled: () => metaWriteEnabled(),
}));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({
  isGoogleAdsWriteEnabled: () => googleWriteEnabled(),
}));

const sendFundraisingMock = vi.fn(async (..._a: unknown[]) => ({ ok: true, provider: "sendgrid", message_id: "m1" }));
vi.mock("@/services/fundraising/send-provider", () => ({
  sendFundraisingEmail: (...a: unknown[]) => sendFundraisingMock(...a),
}));

const lockedChannels = new Set<string>();
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: async (slug: string) => lockedChannels.has(slug),
  isChannelLockedStrict: async (slug: string) => lockedChannels.has(slug),
}));

vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: (id: string) => claimDecisionMock(id),
  releaseClaim: (...a: unknown[]) => releaseClaimMock(...a),
  markDispatched: vi.fn(),
}));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: (...a: unknown[]) => pausedMock(...a) }));
vi.mock("@/services/connectors/email-campaign/execute-send", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeEmailCampaignSendAndTell: (...a: unknown[]) => campaignSendMock(...a),
}));
vi.mock("@/services/comms/bulk-outbound/dispatch", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeBulkOutboundDispatch: (...a: unknown[]) => bulkDispatchMock(...a),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: () => isFleetHaltedMock() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({
  updateAdSetBudgetBodySchema: {},
  setStatusBodySchema: {
    safeParse: (b: unknown) => ({ success: true as const, data: b }),
  },
  createAdSetBodySchema: {},
}));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: (...a: unknown[]) => metaSetStatusMock(...(a as [])) }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
const emailSendMock = vi.fn(async (..._a: unknown[]) => ({ ok: true, messageId: "sg-1", statusCode: 202 }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: (...a: unknown[]) => emailSendMock(...a) }));
const gmailSendMock = vi.fn(async (..._a: unknown[]) => ({ message_id: "gm-1" }));
vi.mock("@/services/connectors/gmail-composio/send", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendFromConnectedGmail: (...a: unknown[]) => gmailSendMock(...a),
}));
const sendOutboundMock = vi.fn(async (..._a: unknown[]) => ({ ok: true, status: "sent", message_id: "sg-1" }));
vi.mock("@/services/comms/outbound-send", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendOutbound: (...a: unknown[]) => sendOutboundMock(...a),
}));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(() => null),
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";

const row = (decision_class: string) => ({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  tenant_id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
  agent_run_id: null,
  decision_class,
  handler: decision_class,
  status: "dispatching",
  approved_by: "owner-1",
  approved_by_source: null,
  body: {},
});

beforeEach(() => {
  decisionsUpdates.length = 0;
  for (const m of [releaseClaimMock, pausedMock, campaignSendMock, bulkDispatchMock, claimDecisionMock, emailSendMock, gmailSendMock, sendOutboundMock]) m.mockClear();
  pausedMock.mockResolvedValue(true);
});

describe("email paused for the workspace", () => {
  for (const cls of ["bulk_outbound.send", "email_campaign.create_and_send"]) {
    it(`${cls}: nothing starts, and the approved send goes back to waiting with its approval (never failed)`, async () => {
      claimDecisionMock.mockResolvedValue(row(cls));
      const r = await executeDispatch(row(cls).id);
      expect(r).toEqual({ ok: false, error: "email_paused" });
      expect(campaignSendMock).not.toHaveBeenCalled();
      expect(bulkDispatchMock).not.toHaveBeenCalled();
      expect(releaseClaimMock).toHaveBeenCalledWith(row(cls).id, "email_paused");
      expect(decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(false);
      expect(pausedMock).toHaveBeenCalledWith(row(cls).tenant_id);
    });
  }

  it("the pause cannot be read: treated as paused, nothing starts", async () => {
    pausedMock.mockRejectedValueOnce(new Error("db down"));
    claimDecisionMock.mockResolvedValue(row("email_campaign.create_and_send"));
    expect(await executeDispatch(row("email_campaign.create_and_send").id)).toEqual({ ok: false, error: "email_paused" });
    expect(campaignSendMock).not.toHaveBeenCalled();
  });

  it("not paused: the send runs", async () => {
    pausedMock.mockResolvedValue(false);
    claimDecisionMock.mockResolvedValue(row("email_campaign.create_and_send"));
    await executeDispatch(row("email_campaign.create_and_send").id);
    expect(campaignSendMock).toHaveBeenCalledTimes(1);
    expect(releaseClaimMock).not.toHaveBeenCalled();
  });
});

describe("email paused: a one-to-one outbound.send", () => {
  const outbound = () => ({ ...row("outbound.send"), body: { channel: "email", to: "parent@example.com", subject: "Your trial lesson", body_text: "Here is the link." } });

  it("sends nothing through any provider and settles failed with the paused sentence, never silently", async () => {
    const { EMAIL_PAUSED_ONE_TO_ONE_ERROR } = await import("@/services/connectors/email-campaign/execute-send");
    claimDecisionMock.mockResolvedValue(outbound());
    const r = await executeDispatch(outbound().id);
    expect(r.ok).toBe(false);
    expect(pausedMock).toHaveBeenCalledWith(outbound().tenant_id);
    expect(sendOutboundMock).not.toHaveBeenCalled();
    expect(emailSendMock).not.toHaveBeenCalled();
    expect(gmailSendMock).not.toHaveBeenCalled();
    const settled = decisionsUpdates.find((u) => u.status === "dispatch_failed");
    expect(settled?.dispatch_error).toBe(EMAIL_PAUSED_ONE_TO_ONE_ERROR);
    expect(settled?.dispatch_error).not.toMatch(/try again/i);
    expect(settled?.dispatch_error).toMatch(/paused/);
    expect(settled?.dispatch_error).toMatch(/ask Zavi again/);
    expect(releaseClaimMock).not.toHaveBeenCalled();
    expect(decisionsUpdates.some((u) => u.status === "acted")).toBe(false);
  });

  it("not paused: the one-to-one email goes out", async () => {
    pausedMock.mockResolvedValue(false);
    claimDecisionMock.mockResolvedValue(outbound());
    const r = await executeDispatch(outbound().id);
    expect(sendOutboundMock).toHaveBeenCalledTimes(1);
    expect((sendOutboundMock.mock.calls[0] as unknown[])[0]).toMatchObject({ tenant_id: outbound().tenant_id, to: "parent@example.com" });
    expect(r.ok).toBe(true);
    expect(decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(false);
  });
});

describe("email paused: a support reply through email.send or the legacy gmail.send", () => {
  for (const cls of ["email.send", "gmail.send"]) {
    const reply = () => ({ ...row(cls), body: { to: "customer@example.com", subject: "Re: your order", body_text: "It ships tomorrow." } });

    it(`${cls}: no provider is called and the decision settles failed with the paused sentence`, async () => {
      const { EMAIL_PAUSED_ONE_TO_ONE_ERROR } = await import("@/services/connectors/email-campaign/execute-send");
      claimDecisionMock.mockResolvedValue(reply());
      const r = await executeDispatch(reply().id);
      expect(r.ok).toBe(false);
      expect(pausedMock).toHaveBeenCalledWith(reply().tenant_id);
      expect(emailSendMock).not.toHaveBeenCalled();
      expect(gmailSendMock).not.toHaveBeenCalled();
      expect(sendOutboundMock).not.toHaveBeenCalled();
      const settled = decisionsUpdates.find((u) => u.status === "dispatch_failed");
      expect(settled?.dispatch_error).toBe(EMAIL_PAUSED_ONE_TO_ONE_ERROR);
      expect(decisionsUpdates.some((u) => u.status === "acted")).toBe(false);
    });

    it(`${cls}: a pause that cannot be read is treated as paused and nothing is sent`, async () => {
      pausedMock.mockRejectedValueOnce(new Error("db down"));
      claimDecisionMock.mockResolvedValue(reply());
      const r = await executeDispatch(reply().id);
      expect(r.ok).toBe(false);
      expect(emailSendMock).not.toHaveBeenCalled();
    });

    it(`${cls}: not paused, the reply goes out once to the right person`, async () => {
      pausedMock.mockResolvedValue(false);
      claimDecisionMock.mockResolvedValue(reply());
      const r = await executeDispatch(reply().id);
      expect(r.ok).toBe(true);
      expect(emailSendMock).toHaveBeenCalledTimes(1);
      expect(emailSendMock.mock.calls[0]).toEqual([reply().tenant_id, expect.objectContaining({ to: "customer@example.com", subject: "Re: your order" })]);
      expect(decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(false);
    });
  }
});


describe("email paused: a fundraising.outbound.send", () => {
  const fr = () => ({ ...row("fundraising.outbound.send"), body: { to: "angel@example.com", subject: "Zavi round", body_text: "Hi" } });

  it("sends nothing and settles failed with the paused sentence", async () => {
    const { EMAIL_PAUSED_ONE_TO_ONE_ERROR } = await import("@/services/connectors/email-campaign/execute-send");
    claimDecisionMock.mockResolvedValue(fr());
    const r = await executeDispatch(fr().id);
    expect(r.ok).toBe(false);
    expect(pausedMock).toHaveBeenCalledWith(fr().tenant_id);
    expect(sendFundraisingMock).not.toHaveBeenCalled();
    const settled = decisionsUpdates.find((u) => u.status === "dispatch_failed");
    expect(settled?.dispatch_error).toBe(EMAIL_PAUSED_ONE_TO_ONE_ERROR);
  });

  it("a pause that cannot be read is treated as paused", async () => {
    pausedMock.mockRejectedValueOnce(new Error("db down"));
    claimDecisionMock.mockResolvedValue(fr());
    const r = await executeDispatch(fr().id);
    expect(r.ok).toBe(false);
    expect(sendFundraisingMock).not.toHaveBeenCalled();
  });
});
