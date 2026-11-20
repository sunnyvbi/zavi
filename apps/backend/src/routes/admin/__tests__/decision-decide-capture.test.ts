
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: decideMock }));

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("@/services/staff/capture-admin-correction", () => ({
  captureAdminCorrection: captureMock,
}));

const { writeStaffAuditMock } = vi.hoisted(() => ({ writeStaffAuditMock: vi.fn() }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: writeStaffAuditMock }));

const { serviceClientMock, setDecisionRow, setEditRpc } = vi.hoisted(() => {
  const state: {
    decisionRow: Record<string, unknown> | null;
    editRpc: { data: unknown; error: unknown };
  } = {
    decisionRow: {
      id: "d-1",
      tenant_id: "t-1",
      status: "proposed",
      decision_class: "support-lead.reply",
      body: { text: "before" },
    },
    editRpc: { data: { ok: true }, error: null },
  };
  const client = {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.decisionRow, error: null });
      return b;
    },
    rpc: () => Promise.resolve(state.editRpc),
  };
  return {
    serviceClientMock: vi.fn(() => client),
    setDecisionRow: (r: Record<string, unknown> | null) => {
      state.decisionRow = r;
    },
    setEditRpc: (data: unknown, error: unknown = null) => {
      state.editRpc = { data, error };
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffDecisionDecide } from "../decision-decide";

function makeReqRes(body: unknown) {
  const req = { params: { decision_id: "d-1" }, body } as unknown as Parameters<typeof staffDecisionDecide>[0];
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
  return { req, res: res as unknown as Parameters<typeof staffDecisionDecide>[1] & typeof res };
}

beforeEach(() => {
  captureMock.mockReset();
  captureMock.mockResolvedValue({ captured: true });
  writeStaffAuditMock.mockReset();
  writeStaffAuditMock.mockResolvedValue(undefined);
  decideMock.mockReset();
  setDecisionRow({
    id: "d-1",
    tenant_id: "t-1",
    status: "proposed",
    decision_class: "support-lead.reply",
    body: { text: "before" },
  });
  setEditRpc({ ok: true });
});

describe("staffDecisionDecide -> captureAdminCorrection wiring", () => {
  it("REJECT with changed:true fires capture with the reason", async () => {
    decideMock.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "rejected", decision_id: "d-1" });
    const { req, res } = makeReqRes({ action: "reject", reason: "off-policy tone" });
    await staffDecisionDecide(req, res);
    expect(captureMock).toHaveBeenCalledTimes(1);
    const arg = captureMock.mock.calls[0][0] as { action: string; reason: string };
    expect(arg.action).toBe("reject");
    expect(arg.reason).toBe("off-policy tone");
  });

  it("idempotent no-op (changed:false) does NOT fire capture", async () => {
    decideMock.mockResolvedValue({ ok: true, code: "ok", changed: false, status: "rejected", decision_id: "d-1" });
    const { req, res } = makeReqRes({ action: "reject", reason: "off-policy tone" });
    await staffDecisionDecide(req, res);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("approve with NO edit does NOT fire capture", async () => {
    decideMock.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: "d-1" });
    const { req, res } = makeReqRes({ action: "approve" });
    await staffDecisionDecide(req, res);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("approve WITH edit fires capture as an 'edit' with before/after", async () => {
    decideMock.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: "d-1" });
    const { req, res } = makeReqRes({ action: "approve", edited_body: { text: "after" } });
    await staffDecisionDecide(req, res);
    expect(captureMock).toHaveBeenCalledTimes(1);
    const arg = captureMock.mock.calls[0][0] as { action: string; before_body: unknown; after_body: unknown };
    expect(arg.action).toBe("edit");
    expect(arg.before_body).toEqual({ text: "before" });
    expect(arg.after_body).toEqual({ text: "after" });
  });

  it("staff cannot edit or approve a TikTok chat edit, and the body is never touched; reject still works", async () => {
    const rpc = vi.spyOn(serviceClientMock(), "rpc");
    setDecisionRow({ id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "tiktok_ads.update_budget", body: { daily_budget_usd: 90 } });
    const edit = makeReqRes({ action: "approve", edited_body: { daily_budget_usd: 120 } });
    await staffDecisionDecide(edit.req, edit.res);
    expect(edit.res.statusCode).toBe(400);
    const approve = makeReqRes({ action: "approve" });
    await staffDecisionDecide(approve.req, approve.res);
    expect(approve.res.statusCode).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
    decideMock.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "rejected", decision_id: "d-1" });
    const reject = makeReqRes({ action: "reject", reason: "not now" });
    await staffDecisionDecide(reject.req, reject.res);
    expect(decideMock).toHaveBeenCalledTimes(1);
  });

  it("a capture throw never fails the staff action", async () => {
    decideMock.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "rejected", decision_id: "d-1" });
    captureMock.mockRejectedValue(new Error("boom"));
    const { req, res } = makeReqRes({ action: "reject", reason: "x" });
    await staffDecisionDecide(req, res);
    expect(res.statusCode).toBe(200);
    expect((res.payload as { ok: boolean }).ok).toBe(true);
  });

  it("reject reason > 2000 chars is rejected by the body schema (400)", async () => {
    const { req, res } = makeReqRes({ action: "reject", reason: "x".repeat(2001) });
    await staffDecisionDecide(req, res);
    expect(res.statusCode).toBe(400);
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe("staffDecisionDecide on a tenant's Composio write (spec 12, E3)", () => {
  it("edited_body on a composio.* row → 400 edit_not_allowed, the edit RPC and decide never run", async () => {
    setDecisionRow({ id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "composio.write", body: { kind: "composio_write" } });
    setEditRpc(null, { message: "edit RPC must not be called" });
    const { req, res } = makeReqRes({ action: "approve", edited_body: { kind: "composio_write", arguments: { amount: 1 } } });
    await staffDecisionDecide(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("edit_not_allowed");
    expect(decideMock).not.toHaveBeenCalled();
  });
  for (const cls of ["composio.write", "composio.moves_money", "composio.deletes_data"]) {
    it(`staff plain approve of ${cls} → 403 not_authorized, decide never runs`, async () => {
      setDecisionRow({ id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: cls, body: { kind: "composio_write" } });
      const { req, res } = makeReqRes({ action: "approve" });
      await staffDecisionDecide(req, res);
      expect(res.statusCode).toBe(403);
      expect((res.payload as { error: { code: string } }).error.code).toBe("not_authorized");
      expect(decideMock).not.toHaveBeenCalled();
    });
  }
  it("staff reject of a composio.* row still works (reject is always safe)", async () => {
    setDecisionRow({ id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "composio.moves_money", body: { kind: "composio_write" } });
    decideMock.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "rejected", decision_id: "d-1" });
    const { req, res } = makeReqRes({ action: "reject", reason: "no" });
    await staffDecisionDecide(req, res);
    expect(res.statusCode).toBe(200);
    expect(decideMock).toHaveBeenCalled();
  });
});
