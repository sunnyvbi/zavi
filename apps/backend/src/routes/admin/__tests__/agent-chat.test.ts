
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { enqueueMock, FakeFleetHalted } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  FakeFleetHalted: class FakeFleetHalted extends Error {},
}));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: enqueueMock,
  AgentNotFoundError: class extends Error {},
  SafetyGateError: class extends Error {},
  BudgetExceededError: class extends Error {},
  InsufficientCreditsError: class extends Error {},
  BuildCreditsExhaustedError: class extends Error {},
}));
vi.mock("@/services/agents/fleet-halt", () => ({ FleetHaltedError: FakeFleetHalted }));

const { writeStaffAuditMock } = vi.hoisted(() => ({ writeStaffAuditMock: vi.fn() }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: writeStaffAuditMock }));

const { isStaffTenantMock } = vi.hoisted(() => ({ isStaffTenantMock: vi.fn(async () => false) }));
vi.mock("../staff-console-shared", async (importActual) => {
  const actual = await importActual<typeof import("../staff-console-shared")>();
  return { ...actual, isStaffOrInternalTenant: isStaffTenantMock, rateLimitExceeded: () => false };
});

const { serviceClientMock, inserts } = vi.hoisted(() => {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      let lastInsert: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.is = () => b;
      b.in = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.update = () => b;
      b.delete = () => b;
      b.insert = (row: Record<string, unknown>) => {
        lastInsert = row;
        inserts.push({ table, row });
        return b;
      };
      b.single = () => {
        if (table === "agent_threads") return Promise.resolve({ data: { id: "thr-1" }, error: null });
        if (table === "agent_thread_messages") return Promise.resolve({ data: { id: "msg-1" }, error: null });
        return Promise.resolve({ data: lastInsert, error: null });
      };
      b.maybeSingle = () => Promise.resolve({ data: { id: "thr-existing" }, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ error: null });
      return b;
    },
  };
  return { serviceClientMock: vi.fn(() => client), inserts };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffAgentChat } from "../agent-chat";
import { _resetIdempotencyForTests } from "../staff-console-shared";

function makeReqRes(opts: {
  slug?: string;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const req = {
    params: { tenant_id: "11111111-1111-1111-1111-111111111111", slug: opts.slug ?? "operator" },
    body: opts.body ?? { message: "hello operator" },
    headers: opts.headers ?? {},
  } as unknown as Parameters<typeof staffAgentChat>[0];
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
  };
  return { req, res: res as unknown as Parameters<typeof staffAgentChat>[1] & typeof res };
}

beforeEach(() => {
  _resetIdempotencyForTests();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ run_id: "run-1" });
  writeStaffAuditMock.mockReset();
  writeStaffAuditMock.mockResolvedValue(undefined);
  isStaffTenantMock.mockReset();
  isStaffTenantMock.mockResolvedValue(false);
  assertStaffMock.mockReset();
  assertStaffMock.mockReturnValue({ user_id: "u-staff", email: "ravi@upcar.ai" });
  inserts.length = 0;
});

describe("staffAgentChat (Slice 1)", () => {
  it("guard is wired: assertStaff throwing aborts the handler (no enqueue)", async () => {
    assertStaffMock.mockImplementation(() => {
      throw new Error("assertStaff: req.staff missing");
    });
    const { req, res } = makeReqRes({});
    await expect(staffAgentChat(req, res)).rejects.toThrow();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("non-operator slug → 400", async () => {
    const { req, res } = makeReqRes({ slug: "engineer" });
    await staffAgentChat(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("slug_not_allowed");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("staff/internal tenant → 403, no enqueue", async () => {
    isStaffTenantMock.mockResolvedValue(true);
    const { req, res } = makeReqRes({});
    await staffAgentChat(req, res);
    expect(res.statusCode).toBe(403);
    expect((res.payload as { error: { code: string } }).error.code).toBe("tenant_not_operable");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("happy path: enqueues a CHAT run with thread_id + origin:'staff_console', tags the staff turn, 202", async () => {
    const { req, res } = makeReqRes({});
    await staffAgentChat(req, res);
    expect(res.statusCode).toBe(202);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0][0] as {
      agent_slug: string;
      trigger: string;
      payload: Record<string, unknown>;
      user_access_token?: string;
    };
    expect(arg.agent_slug).toBe("operator");
    expect(arg.trigger).toBe("chat");
    expect(arg.payload.thread_id).toBe("thr-1");
    expect(arg.payload.user_message_id).toBe("msg-1");
    expect(arg.payload.origin).toBe("staff_console");
    expect(arg.user_access_token).toBeUndefined();
    const msgInsert = inserts.find((i) => i.table === "agent_thread_messages");
    expect((msgInsert?.row as { meta: { actor_source: string } }).meta.actor_source).toBe("staff");
    expect((res.payload as { run_id: string }).run_id).toBe("run-1");
  });

  it("double Idempotency-Key → single run", async () => {
    const headers = { "idempotency-key": "abc-123" };
    const r1 = makeReqRes({ headers });
    await staffAgentChat(r1.req, r1.res);
    const r2 = makeReqRes({ headers });
    await staffAgentChat(r2.req, r2.res);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(r2.res.statusCode).toBe(202);
    expect((r2.res.payload as { run_id: string }).run_id).toBe("run-1");
  });

  it("fleet halt → 503 and the orphan turn is rolled back", async () => {
    enqueueMock.mockRejectedValue(new FakeFleetHalted("halted"));
    const { req, res } = makeReqRes({});
    await staffAgentChat(req, res);
    expect(res.statusCode).toBe(503);
    expect((res.payload as { error: { code: string } }).error.code).toBe("fleet_halted");
  });
});

describe("staffAgentChat — three-tier pricing", () => {
  it("tier refusal → 403 with the plan_upgrade_required body (not a 500)", async () => {
    const body = {
      error: { code: "plan_upgrade_required", required_tier: "starter", message: "Operator needs the Starter plan ($20/mo)." },
    };
    enqueueMock.mockRejectedValue(
      Object.assign(new Error(body.error.message), {
        code: "plan_upgrade_required",
        agent_slug: "operator",
        required_tier: "starter",
        body,
      }),
    );
    const { req, res } = makeReqRes({});
    await staffAgentChat(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual(body);
  });
});
