import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "5f05d826-7793-45d1-88f9-c5c5bb3f0347";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const REQUEST_ID = "22222222-3333-4444-8555-666666666666";

const { assertStaffMock, auditMock, enqueueMock, runnableMock, invalidateMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "staff-user", email: "staff@zavi.ai" })),
  auditMock: vi.fn(async () => undefined),
  enqueueMock: vi.fn(async () => ({ run_id: RUN_ID })),
  runnableMock: vi.fn(async () => ({ runnable: true })),
  invalidateMock: vi.fn(),
}));

vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: auditMock }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: enqueueMock }));
vi.mock("@/services/agents/ensure-runnable", () => ({ ensureAgentRunnable: runnableMock }));
vi.mock("@/services/client-context", () => ({ invalidateClientContext: invalidateMock }));

const { serviceClientMock, calls, state, rpcCalls, rpcResults, reset } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null };
  const c = { tables: [] as Array<{ table: string; ops: Array<{ op: string; args: unknown[] }> }> };
  const s = { queues: {} as Record<string, Result[]> };
  const rpcCalls = [] as Array<{ name: string; args: Record<string, unknown> }>;
  const rpcResults = { queue: [] as Array<{ data: unknown; error: { message: string } | null }> };
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const r = rpcResults.queue.length > 1 ? rpcResults.queue.shift()! : rpcResults.queue[0];
      return Promise.resolve(r ?? { data: true, error: null });
    },
    from(table: string) {
      const call = { table, ops: [] as Array<{ op: string; args: unknown[] }> };
      c.tables.push(call);
      const result = () => {
        const queue = s.queues[table];
        if (!queue?.length) return { data: null, error: null };
        return queue.length > 1 ? queue.shift()! : queue[0];
      };
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "upsert", "maybeSingle"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return op === "maybeSingle" ? Promise.resolve(result()) : builder;
        };
      }
      builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    calls: c,
    state: s,
    rpcCalls,
    rpcResults,
    reset: () => {
      c.tables = [];
      s.queues = {};
      rpcCalls.length = 0;
      rpcResults.queue = [];
      assertStaffMock.mockClear();
      auditMock.mockClear();
      enqueueMock.mockClear();
      runnableMock.mockClear();
      invalidateMock.mockClear();
    },
  };
});

vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import {
  staffCompanyFieldsFillStart,
  staffCompanyFieldsFillStatus,
  staffCompanyFieldsPublish,
} from "../company-fields";

type Handler = typeof staffCompanyFieldsFillStart;

