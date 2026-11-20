import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  emailSend: vi.fn(),
  resolveAccount: vi.fn(),
  composioExecuteTool: vi.fn(),
  enforceCommsSafety: vi.fn(),
  consumeSend: vi.fn(),
  callMcpTool: vi.fn(),
  isEmailSuppressed: vi.fn(),
  emailSendPaused: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: mocks.callMcpTool }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: mocks.emailSend }));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: mocks.emailSendPaused }));
vi.mock("@/services/tools/email/safety-net", () => ({ isSuppressed: mocks.isEmailSuppressed }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.resolveAccount }));
vi.mock("@/services/connectors/composio/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  composioExecuteTool: mocks.composioExecuteTool,
}));
vi.mock("@/services/comms/safety-net", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enforceCommsSafety: mocks.enforceCommsSafety,
  supabaseCommsSafetyStore: { consumeSend: mocks.consumeSend },
}));

import { __testOnly_handlers as HANDLERS, OUTBOUND_EMAIL_NOT_CONNECTED } from "../dispatch-decision";
import { GMAIL_UNCONFIRMED } from "@/services/connectors/gmail-composio/send";
import { ExpectedToolError } from "@/services/tools/types";
import { EMAIL_PAUSED_CODE, EMAIL_PAUSED_ONE_TO_ONE_ERROR } from "@/services/connectors/email-campaign/execute-send";

const gmail = { tenant_id: "t-row", toolkit: "gmail", connected_account_id: "ca_gmail_1", auth_config_id: "ac_gmail" };

function notConnected() {
  return Object.assign(new Error("Email is not connected for this workspace."), { code: "email_not_connected" });
}

