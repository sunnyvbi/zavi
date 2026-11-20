
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { decideMock, order } = vi.hoisted(() => ({ decideMock: vi.fn(), order: [] as string[] }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: decideMock }));

const { writeStaffAuditMock } = vi.hoisted(() => ({ writeStaffAuditMock: vi.fn() }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: writeStaffAuditMock }));

const { isStaffTenantMock } = vi.hoisted(() => ({ isStaffTenantMock: vi.fn(async () => false) }));
vi.mock("../staff-console-shared", async (importActual) => {
  const actual = await importActual<typeof import("../staff-console-shared")>();
  return { ...actual, isStaffOrInternalTenant: isStaffTenantMock, rateLimitExceeded: () => false };
});

const { serviceClientMock, state } = vi.hoisted(() => {
  const state = {
    decision: {
      tenant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "proposed",
      decision_class: "support-lead.reply",
      body: {} as Record<string, unknown>,
    } as Record<string, unknown> | null,
    wormError: null as { message: string } | null,
    orderRef: [] as string[],
  };
  const client = {
    from() {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.decision, error: null });
      return b;
    },
    rpc: (name: string) => {
      if (name === "admin_action_log_append") {
        state.orderRef.push("worm");
        return Promise.resolve({ data: state.wormError ? null : "log-1", error: state.wormError });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { serviceClientMock: vi.fn(() => client), state };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffDecisionExecute } from "../decision-execute";
import { _resetIdempotencyForTests } from "../staff-console-shared";

function makeReqRes(opts: { tenant?: string; body?: unknown; headers?: Record<string, string> }) {
  const req = {
    params: {
      tenant_id: opts.tenant ?? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      decision_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    },
    body: opts.body ?? { reason: "customer asked us to push it" },
    headers: opts.headers ?? {},
  } as unknown as Parameters<typeof staffDecisionExecute>[0];
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
  return { req, res: res as unknown as Parameters<typeof staffDecisionExecute>[1] & typeof res };
}

beforeEach(() => {
  _resetIdempotencyForTests();
  state.orderRef.length = 0;
  order.length = 0;
  state.decision = {
    tenant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    status: "proposed",
    decision_class: "support-lead.reply",
    body: {},
  };
  state.wormError = null;
  decideMock.mockReset();
  decideMock.mockImplementation(async () => {
    state.orderRef.push("decide");
    return { ok: true, code: "ok", changed: true, status: "approved", decision_id: "dddddddd-dddd-dddd-dddd-dddddddddddd" };
  });
  writeStaffAuditMock.mockReset();
  writeStaffAuditMock.mockResolvedValue(undefined);
  isStaffTenantMock.mockReset();
  isStaffTenantMock.mockResolvedValue(false);
  assertStaffMock.mockReset();
  assertStaffMock.mockReturnValue({ user_id: "u-staff", email: "ravi@upcar.ai" });
});

describe("staffDecisionExecute (Slice 3)", () => {
  it("guard is wired: assertStaff throwing aborts (no decide)", async () => {
    assertStaffMock.mockImplementation(() => {
      throw new Error("assertStaff: req.staff missing");
    });
    const { req, res } = makeReqRes({});
    await expect(staffDecisionExecute(req, res)).rejects.toThrow();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("decision.tenant_id != path tenant → 403, no WORM, no decide", async () => {
    state.decision = { ...(state.decision as Record<string, unknown>), tenant_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    const { req, res } = makeReqRes({ tenant: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(403);
    expect((res.payload as { error: { code: string } }).error.code).toBe("tenant_mismatch");
    expect(state.orderRef).toEqual([]);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("blank reason → 400", async () => {
    const { req, res } = makeReqRes({ body: { reason: "   " } });
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("reason_required");
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("RED action without override_red → 409", async () => {
    state.decision = { ...(state.decision as Record<string, unknown>), body: { approval_class: "ship_red" } };
    const { req, res } = makeReqRes({ body: { reason: "ship it" } });
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(409);
    expect((res.payload as { error: { code: string } }).error.code).toBe("red_override_required");
    expect(state.orderRef).toEqual([]);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("RED action WITH override_red proceeds (worm then decide)", async () => {
    state.decision = { ...(state.decision as Record<string, unknown>), body: { approval_class: "ship_red" } };
    const { req, res } = makeReqRes({ body: { reason: "ship it", override_red: true } });
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(200);
    expect(state.orderRef).toEqual(["worm", "decide"]);
    const arg = decideMock.mock.calls[0][0] as { ship_anyway?: boolean; staff_override?: boolean };
    expect(arg.ship_anyway).toBe(true);
    expect(arg.staff_override).toBe(true);
  });

  it("WORM-append failure → 500 executed:false AND decide is NEVER called", async () => {
    state.wormError = { message: "append boom" };
    const { req, res } = makeReqRes({});
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(500);
    expect((res.payload as { executed: boolean }).executed).toBe(false);
    expect(state.orderRef).toEqual(["worm"]);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("happy path: WORM row is written BEFORE decide, decide gets staff_override:true", async () => {
    const { req, res } = makeReqRes({});
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(200);
    expect(state.orderRef).toEqual(["worm", "decide"]);
    const arg = decideMock.mock.calls[0][0] as {
      staff_override?: boolean;
      tenant_id: string;
      action: string;
      actor: { user_id: string };
    };
    expect(arg.staff_override).toBe(true);
    expect(arg.action).toBe("approve");
    expect(arg.tenant_id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(arg.actor.user_id).toBe("u-staff");
  });

  it("staff/internal tenant → 403, no WORM, no decide", async () => {
    isStaffTenantMock.mockResolvedValue(true);
    const { req, res } = makeReqRes({});
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(403);
    expect(state.orderRef).toEqual([]);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("non-proposed decision → 409 not_proposed, no WORM", async () => {
    state.decision = { ...(state.decision as Record<string, unknown>), status: "approved" };
    const { req, res } = makeReqRes({});
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(409);
    expect((res.payload as { error: { code: string } }).error.code).toBe("not_proposed");
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("double Idempotency-Key → single execution", async () => {
    const headers = { "idempotency-key": "exec-key-1" };
    const r1 = makeReqRes({ headers });
    await staffDecisionExecute(r1.req, r1.res);
    const r2 = makeReqRes({ headers });
    await staffDecisionExecute(r2.req, r2.res);
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(r2.res.statusCode).toBe(200);
  });

  it("malformed decision id → 400 before any decide or WORM write", async () => {
    const { req, res } = makeReqRes({});
    (req as unknown as { params: Record<string, string> }).params.decision_id = "not-a-uuid";
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_decision_id");
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("CAS lost (changed:false) → 409 already_decided, never a false success", async () => {
    decideMock.mockImplementation(async () => {
      state.orderRef.push("decide");
      return {
        ok: true,
        code: "ok",
        changed: false,
        status: "approved",
        decision_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      };
    });
    const { req, res } = makeReqRes({});
    await staffDecisionExecute(req, res);
    expect(res.statusCode).toBe(409);
    const p = res.payload as { error: { code: string }; executed: boolean };
    expect(p.error.code).toBe("already_decided");
    expect(p.executed).toBe(false);
  });
});

describe("staffDecisionExecute never runs a tenant's Composio write (spec 12, E3)", () => {
  for (const cls of ["composio.write", "composio.moves_money", "composio.deletes_data"]) {
    it(`${cls} → 403 not_authorized, no WORM row, no decide`, async () => {
      state.decision = { ...(state.decision as Record<string, unknown>), decision_class: cls, body: { kind: "composio_write" } };
      const { req, res } = makeReqRes({ body: { reason: "customer asked" } });
      await staffDecisionExecute(req, res);
      expect(res.statusCode).toBe(403);
      expect((res.payload as { error: { code: string } }).error.code).toBe("not_authorized");
      expect(state.orderRef).toEqual([]);
      expect(decideMock).not.toHaveBeenCalled();
    });
  }
});
