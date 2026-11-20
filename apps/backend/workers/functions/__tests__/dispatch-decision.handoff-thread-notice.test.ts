import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDecision: vi.fn(),
  sendAndTell: vi.fn(),
}));

type Filters = Record<string, unknown>;
const db = {
  runRow: null as unknown,
  threads: [] as Array<{ id: string; tenant_id: string }>,
  threadLookups: [] as Filters[],
  writes: [] as Array<{ table: string; op: string; payload: Record<string, unknown> }>,
};

function chain(table: string): Record<string, unknown> {
  const filters: Filters = {};
  const result = (data: unknown) => Promise.resolve({ data, error: null });
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return node;
  };
  node.in = self;
  node.neq = self;
  node.is = self;
  node.order = self;
  node.limit = self;
  node.maybeSingle = () => {
    if (table === "agent_runs") return result(db.runRow);
    if (table === "agent_threads") {
      db.threadLookups.push({ ...filters });
      const hit = db.threads.find((t) => t.id === filters.id && t.tenant_id === filters.tenant_id);
      return result(hit ? { id: hit.id } : null);
    }
    return result(null);
  };
  node.single = node.maybeSingle;
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result(null).then(res, rej);
  return node;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      ...chain(table),
      update: (payload: Record<string, unknown>) => {
        db.writes.push({ table, op: "update", payload });
        return chain(table);
      },
      insert: (payload: Record<string, unknown>) => {
        db.writes.push({ table, op: "insert", payload });
        return chain(table);
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/services/agents/approve-resume-dispatch", () => ({ resumeAfterDecision: vi.fn(async () => ({ reason: "resumed" })) }));
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
vi.mock("@/services/connectors/email-campaign/execute-send", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeEmailCampaignSendAndTell: mocks.sendAndTell,
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";

const TENANT = "t-own";
const OWN_THREAD = "11111111-1111-4111-8111-111111111111";
const FOREIGN_THREAD = "22222222-2222-4222-8222-222222222222";
const RUN_THREAD = "33333333-3333-4333-8333-333333333333";
const NOTICE = "Sent to 3, skipped 0.";

const ROW = {
  id: "dec-h1",
  tenant_id: TENANT,
  agent_run_id: "run-c740d1f3",
  decision_class: "email_campaign.create_and_send",
  body: {},
  status: "approved",
  handler: "email_campaign.create_and_send",
  approved_by: "u1",
  approved_by_source: null,
};

const notices = () =>
  db.writes.filter((w) => w.table === "agent_thread_messages" && w.op === "insert").map((w) => w.payload);

beforeEach(() => {
  db.writes.length = 0;
  db.threadLookups.length = 0;
  db.threads = [
    { id: OWN_THREAD, tenant_id: TENANT },
    { id: RUN_THREAD, tenant_id: TENANT },
    { id: FOREIGN_THREAD, tenant_id: "t-other" },
  ];
  vi.clearAllMocks();
  mocks.claimDecision.mockResolvedValueOnce(ROW).mockResolvedValue(null);
  mocks.sendAndTell.mockResolvedValue({ ok: true, notice: NOTICE });
});

describe("dispatch notice reaches the chat that handed off to the email specialist", () => {
  it("a handoff run posts the send result into payload.operator_thread_id", async () => {
    db.runRow = { agent_slug: "email", trigger: "handoff", payload: { operator_thread_id: OWN_THREAD } };

    const res = await executeDispatch("dec-h1");

    expect(res.ok).toBe(true);
    expect(mocks.sendAndTell).toHaveBeenCalledTimes(1);
    expect(db.threadLookups).toEqual([{ id: OWN_THREAD, tenant_id: TENANT }]);
    expect(notices()).toEqual([
      expect.objectContaining({
        thread_id: OWN_THREAD,
        tenant_id: TENANT,
        sender_role: "assistant",
        body: NOTICE,
        meta: expect.objectContaining({ dispatch_notice: true, decision_id: "dec-h1", ok: true }),
      }),
    ]);
  });

  it("a handoff run whose operator_thread_id belongs to another tenant posts nothing anywhere", async () => {
    db.runRow = { agent_slug: "email", trigger: "handoff", payload: { operator_thread_id: FOREIGN_THREAD } };

    const res = await executeDispatch("dec-h1");

    expect(res.ok).toBe(true);
    expect(mocks.sendAndTell).toHaveBeenCalledTimes(1);
    expect(db.threadLookups).toEqual([{ id: FOREIGN_THREAD, tenant_id: TENANT }]);
    expect(notices()).toEqual([]);
  });

  it("a chat run still posts into its own payload.thread_id", async () => {
    db.runRow = { agent_slug: "cgo", trigger: "chat", payload: { thread_id: RUN_THREAD } };

    await executeDispatch("dec-h1");

    expect(notices()).toEqual([expect.objectContaining({ thread_id: RUN_THREAD, body: NOTICE })]);
  });

  it("a chat run ignores operator_thread_id: only handoff runs read it", async () => {
    db.runRow = { agent_slug: "cgo", trigger: "chat", payload: { operator_thread_id: OWN_THREAD } };

    await executeDispatch("dec-h1");

    expect(db.threadLookups).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it("a handoff run with neither field posts nothing and still settles the send", async () => {
    db.runRow = { agent_slug: "email", trigger: "handoff", payload: { handoff_batch_id: null } };

    const res = await executeDispatch("dec-h1");

    expect(res.ok).toBe(true);
    expect(mocks.sendAndTell).toHaveBeenCalledTimes(1);
    expect(db.threadLookups).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it("a handoff run with a null payload posts nothing and does not throw", async () => {
    db.runRow = { agent_slug: "email", trigger: "handoff", payload: null };

    await expect(executeDispatch("dec-h1")).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(notices()).toEqual([]);
  });

  it("with both fields, thread_id wins, as on the approvals list", async () => {
    db.runRow = {
      agent_slug: "email",
      trigger: "handoff",
      payload: { thread_id: RUN_THREAD, operator_thread_id: OWN_THREAD },
    };

    await executeDispatch("dec-h1");

    expect(db.threadLookups).toEqual([{ id: RUN_THREAD, tenant_id: TENANT }]);
    expect(notices()).toEqual([expect.objectContaining({ thread_id: RUN_THREAD })]);
  });

  it("with both fields and a foreign thread_id, nothing posts: the guard does not fall through to operator_thread_id", async () => {
    db.runRow = {
      agent_slug: "email",
      trigger: "handoff",
      payload: { thread_id: FOREIGN_THREAD, operator_thread_id: OWN_THREAD },
    };

    await executeDispatch("dec-h1");

    expect(db.threadLookups).toEqual([{ id: FOREIGN_THREAD, tenant_id: TENANT }]);
    expect(notices()).toEqual([]);
  });
});