function outboundDecision(body: Record<string, unknown> = {}) {
  return {
    id: "d-out-1",
    tenant_id: "t-row",
    agent_run_id: "run-1",
    decision_class: "outbound.send",
    body: {
      channel: "email",
      to: "  Parent@Example.com ",
      subject: "Your trial lesson",
      body_text: "Here is the link to book.",
      ...body,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emailSend.mockRejectedValue(notConnected());
  mocks.resolveAccount.mockResolvedValue(gmail);
  mocks.enforceCommsSafety.mockResolvedValue({ allowed: true });
  mocks.consumeSend.mockResolvedValue(true);
  mocks.isEmailSuppressed.mockResolvedValue(null);
  mocks.emailSendPaused.mockResolvedValue(false);
  mocks.composioExecuteTool.mockResolvedValue({
    ok: true,
    status: 200,
    data: { response_data: { id: "18f2c0ffee", threadId: "18f2c0ffee", labelIds: ["SENT"] } },
    error: null,
    outcome_unknown: false,
  });
});

describe('HANDLERS["outbound.send"] sends through the founder\'s connected Gmail', () => {
  it("sends once from the row tenant's own Gmail account and reports the Gmail message id", async () => {
    const res = await HANDLERS["outbound.send"](outboundDecision({ tenant_id: "t-attacker" }));

    expect(res.ok).toBe(true);
    expect(res.notice).toContain("18f2c0ffee");
    expect(mocks.resolveAccount).toHaveBeenCalledWith("t-row", "gmail");
    expect(mocks.composioExecuteTool).toHaveBeenCalledTimes(1);
    expect(mocks.composioExecuteTool).toHaveBeenCalledWith({
      tool_slug: "GMAIL_SEND_EMAIL",
      user_id: "t-row",
      connected_account_id: "ca_gmail_1",
      arguments: {
        recipient_email: "parent@example.com",
        subject: "Your trial lesson",
        body: "Here is the link to book.",
        is_html: false,
      },
    });
  });

  it("sends the HTML body as HTML when the approved draft has one", async () => {
    await HANDLERS["outbound.send"](outboundDecision({ body_html: "<p>Here</p>" }));
    expect(mocks.composioExecuteTool.mock.calls[0][0].arguments).toMatchObject({ body: "<p>Here</p>", is_html: true });
  });

  it("with no SendGrid key and no Gmail, sends nothing and says it is not connected", async () => {
    mocks.resolveAccount.mockResolvedValue(null);

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.error).toBe(OUTBOUND_EMAIL_NOT_CONNECTED);
    expect(res.error).not.toMatch(/tenant|no_sender_credential/);
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("a SendGrid key with no sender it can send as falls back to the connected Gmail, once", async () => {
    mocks.emailSend.mockRejectedValue(Object.assign(new Error("SendGrid has no verified sender"), { code: "email_from_not_set" }));

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(true);
    expect(res.notice).toContain("18f2c0ffee");
    expect(mocks.emailSend).toHaveBeenCalledTimes(1);
    expect(mocks.composioExecuteTool).toHaveBeenCalledTimes(1);
  });

  it("a SendGrid key with no sender and no Gmail says what to fix in SendGrid, not that nothing is connected", async () => {
    mocks.emailSend.mockRejectedValue(Object.assign(new Error("SendGrid has no verified sender Zavi can send from"), { code: "email_from_not_set" }));
    mocks.resolveAccount.mockResolvedValue(null);

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.error).toBe("SendGrid has no verified sender Zavi can send from");
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("asks SendGrid's verified sender as the fallback From; a failed read of the picked sender never goes out through Gmail", async () => {
    mocks.emailSend.mockRejectedValue(Object.assign(new Error("Zavi could not check which sender you picked"), { code: "email_sender_unreadable" }));

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(mocks.emailSend).toHaveBeenCalledWith("t-row", expect.objectContaining({ to: "parent@example.com" }), { verifiedSenderFallback: true });
    expect(res.ok).toBe(false);
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("a SendGrid send that lost its answer is outcome unknown and never retried through Gmail", async () => {
    mocks.emailSend.mockRejectedValue(Object.assign(new ExpectedToolError("email_send_outcome_unknown", "SendGrid did not confirm the send, so it may or may not have gone out.")));

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    expect(mocks.resolveAccount).not.toHaveBeenCalled();
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("never reaches Gmail when the comms safety net blocks the recipient", async () => {
    mocks.enforceCommsSafety.mockResolvedValue({ allowed: false, reason: "suppressed" });

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked/);
    expect(mocks.emailSend).not.toHaveBeenCalled();
    expect(mocks.resolveAccount).not.toHaveBeenCalled();
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("never reaches Gmail when the daily cap is spent", async () => {
    mocks.consumeSend.mockResolvedValue(false);

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("an unconfirmed Gmail send is reported as outcome unknown, so the decision is never settled as failed and re-sent", async () => {
    mocks.composioExecuteTool.mockResolvedValue({ ok: false, status: 502, data: null, error: "upstream", outcome_unknown: true });

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.outcome_unknown).toBe(true);
    expect(res.error).toBe(GMAIL_UNCONFIRMED);
    expect(mocks.composioExecuteTool).toHaveBeenCalledTimes(1);
  });

  it("never sends from Gmail to a recipient who unsubscribed or bounced on the email suppression list", async () => {
    mocks.isEmailSuppressed.mockResolvedValue("unsubscribe");

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.outcome_unknown).toBeUndefined();
    expect(res.error).toMatch(/suppressed \(unsubscribe\)/);
    expect(mocks.isEmailSuppressed).toHaveBeenCalledWith("t-row", "parent@example.com");
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("does not send from Gmail when the email suppression list cannot be read", async () => {
    mocks.isEmailSuppressed.mockRejectedValue(new Error("is_email_suppressed failed: timeout"));

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("a Gmail success with no message id is not reported as sent", async () => {
    mocks.composioExecuteTool.mockResolvedValue({ ok: true, status: 200, data: { response_data: {} }, error: null, outcome_unknown: false });

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.outcome_unknown).toBe(true);
    expect(res.error).toBe(GMAIL_UNCONFIRMED);
  });

  it("a definite Gmail refusal says Gmail did not send it", async () => {
    mocks.composioExecuteTool.mockResolvedValue({ ok: false, status: 400, data: null, error: "Invalid To header", outcome_unknown: false });

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.outcome_unknown).toBeUndefined();
    expect(res.error).toBe("Gmail did not send it: Invalid To header");
  });

  it("a connected SendGrid key still sends through SendGrid, and Gmail is never touched", async () => {
    mocks.emailSend.mockResolvedValue({ ok: true, messageId: "sg-1", statusCode: 202 });

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(true);
    expect(res.notice).toContain("sg-1");
    expect(mocks.resolveAccount).not.toHaveBeenCalled();
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });
});

describe('HANDLERS["outbound.send"] obeys the workspace Email sending switch', () => {
  it("paused: neither Gmail nor SendGrid is called, no daily-cap slot is spent, and the refusal says email is paused", async () => {
    mocks.emailSendPaused.mockResolvedValue(true);
    mocks.emailSend.mockResolvedValue({ ok: true, messageId: "sg-1", statusCode: 202 });

    const res = await HANDLERS["outbound.send"](outboundDecision({ tenant_id: "t-attacker" }));

    expect(res).toEqual({ ok: false, code: EMAIL_PAUSED_CODE, error: EMAIL_PAUSED_ONE_TO_ONE_ERROR });
    expect(res.error).not.toMatch(/try again/i);
    expect(mocks.emailSendPaused).toHaveBeenCalledWith("t-row");
    expect(mocks.emailSend).not.toHaveBeenCalled();
    expect(mocks.resolveAccount).not.toHaveBeenCalled();
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
    expect(mocks.enforceCommsSafety).not.toHaveBeenCalled();
    expect(mocks.consumeSend).not.toHaveBeenCalled();
  });

  it("the pause cannot be read: treated as paused, nothing is sent", async () => {
    mocks.emailSendPaused.mockRejectedValue(new Error("email_send_paused failed"));

    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(false);
    expect(res.code).toBe(EMAIL_PAUSED_CODE);
    expect(mocks.emailSend).not.toHaveBeenCalled();
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });

  it("not paused: the one-to-one email still goes out through Gmail", async () => {
    const res = await HANDLERS["outbound.send"](outboundDecision());

    expect(res.ok).toBe(true);
    expect(mocks.emailSendPaused).toHaveBeenCalledWith("t-row");
    expect(mocks.composioExecuteTool).toHaveBeenCalledTimes(1);
  });

  it("a paused workspace does not stop a non-email outbound message from being checked by its own path", async () => {
    mocks.emailSendPaused.mockResolvedValue(true);

    const res = await HANDLERS["outbound.send"](outboundDecision({ channel: "sms" }));

    expect(res.code).not.toBe(EMAIL_PAUSED_CODE);
    expect(mocks.emailSendPaused).not.toHaveBeenCalled();
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
  });
});
