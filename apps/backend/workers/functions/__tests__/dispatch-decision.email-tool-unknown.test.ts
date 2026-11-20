import { describe, it, expect, vi, beforeEach } from "vitest";

const claimDecisionMock = vi.fn();
const isFleetHaltedMock = vi.fn(async () => false);
const sendAndTell = vi.fn();
const pausedMock = vi.fn(async () => false);

const decisionsUpdates: Array<Record<string, unknown>> = [];
const updateFilters: Array<Record<string, unknown>> = [];
const markFails: Array<{ data: null; error: { message: string } }> = [];
const tellMock = vi.fn(async (_o: unknown) => "told");

vi.mock("@/services/agents/approve-resume-dispatch", () => ({ resumeAfterDecision: vi.fn() }));
vi.mock("@/services/connectors/email-campaign/execute-send", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeEmailCampaignSendAndTell: (...a: unknown[]) => sendAndTell(...a),
}));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: () => pausedMock() }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false, isChannelLockedStrict: async () => false }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: vi.fn() }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "decisions") {
        return {
          update: (payload: Record<string, unknown>) => {
            decisionsUpdates.push(payload);
            const filters: Record<string, unknown> = {};
            updateFilters.push(filters);
            const q = {
              eq: (k: string, v: unknown) => {
                filters[k] = v;
                return q;
              },
              then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(markFails.length && !("status" in payload) ? markFails.shift() : { data: null, error: null }).then(ok, bad),
            };
            return q;
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
vi.mock("@/services/email-cards/outcome-tell", () => ({ tellEmailSendOutcomeOrQueue: (o: unknown) => tellMock(o) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: (id: string) => claimDecisionMock(id),
  releaseClaim: vi.fn(),
  markDispatched: vi.fn(),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: () => isFleetHaltedMock() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: vi.fn() }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(() => null),
  extractSlackRouting: vi.fn(() => null),
  postDispatchNotice: vi.fn(),
  bulkNotSentLine: (s: string) => s,
  BULK_OUTBOUND_INTERRUPTED_LINE: "interrupted",
  BULK_OUTBOUND_INVALID_LINE: "invalid",
  BULK_OUTBOUND_NOT_SENT_LINE: "not sent",
  HANDLER_LABELS: {},
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";
import { OUTCOME_UNKNOWN_SUFFIX } from "@/services/connectors/email-campaign/execute-send";

const EMAIL_ROW = {
  id: "dec-e1",
  tenant_id: "TENANT_A",
  agent_run_id: null,
  decision_class: "email_campaign.create_and_send",
  body: { tool: "sendgrid" },
  status: "approved",
  handler: "email_campaign.create_and_send",
  approved_by: "u1",
  approved_by_source: null,
};
const UNKNOWN = {
  ok: false,
  outcome_unknown: true,
  code: "exec_outcome_unknown",
  error: "SendGrid did not confirm whether this email was sent. Zavi will not send it again, so nobody gets it twice. Open SendGrid to see whether it went out.",
};
const settleWrites = () => decisionsUpdates.filter((u) => "status" in u && "dispatched_at" in u);

beforeEach(() => {
  decisionsUpdates.length = 0;
  updateFilters.length = 0;
  markFails.length = 0;
  tellMock.mockClear();
  claimDecisionMock.mockReset();
  sendAndTell.mockReset();
  pausedMock.mockResolvedValue(false);
});

describe("a chat-tool email send whose outcome is unknown", () => {
  it("settles a terminal dispatch_failed carrying the unknown marker, never proposed, never released", async () => {
    const { releaseClaim } = await import("@/services/decisions/atomic-claim");
    vi.mocked(releaseClaim).mockClear();
    sendAndTell.mockResolvedValue(UNKNOWN);
    claimDecisionMock.mockResolvedValueOnce(EMAIL_ROW);

    const res = await executeDispatch("dec-e1");

    expect(res.ok).toBe(false);
    const writes = settleWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].status).toBe("dispatch_failed");
    expect(writes[0].dispatch_error).toBe(`${UNKNOWN.error}${OUTCOME_UNKNOWN_SUFFIX}`);
    expect(decisionsUpdates.some((u) => u.status === "proposed" || u.status === "approved")).toBe(false);
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it("a retry racing the first settle cannot run the send again: the claim is gone, the handler never runs twice", async () => {
    let release!: (v: unknown) => void;
    sendAndTell.mockImplementationOnce(() => new Promise((r) => (release = r)));
    claimDecisionMock.mockResolvedValueOnce(EMAIL_ROW).mockResolvedValue(null);

    const first = executeDispatch("dec-e1");
    await vi.waitFor(() => expect(sendAndTell).toHaveBeenCalledTimes(1));
    const raced = await executeDispatch("dec-e1");
    release(UNKNOWN);
    await first;
    const later = await executeDispatch("dec-e1");

    expect(raced).toEqual({ ok: true });
    expect(later).toEqual({ ok: true });
    expect(sendAndTell).toHaveBeenCalledTimes(1);
    expect(settleWrites().map((w) => w.status)).toEqual(["dispatch_failed"]);
    expect(String(settleWrites()[0].dispatch_error)).toMatch(/exec_outcome_unknown\)$/);
  });

  it("with the check queued, stays 'dispatching' carrying the unknown marker for the reconcile, never closed dispatch_failed, never told yet", async () => {
    sendAndTell.mockResolvedValue({ ...UNKNOWN, reconcile_queued: true });
    claimDecisionMock.mockResolvedValueOnce(EMAIL_ROW);

    const res = await executeDispatch("dec-e1");

    expect(res.ok).toBe(false);
    expect(settleWrites()).toEqual([]);
    const marks = decisionsUpdates.map((u, i) => ({ u, f: updateFilters[i] })).filter(({ u }) => String(u.dispatch_error ?? "").endsWith(OUTCOME_UNKNOWN_SUFFIX));
    expect(marks).toHaveLength(1);
    expect(marks[0].u).not.toHaveProperty("status");
    expect(marks[0].u.dispatch_error).toBe(`${UNKNOWN.error}${OUTCOME_UNKNOWN_SUFFIX}`);
    expect(marks[0].f).toEqual({ id: "dec-e1", status: "dispatching" });
    expect(decisionsUpdates.some((u) => u.status === "dispatch_failed" || u.status === "proposed")).toBe(false);
    expect(tellMock).not.toHaveBeenCalled();
  });

  it("with the check queued but the marker write failing, falls back to the terminal unknown close and tells the approver once", async () => {
    sendAndTell.mockResolvedValue({ ...UNKNOWN, reconcile_queued: true });
    claimDecisionMock.mockResolvedValueOnce(EMAIL_ROW);
    markFails.push({ data: null, error: { message: "boom" } });

    await executeDispatch("dec-e1");

    expect(settleWrites().map((w) => w.status)).toEqual(["dispatch_failed"]);
    expect(settleWrites()[0].dispatch_error).toBe(`${UNKNOWN.error}${OUTCOME_UNKNOWN_SUFFIX}`);
    expect(tellMock).toHaveBeenCalledTimes(1);
    expect(tellMock).toHaveBeenCalledWith({ tenant_id: "TENANT_A", rail: "decisions", card_id: "dec-e1", outcome: "unknown", sent: null, reason: UNKNOWN.error });
  });
});
