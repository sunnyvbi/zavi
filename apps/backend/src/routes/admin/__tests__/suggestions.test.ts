import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "5f05d826-7793-45d1-88f9-c5c5bb3f0347";
const SUGGESTION_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_SUGGESTION_ID = "22222222-3333-4444-8555-666666666666";
const DECISION_ID = "33333333-4444-4555-8666-777777777777";
const SESSION_ID = "44444444-5555-4666-8777-888888888888";

const { assertStaffMock, auditMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "staff-user", email: "staff@zavi.ai" })),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: auditMock }));

const { serviceClientMock, calls, state, reset } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null; count?: number | null };
  type Operation = { op: string; args: unknown[] };
  type TableCall = { table: string; ops: Operation[] };

  const c = {
    tables: [] as TableCall[],
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };
  const s = {
    queues: {} as Record<string, Result[]>,
    rpcResult: { data: null, error: null } as Result,
  };
  const chainOps = ["select", "eq", "in", "order", "limit", "insert", "update"];
  const client = {
    from(table: string) {
      const call: TableCall = { table, ops: [] };
      c.tables.push(call);
      const result = () => {
        const queue = s.queues[table];
        if (!queue?.length) return { data: null, error: null };
        return queue.length > 1 ? queue.shift()! : queue[0];
      };
      const builder: Record<string, unknown> = {};
      for (const op of chainOps) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return builder;
        };
      }
      builder.maybeSingle = () => Promise.resolve(result());
      builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      c.rpc.push({ name, args });
      return Promise.resolve(s.rpcResult);
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    calls: c,
    state: s,
    reset: () => {
      c.tables = [];
      c.rpc = [];
      s.queues = {};
      s.rpcResult = { data: null, error: null };
      assertStaffMock.mockClear();
      auditMock.mockClear();
    },
  };
});

vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import {
  staffSuggestionsCreate,
  staffSuggestionsPatch,
  staffSuggestionsPushBatch,
} from "../suggestions";

type Handler = typeof staffSuggestionsCreate;

function makeReqRes(
  body: unknown = {},
  params: Record<string, string> = {},
  query: Record<string, unknown> = {},
) {
  const req = { body, params, query } as unknown as Parameters<Handler>[0];
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return { req, res: res as unknown as Parameters<Handler>[1] & typeof res };
}

function operations(table: string, operation: string) {
  return calls.tables
    .filter((call) => call.table === table)
    .flatMap((call) => call.ops.filter((op) => op.op === operation));
}

beforeEach(() => reset());

describe("staffSuggestionsCreate", () => {
  it("saves a manual draft, audits it, and files it under the chat session", async () => {
    const row = { id: SUGGESTION_ID, tenant_id: TENANT_ID, title: "Protect branded search", source: "manual", status: "draft", duplicate_of: null };
    state.queues.growth_suggestions = [
      { data: row, error: null },
      { data: [row], error: null },
    ];
    state.queues.growth_suggestion_sessions = [{ data: { id: SESSION_ID }, error: null }];
    state.queues.growth_suggestion_messages = [{
      data: [
        { id: "m1", session_id: SESSION_ID, role: "staff", body: "Add a suggestion manually: Protect branded search", meta: {}, created_at: "2026-08-19T00:00:00Z" },
        { id: "m2", session_id: SESSION_ID, role: "zavi", body: "Saved as a draft.", meta: { suggestion_ids: [SUGGESTION_ID] }, created_at: "2026-08-19T00:00:01Z" },
      ],
      error: null,
    }];
    const { req, res } = makeReqRes({
      tenant_id: TENANT_ID,
      session_id: SESSION_ID,
      title: "Protect branded search",
      body: "Competitors are bidding on the brand term.",
      category: "campaign",
      priority: "high",
    });

    await staffSuggestionsCreate(req, res);

    expect(res.statusCode).toBe(201);
    const inserted = operations("growth_suggestions", "insert")[0].args[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      tenant_id: TENANT_ID,
      owner_staff_id: "staff-user",
      owner_staff_email: "staff@zavi.ai",
      created_by_staff_id: "staff-user",
      source: "manual",
      source_payload: {},
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "growth_suggestion.create",
      target_id: SUGGESTION_ID,
      tenant_id: TENANT_ID,
    }));
    const messageInsert = operations("growth_suggestion_messages", "insert")[0].args[0] as Array<Record<string, unknown>>;
    expect(messageInsert[1]).toMatchObject({ role: "zavi", meta: { suggestion_ids: [SUGGESTION_ID] } });
    const payload = res.payload as { session_id: string; messages: Array<{ suggestions: Array<{ id: string }> }> };
    expect(payload.session_id).toBe(SESSION_ID);
    expect(payload.messages[1].suggestions[0].id).toBe(SUGGESTION_ID);
  });

  it("rejects a malformed manual suggestion before writing", async () => {
    const { req, res } = makeReqRes({ tenant_id: TENANT_ID, title: "", body: "x", category: "campaign", priority: "high" });
    await staffSuggestionsCreate(req, res);
    expect(res.statusCode).toBe(400);
    expect(operations("growth_suggestions", "insert")).toHaveLength(0);
  });
});