function makeReqRes(body: unknown = {}, params: Record<string, string> = { tenant_id: TENANT_ID }) {
  const req = { body, params, query: {} } as unknown as Parameters<Handler>[0];
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

const RUN_PAYLOAD = { source: "company_fields_fill_v1", request_id: REQUEST_ID, keys: ["avg_deal_size", "buyer"] };

beforeEach(reset);

describe("staffCompanyFieldsFillStart", () => {
  it("enqueues an operator run carrying the requested keys and a grounded prompt", async () => {
    state.queues.tenants = [{ data: { display_name: "Upcar" }, error: null }];
    const { req, res } = makeReqRes({ keys: ["avg_deal_size", "buyer", "buyer"], request_id: REQUEST_ID });
    await staffCompanyFieldsFillStart(req, res);
    expect(res.statusCode).toBe(202);
    expect(runnableMock).toHaveBeenCalledWith(TENANT_ID, "operator");
    const input = (enqueueMock.mock.calls[0] as unknown as unknown[])[0] as { agent_slug: string; trigger: string; payload: Record<string, unknown> };
    expect(input.agent_slug).toBe("operator");
    expect(input.trigger).toBe("a2a");
    expect(input.payload.keys).toEqual(["avg_deal_size", "buyer"]);
    expect(String(input.payload.task_description)).toContain("Upcar");
    expect(String(input.payload.task_description)).toMatch(/COMPUTE it live from raw data/);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "company_fields_fill_started", target_id: RUN_ID }));
  });

  it("rejects unknown field keys", async () => {
    const { req, res } = makeReqRes({ keys: ["mrr"], request_id: REQUEST_ID });
    await staffCompanyFieldsFillStart(req, res);
    expect(res.statusCode).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("staffCompanyFieldsFillStatus", () => {
  it("parses the operator's company_fields block once the run succeeds", async () => {
    state.queues.agent_runs = [{
      data: {
        id: RUN_ID,
        status: "success",
        error: null,
        payload: RUN_PAYLOAD,
        output_text: '<company_fields>{"fields":[{"key":"avg_deal_size","value":"$184","method":"calculated","source":"stripe","formula":"net revenue ÷ charges","inputs":[{"name":"net revenue","value":"$57,408"}],"assumptions":"312 charges","caveats":"single currency","confidence":"medium"}],"unfilled":[{"key":"buyer","reason":"nothing on record"}]}</company_fields>',
      },
      error: null,
    }];
    const { req, res } = makeReqRes({}, { tenant_id: TENANT_ID, run_id: RUN_ID });
    await staffCompanyFieldsFillStatus(req, res);
    const payload = res.payload as { status: string; fields: Array<{ key: string }>; unfilled: Array<{ key: string }> };
    expect(payload.status).toBe("complete");
    expect(payload.fields[0]).toMatchObject({ key: "avg_deal_size", method: "calculated", formula: "net revenue ÷ charges", inputs: [{ name: "net revenue", value: "$57,408" }] });
    expect(payload.unfilled[0].key).toBe("buyer");
  });

  it("reports running while the operator is still working", async () => {
    state.queues.agent_runs = [{ data: { id: RUN_ID, status: "running", error: null, payload: RUN_PAYLOAD, output_text: null }, error: null }];
    const { req, res } = makeReqRes({}, { tenant_id: TENANT_ID, run_id: RUN_ID });
    await staffCompanyFieldsFillStatus(req, res);
    expect((res.payload as { status: string }).status).toBe("running");
  });
});

describe("staffCompanyFieldsPublish", () => {
  const body = {
    run_id: RUN_ID,
    request_id: REQUEST_ID,
    fields: [
      { key: "avg_deal_size", value: "$190", method: "calculated", source: "stripe", formula: "net revenue ÷ charges", inputs: [{ name: "charges", value: "312" }], assumptions: "edited by staff", caveats: "", confidence: "medium", evidence: [] },
      { key: "personas", value: "not requested", source: "", assumptions: "", confidence: null, evidence: [] },
    ],
  };

  it("upserts only reviewed fields from this run as ai_estimated and audits them", async () => {
    state.queues.agent_runs = [{ data: { id: RUN_ID, status: "success", error: null, payload: RUN_PAYLOAD, output_text: "" }, error: null }];
    state.queues.company_profile_fields = [{ data: [{ id: "f1", key: "avg_deal_size" }], error: null }];
    const { req, res } = makeReqRes(body);
    await staffCompanyFieldsPublish(req, res);
    expect(res.statusCode).toBe(200);
    const upsert = calls.tables.find((call) => call.table === "company_profile_fields")!.ops.find((op) => op.op === "upsert")!;
    const rows = upsert.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "avg_deal_size", value: "$190", method: "calculated", formula: "net revenue ÷ charges", inputs: [{ name: "charges", value: "312" }], status: "ai_estimated", reviewed_by: "staff-user", source_run_id: RUN_ID });
    expect(invalidateMock).toHaveBeenCalledWith(TENANT_ID);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "company_field_published", target_id: "f1" }));
  });

  it("refuses to save when the run is not the one that produced the review", async () => {
    state.queues.agent_runs = [{ data: { id: RUN_ID, status: "success", error: null, payload: { ...RUN_PAYLOAD, request_id: "other" }, output_text: "" }, error: null }];
    const { req, res } = makeReqRes(body);
    await staffCompanyFieldsPublish(req, res);
    expect(res.statusCode).toBe(409);
    expect(calls.tables.some((call) => call.table === "company_profile_fields")).toBe(false);
  });

  const ICP_PAYLOAD = { source: "company_fields_fill_v1", request_id: REQUEST_ID, keys: ["primary_icp"] };
  const icpBody = {
    run_id: RUN_ID,
    request_id: REQUEST_ID,
    fields: [
      {
        key: "primary_icp",
        value: "Busy Bay Area professionals who want a car delivered",
        method: "recorded", source: "brain", formula: "", inputs: [],
        assumptions: "", caveats: "", confidence: "medium", evidence: [],
      },
    ],
  };
  const arrangeIcp = () => {
    state.queues.agent_runs = [{ data: { id: RUN_ID, status: "success", error: null, payload: ICP_PAYLOAD, output_text: "" }, error: null }];
    state.queues.company_profile_fields = [{ data: [{ id: "f9", key: "primary_icp" }], error: null }];
  };

  it("projects primary_icp into who_we_serve as ai_estimated, never as staff_reviewed", async () => {
    arrangeIcp();
    const { req, res } = makeReqRes(icpBody);
    await staffCompanyFieldsPublish(req, res);

    expect(res.statusCode).toBe(200);
    const proj = rpcCalls.find((c) => c.name === "project_tenant_fact");
    expect(proj).toBeDefined();
    expect(proj!.args).toMatchObject({
      p_tenant_id: TENANT_ID,
      p_key: "who_we_serve",
      p_value_text: "Busy Bay Area professionals who want a car delivered",
      p_source: "ai_estimated",
    });
  });

  it("never projects a non-ICP field", async () => {
    state.queues.agent_runs = [{ data: { id: RUN_ID, status: "success", error: null, payload: RUN_PAYLOAD, output_text: "" }, error: null }];
    state.queues.company_profile_fields = [{ data: [{ id: "f1", key: "avg_deal_size" }], error: null }];
    const { req, res } = makeReqRes(body);
    await staffCompanyFieldsPublish(req, res);
    expect(rpcCalls.find((c) => c.name === "project_tenant_fact")).toBeUndefined();
  });

  it("still returns 200 when the projection errors, and reports it rather than swallowing it", async () => {
    arrangeIcp();
    rpcResults.queue = [{ data: null, error: { message: "boom" } }];
    const { req, res } = makeReqRes(icpBody);
    await staffCompanyFieldsPublish(req, res);

    expect(res.statusCode).toBe(200);
    const payload = res.payload as { projected?: { error: string | null } };
    expect(payload.projected?.error).toBe("boom");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ projected: expect.objectContaining({ error: "boom" }) }) }),
    );
  });

  it("reports a refusal distinctly from an error when the incumbent outranks", async () => {
    arrangeIcp();
    rpcResults.queue = [{ data: false, error: null }];
    const { req, res } = makeReqRes(icpBody);
    await staffCompanyFieldsPublish(req, res);
    const payload = res.payload as { projected?: { written: boolean; refused: boolean; error: string | null } };
    expect(payload.projected).toMatchObject({ written: false, refused: true, error: null });
  });
});
