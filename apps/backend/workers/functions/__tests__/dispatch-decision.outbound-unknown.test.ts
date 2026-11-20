import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDecision: vi.fn(),
  emailSend: vi.fn(),
  resolveAccount: vi.fn(),
  composioExecuteTool: vi.fn(),
  enforceCommsSafety: vi.fn(),
  consumeSend: vi.fn(),
  isEmailSuppressed: vi.fn(),
}));

const writes: Array<{ table: string; op: string; payload: Record<string, unknown> }> = [];

function chain(table: string): Record<string, unknown> {
  const result = (data: unknown) => Promise.resolve({ data, error: null });
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.eq = self;
  node.in = self;
  node.neq = self;
  node.is = self;
  node.order = self;
  node.limit = self;
  node.maybeSingle = () => result(table === "agent_runs" ? { agent_slug: "cgo", trigger: "chat", payload: {} } : table === "agent_threads" ? { id: "th-1" } : null);
  node.single = node.maybeSingle;
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result(null).then(res, rej);
  return node;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      ...chain(table),
      update: (payload: Record<string, unknown>) => {
        writes.push({ table, op: "update", payload });
        return chain(table);
      },
      insert: (payload: Record<string, unknown>) => {
        writes.push({ table, op: "insert", payload });
        return chain(table);
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/services/agents/approve-resume-dispatch", () => ({ resumeAfterDecision: vi.fn() }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false, isChannelLockedStrict: async () => false }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: vi.fn() }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}), send: vi.fn() } }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: (id: string) => mocks.claimDecision(id),
  releaseClaim: vi.fn(),
  markDispatched: vi.fn(),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: async () => false }));
vi.mock("@/services/tools/email/_client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailSend: mocks.emailSend,
}));
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
vi.mock("../dispatch-notice", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extractChatThreadId: vi.fn(() => "th-1"),
  extractSlackRouting: vi.fn(() => null),
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";
import { GMAIL_UNCONFIRMED } from "@/services/connectors/gmail-composio/send";
import { SENDGRID_UNCONFIRMED } from "@/services/tools/email/_client";
import { ExpectedToolError } from "@/services/tools/types";

const ROW = {
  id: "dec-o1",
  tenant_id: "t-row",
  agent_run_id: "run-1",
  decision_class: "outbound.send",
  body: { channel: "email", to: "parent@example.com", subject: "Trial", body_text: "Book here." },
  status: "approved",
  handler: "outbound.send",
  approved_by: "u1",
  approved_by_source: null,
};

const gmail = { tenant_id: "t-row", toolkit: "gmail", connected_account_id: "ca_gmail_1", auth_config_id: "ac_gmail" };

const settles = () => writes.filter((w) => w.table === "decisions" && "status" in w.payload && "dispatched_at" in w.payload).map((w) => w.payload);
const notices = () => writes.filter((w) => w.table === "agent_thread_messages" && w.op === "insert").map((w) => String(w.payload.body));

beforeEach(() => {
  writes.length = 0;
  vi.clearAllMocks();
  mocks.claimDecision.mockResolvedValueOnce(ROW).mockResolvedValue(null);
  mocks.enforceCommsSafety.mockResolvedValue({ allowed: true });
  mocks.consumeSend.mockResolvedValue(true);
  mocks.isEmailSuppressed.mockResolvedValue(null);
  mocks.resolveAccount.mockResolvedValue(gmail);
});

describe("a one-to-one email whose send was not confirmed", () => {
  it("Gmail did not confirm: the row is closed with Gmail's own words and the chat is told to check the Sent folder, once", async () => {
    mocks.emailSend.mockRejectedValue(Object.assign(new Error("not connected"), { code: "email_not_connected" }));
    mocks.composioExecuteTool.mockResolvedValue({ ok: false, status: 502, data: null, error: "upstream", outcome_unknown: true });

    const res = await executeDispatch("dec-o1");
    const again = await executeDispatch("dec-o1");

    expect(res.ok).toBe(false);
    expect(again).toEqual({ ok: true });
    expect(mocks.composioExecuteTool).toHaveBeenCalledTimes(1);
    expect(settles()).toEqual([expect.objectContaining({ status: "dispatch_failed", dispatch_error: GMAIL_UNCONFIRMED })]);
    expect(notices()).toEqual([GMAIL_UNCONFIRMED]);
    expect(notices()[0]).not.toMatch(/retry|Couldn't/);
  });

  it("SendGrid lost the connection mid-send: closed as may-have-gone-out, never as a plain failure with the socket error", async () => {
    mocks.emailSend.mockRejectedValue(new ExpectedToolError("email_send_outcome_unknown", SENDGRID_UNCONFIRMED, { code: "ECONNRESET" }));

    const res = await executeDispatch("dec-o1");

    expect(res.ok).toBe(false);
    expect(mocks.composioExecuteTool).not.toHaveBeenCalled();
    expect(settles()).toEqual([expect.objectContaining({ status: "dispatch_failed", dispatch_error: SENDGRID_UNCONFIRMED })]);
    expect(notices()).toEqual([SENDGRID_UNCONFIRMED]);
  });

  it("a definite SendGrid refusal still reads as a failure the founder can retry", async () => {
    mocks.emailSend.mockRejectedValue(new ExpectedToolError("email_send_failed", "Bad Request", { code: 400 }));

    await executeDispatch("dec-o1");

    expect(settles()).toEqual([expect.objectContaining({ status: "dispatch_failed", dispatch_error: "Bad Request" })]);
    expect(notices()[0]).toMatch(/^Couldn't send the email: Bad Request/);
  });
});