describe("staffSuggestionsPatch", () => {
  it("does not edit a suggestion once it is awaiting the client", async () => {
    state.queues.growth_suggestions = [{
      data: { id: SUGGESTION_ID, tenant_id: TENANT_ID, status: "awaiting_client" },
      error: null,
    }];
    const { req, res } = makeReqRes({ title: "Changed" }, { id: SUGGESTION_ID });
    await staffSuggestionsPatch(req, res);
    expect(res.statusCode).toBe(409);
    expect(operations("growth_suggestions", "update")).toHaveLength(0);
  });

  it("rejects a self-referential duplicate marker", async () => {
    state.queues.growth_suggestions = [{
      data: { id: SUGGESTION_ID, tenant_id: TENANT_ID, status: "draft" },
      error: null,
    }];
    const { req, res } = makeReqRes({ duplicate_of: SUGGESTION_ID }, { id: SUGGESTION_ID });
    await staffSuggestionsPatch(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_duplicate");
    expect(operations("growth_suggestions", "update")).toHaveLength(0);
  });
});

describe("staffSuggestionsPushBatch", () => {
  it("uses the atomic push RPC and audits every emitted decision", async () => {
    state.rpcResult = {
      data: [
        { suggestion_id: SUGGESTION_ID, decision_id: DECISION_ID, status: "awaiting_client" },
        { suggestion_id: OTHER_SUGGESTION_ID, decision_id: "44444444-5555-4666-8777-888888888888", status: "awaiting_client" },
      ],
      error: null,
    };
    const { req, res } = makeReqRes({
      tenant_id: TENANT_ID,
      suggestion_ids: [SUGGESTION_ID, OTHER_SUGGESTION_ID],
    });

    await staffSuggestionsPushBatch(req, res);

    expect(res.statusCode).toBe(200);
    expect(calls.rpc).toEqual([{
      name: "push_growth_suggestions",
      args: {
        p_suggestion_ids: [SUGGESTION_ID, OTHER_SUGGESTION_ID],
        p_tenant_id: TENANT_ID,
        p_staff_id: "staff-user",
      },
    }]);
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "growth_suggestion.push",
      target_id: SUGGESTION_ID,
      meta: { decision_id: DECISION_ID },
    }));
  });

  it("rejects duplicate ids before calling the RPC", async () => {
    const { req, res } = makeReqRes({
      tenant_id: TENANT_ID,
      suggestion_ids: [SUGGESTION_ID, SUGGESTION_ID],
    });
    await staffSuggestionsPushBatch(req, res);
    expect(res.statusCode).toBe(400);
    expect(calls.rpc).toHaveLength(0);
  });

  it("returns a conflict if the decision rail cannot accept the draft", async () => {
    state.rpcResult = {
      data: null,
      error: { message: "suggestion decision did not enter the approval queue" },
    };
    const { req, res } = makeReqRes({
      tenant_id: TENANT_ID,
      suggestion_ids: [SUGGESTION_ID],
    });
    await staffSuggestionsPushBatch(req, res);
    expect(res.statusCode).toBe(409);
    expect((res.payload as { error: { code: string } }).error.code).toBe("push_conflict");
  });
});
