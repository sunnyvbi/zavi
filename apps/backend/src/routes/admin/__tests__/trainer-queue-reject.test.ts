
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: vi.fn(async () => {}) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => {}) } }));

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("@/services/staff/capture-admin-correction", () => ({
  captureAdminCorrection: captureMock,
}));

const { serviceClientMock, S, reset } = vi.hoisted(() => {
  const state: {
    row: Record<string, unknown> | null;
    updateRows: Array<{ id: string }>;
  } = {
    row: { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "support-lead.reply" },
    updateRows: [{ id: "d-1" }],
  };
  const client = {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      b.update = () => {
        const u: Record<string, unknown> = {};
        u.eq = () => u;
        u.select = () => Promise.resolve({ data: state.updateRows, error: null });
        return u;
      };
      return b;
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    S: state,
    reset: () => {
      state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "support-lead.reply" };
      state.updateRows = [{ id: "d-1" }];
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffTrainerDecisionReject } from "../trainer-queue";

function makeReqRes(body: unknown) {
  const req = { params: { id: "d-1" }, body } as unknown as Parameters<typeof staffTrainerDecisionReject>[0];
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
  return { req, res: res as unknown as Parameters<typeof staffTrainerDecisionReject>[1] & typeof res };
}

beforeEach(() => {
  reset();
  captureMock.mockReset();
  captureMock.mockResolvedValue({ captured: true });
});

describe("staffTrainerDecisionReject — body validation (P2)", () => {
  it("400s on an invalid reject body (reason too long) — never rejects silently", async () => {
    const { req, res } = makeReqRes({ reason: "x".repeat(2001) });
    await staffTrainerDecisionReject(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_body");
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("400s on a non-string reason", async () => {
    const { req, res } = makeReqRes({ reason: 123 });
    await staffTrainerDecisionReject(req, res);
    expect(res.statusCode).toBe(400);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("valid reason flips the row (CAS) and fires capture", async () => {
    const { req, res } = makeReqRes({ reason: "off-policy" });
    await staffTrainerDecisionReject(req, res);
    expect(res.statusCode).toBe(200);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect((captureMock.mock.calls[0][0] as { reason: string }).reason).toBe("off-policy");
  });

  it("missing body (no reason) is valid -> rejects, capture no-ops on empty reason fallback", async () => {
    const { req, res } = makeReqRes({});
    await staffTrainerDecisionReject(req, res);
    expect(res.statusCode).toBe(200);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect((captureMock.mock.calls[0][0] as { reason: string }).reason).toBe("(no reason given)");
  });

  it("lost CAS race (0 rows changed) -> 409, no capture", async () => {
    S.updateRows = [];
    const { req, res } = makeReqRes({ reason: "off-policy" });
    await staffTrainerDecisionReject(req, res);
    expect(res.statusCode).toBe(409);
    expect(captureMock).not.toHaveBeenCalled();
  });
});
