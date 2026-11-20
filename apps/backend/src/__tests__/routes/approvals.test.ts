import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT = "00000000-0000-0000-0000-000000000001";
const USER = "10000000-0000-0000-0000-000000000001";
const VALID_DECISION_ID = "20000000-0000-4000-8000-000000000099";

const m = vi.hoisted(() => {
  const bearerListLimit = vi.fn();
  const bearerListOrder = vi.fn(() => ({ limit: bearerListLimit }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referential chainable mock
  const bearerListCountLimit = vi.fn(async () => ({ data: [], error: null }));
  const bearerListEq: any = vi.fn(() => ({
    eq: bearerListEq,
    order: bearerListOrder,
    limit: bearerListCountLimit,
    in: bearerListIn,
  }) as unknown);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable mock
  const bearerListIn: any = vi.fn(() => ({
    order: bearerListOrder,
    limit: bearerListCountLimit,
  }) as unknown);
  const bearerListSelect = vi.fn(() => ({ eq: bearerListEq }));
  const bearerRunsIn = vi.fn();
  const bearerRunsLimit = vi.fn(async () => ({ data: [], error: null }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable mock
  const bearerRunsEq: any = vi.fn(() => ({
    eq: bearerRunsEq,
    in: bearerRunsIn,
    limit: bearerRunsLimit,
  }) as unknown);
  const bearerRunsSelect = vi.fn(() => ({ in: bearerRunsIn, eq: bearerRunsEq }));
  const clsState: { rows: Array<{ slug: string }> } = { rows: [] };
  const bearerClsEq = vi.fn(async () => ({ data: clsState.rows, error: null }));
  const bearerClsSelect = vi.fn(() => ({ eq: bearerClsEq }));
  const bearerFrom = vi.fn((tbl: string) => {
    if (tbl === "customer_visible_pending_decisions" || tbl === "decisions") {
      return { select: bearerListSelect };
    }
    if (tbl === "agent_runs") return { select: bearerRunsSelect };
    if (tbl === "decision_classes") return { select: bearerClsSelect };
    return {};
  });
  const serverClientFromBearer = vi.fn(() => ({ from: bearerFrom }));
  const serviceClient = vi.fn(() => ({ from: vi.fn() }));

  const requireAuth = vi.fn().mockResolvedValue({
    user_id: "10000000-0000-0000-0000-000000000001",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    access_token: "fake-jwt",
  });

  const decideState: { result: Record<string, unknown> } = {
    result: { ok: true, code: "ok", changed: true, status: "approved", decision_id: "x" },
  };
  const decideOnDecision = vi.fn(async (_args: unknown) => decideState.result);

  return {
    bearerListLimit, bearerListOrder, bearerListEq, bearerListSelect,
    bearerRunsIn, bearerRunsEq, bearerRunsSelect, bearerFrom, serverClientFromBearer,
    serviceClient, requireAuth, decideState, decideOnDecision,
    clsState, bearerClsEq, bearerClsSelect,
  };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: m.serviceClient,
  serverClientFromBearer: m.serverClientFromBearer,
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: m.decideOnDecision }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { approvalsApprove, approvalsReject } from "../../routes/approvals/decide";
import { approvalsList } from "../../routes/approvals/list";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) { _s = c; return res; },
    json(b: unknown) { _b = b; return res; },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}

function mkReq(opts: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {}): Request {
  return { params: opts.params ?? {}, query: opts.query ?? {}, body: opts.body ?? {} } as unknown as Request;
}

beforeEach(() => {
  m.bearerListLimit.mockReset();
  m.bearerListOrder.mockClear();
  m.bearerListEq.mockClear();
  m.bearerListSelect.mockClear();
  m.bearerRunsIn.mockReset();
  m.bearerRunsSelect.mockClear();
  m.bearerFrom.mockClear();
  m.bearerClsEq.mockClear();
  m.bearerClsSelect.mockClear();
  m.clsState.rows = [];
  m.serverClientFromBearer.mockClear();
  m.serviceClient.mockClear();
  m.decideOnDecision.mockClear();
  m.decideState.result = { ok: true, code: "ok", changed: true, status: "approved", decision_id: VALID_DECISION_ID, allowlisted: false };
});

describe("POST /api/approvals/:decision_id/approve", () => {
  it("malformed UUID → 400 invalid_decision_id, no decide call", async () => {
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: "not-a-uuid" } }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("invalid_decision_id");
    expect(m.decideOnDecision).not.toHaveBeenCalled();
  });

  it("not_found from service → 404 decision_not_found", async () => {
    m.decideState.result = { ok: false, code: "not_found", changed: false, status: null, decision_id: VALID_DECISION_ID };
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("decision_not_found");
  });

  it("success → 200 + forwards approve action with actor + tenant + always_allow:false + ship_anyway:false", async () => {
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    expect(m.decideOnDecision).toHaveBeenCalledWith({
      decision_id: VALID_DECISION_ID,
      tenant_id: TENANT,
      action: "approve",
      actor: { user_id: USER },
      always_allow: false,
      ship_anyway: false,
    });
  });

  it("body {always_allow:true} → forwards always_allow:true + returns allowlisted", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: true, status: "approved", decision_id: VALID_DECISION_ID, allowlisted: true };
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID }, body: { always_allow: true } }), res);
    expect(status()).toBe(200);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ action: "approve", always_allow: true });
    expect((body() as { allowlisted: boolean }).allowlisted).toBe(true);
  });

  it("a click that lost to another ending (closed as out of date) → 409 decision_closed, not a success", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: false, status: "superseded", decision_id: VALID_DECISION_ID, allowlisted: false };
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(409);
    expect((body() as { error: { code: string; message: string } }).error).toMatchObject({ code: "decision_closed", message: expect.stringMatching(/^Not approved:/) });
  });

  it("a repeat approve of an approved decision stays a quiet 200", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: false, status: "acted", decision_id: VALID_DECISION_ID, allowlisted: false };
    const { res, status } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(200);
  });

  it("cross_tenant from service → 404 (not distinguishable from missing)", async () => {
    m.decideState.result = { ok: false, code: "cross_tenant", changed: false, status: "proposed", decision_id: VALID_DECISION_ID };
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("decision_not_found");
  });

  it("body {ship_anyway:true} → forwards ship_anyway:true (the /approvals `ship red`)", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: true, status: "approved", decision_id: VALID_DECISION_ID, allowlisted: false };
    const { res, status } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID }, body: { ship_anyway: true } }), res);
    expect(status()).toBe(200);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ action: "approve", ship_anyway: true });
  });

  it("requires_ship_red_override from service → 409 (operator must confirm ship-anyway)", async () => {
    m.decideState.result = { ok: false, code: "requires_ship_red_override", changed: false, status: "proposed", decision_id: VALID_DECISION_ID };
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(409);
    expect((body() as { error: { code: string } }).error.code).toBe("requires_ship_red_override");
  });

  it("body {expected_fingerprint} → forwarded to the service (Composio card seal)", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: true, status: "approved", decision_id: VALID_DECISION_ID, allowlisted: false };
    const fp = "ab".repeat(32);
    const { res, status } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID }, body: { expected_fingerprint: fp } }), res);
    expect(status()).toBe(200);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ action: "approve", expected_fingerprint: fp });
  });

  it("expected_scheduled_at is forwarded; schedule_changed → 409 with the current time", async () => {
    const LOADED = "2099-01-02T09:00:00.000Z";
    const MOVED = "2099-03-04T17:00:00Z";
    m.decideState.result = {
      ok: false,
      code: "schedule_changed",
      changed: false,
      status: "proposed",
      decision_id: VALID_DECISION_ID,
      current_scheduled_at: MOVED,
    } as never;
    const { res, status, body } = mkRes();
    await approvalsApprove(
      mkReq({ params: { decision_id: VALID_DECISION_ID }, body: { scheduled_at: LOADED, expected_scheduled_at: LOADED } }),
      res,
    );
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ scheduled_at: LOADED, expected_scheduled_at: LOADED });
    expect(status()).toBe(409);
    expect(body()).toMatchObject({ error: { code: "schedule_changed", current_scheduled_at: MOVED } });
  });

  it("stale_card from service → 409 stale_card (nothing ran; reload the card)", async () => {
    m.decideState.result = { ok: false, code: "stale_card", changed: false, status: "proposed", decision_id: VALID_DECISION_ID };
    const { res, status, body } = mkRes();
    await approvalsApprove(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(409);
    expect((body() as { error: { code: string } }).error.code).toBe("stale_card");
  });
});

describe("POST /api/approvals/:decision_id/reject", () => {
  it("malformed UUID → 400 (mirror), no decide call", async () => {
    const { res, status, body } = mkRes();
    await approvalsReject(mkReq({ params: { decision_id: "garbage" } }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("invalid_decision_id");
    expect(m.decideOnDecision).not.toHaveBeenCalled();
  });

  it("success → 200 + forwards reject action", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: true, status: "rejected", decision_id: VALID_DECISION_ID };
    const { res, status, body } = mkRes();
    await approvalsReject(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ action: "reject", actor: { user_id: USER } });
  });

  it("plain reject (changed) → attempts the founder_override correction capture", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: true, status: "rejected", decision_id: VALID_DECISION_ID };
    const { res, status } = mkRes();
    await approvalsReject(mkReq({ params: { decision_id: VALID_DECISION_ID } }), res);
    expect(status()).toBe(200);
    expect(m.serviceClient).toHaveBeenCalled();
  });

  it("reject with refine:true → 200 + SKIPS the correction capture (no serviceClient read)", async () => {
    m.decideState.result = { ok: true, code: "ok", changed: true, status: "rejected", decision_id: VALID_DECISION_ID };
    const { res, status, body } = mkRes();
    await approvalsReject(
      mkReq({ params: { decision_id: VALID_DECISION_ID }, body: { refine: true } }),
      res,
    );
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ action: "reject" });
    expect(m.serviceClient).not.toHaveBeenCalled();
  });
});

describe("GET /api/approvals — query param parsing", () => {
  it("?status=approved → bearer filter uses 'approved'", async () => {
    m.bearerListLimit.mockResolvedValue({ data: [], error: null });
    const { res, status } = mkRes();
    await approvalsList(mkReq({ query: { status: "approved" } }), res);
    expect(status()).toBe(200);
    expect(m.bearerListEq).toHaveBeenCalledWith("status", "approved");
    expect(m.bearerListEq).not.toHaveBeenCalledWith("autonomy_at_emit", "approval");
  });

  it("?status=garbage → falls back to the pending view (no 400)", async () => {
    m.bearerListLimit.mockResolvedValue({ data: [], error: null });
    const { res, status } = mkRes();
    await approvalsList(mkReq({ query: { status: "garbage" } }), res);
    expect(status()).toBe(200);
    expect(m.bearerFrom).toHaveBeenCalledWith("customer_visible_pending_decisions");
    expect(m.bearerListEq).not.toHaveBeenCalledWith("status", "garbage");
  });

  it("pending queue reads the shared predicate view, not the raw table", async () => {
    m.bearerListLimit.mockResolvedValue({ data: [], error: null });
    const { res, status } = mkRes();
    await approvalsList(mkReq({ query: {} }), res);
    expect(status()).toBe(200);
    expect(m.bearerFrom).toHaveBeenCalledWith("customer_visible_pending_decisions");
    expect(m.bearerFrom).not.toHaveBeenCalledWith("decisions");
    expect(m.bearerListEq).not.toHaveBeenCalledWith("status", "proposed");
    expect(m.bearerListEq).not.toHaveBeenCalledWith("autonomy_at_emit", "approval");
    expect(m.bearerListEq).toHaveBeenCalledWith("tenant_id", TENANT);
  });

  it("?include= (empty) → enrichment OFF, no agent_slug key on rows", async () => {
    m.bearerListLimit.mockResolvedValue({
      data: [
        {
          id: VALID_DECISION_ID,
          agent_run_id: "30000000-0000-0000-0000-000000000001",
          decision_class: "x",
          body: {},
          status: "proposed",
          autonomy_at_emit: null,
          handler: null,
          emitted_at: "2026-05-26T00:00:00Z",
          approved_at: null,
          dispatched_at: null,
          dispatch_error: null,
        },
      ],
      error: null,
    });
    const { res, status, body } = mkRes();
    await approvalsList(mkReq({ query: { include: "" } }), res);
    expect(status()).toBe(200);
    const decisions = (body() as { decisions: Record<string, unknown>[] }).decisions;
    expect(decisions.length).toBe(1);
    expect("agent_slug" in decisions[0]).toBe(false);
    expect("thread_id" in decisions[0]).toBe(false);
    expect(decisions[0].click_allowlistable).toBe(false);
    expect(m.bearerRunsSelect).not.toHaveBeenCalled();
  });

  it("click_allowlistable=true on a decision whose class is in the allowlistable set", async () => {
    m.clsState.rows = [{ slug: "send_email" }];
    m.bearerListLimit.mockResolvedValue({
      data: [
        {
          id: VALID_DECISION_ID,
          agent_run_id: null,
          decision_class: "send_email",
          body: {},
          status: "proposed",
          autonomy_at_emit: "approval",
          handler: "gmail.send",
          emitted_at: "2026-05-26T00:00:00Z",
          approved_at: null,
          dispatched_at: null,
          dispatch_error: null,
        },
      ],
      error: null,
    });
    const { res, status, body } = mkRes();
    await approvalsList(mkReq({ query: {} }), res);
    expect(status()).toBe(200);
    const decisions = (body() as { decisions: Record<string, unknown>[] }).decisions;
    expect(decisions[0].click_allowlistable).toBe(true);
    expect(m.bearerClsEq).toHaveBeenCalled();
  });
});

describe("GET /api/approvals — thread_id enrichment", () => {
  const OP_THREAD = "40000000-0000-4000-8000-000000000001";
  const CHAT_THREAD = "40000000-0000-4000-8000-000000000002";
  const decisionOn = (runId: string) => ({
    id: VALID_DECISION_ID,
    agent_run_id: runId,
    decision_class: "engineer.ship_pr",
    body: {},
    status: "proposed",
    autonomy_at_emit: "approval",
    handler: null,
    emitted_at: "2026-09-17T00:00:00Z",
    approved_at: null,
    dispatched_at: null,
    dispatch_error: null,
  });

  it("a handoff child run with only operator_thread_id → that thread_id", async () => {
    const RUN = "30000000-0000-4000-8000-000000000011";
    m.bearerListLimit.mockResolvedValue({ data: [decisionOn(RUN)], error: null });
    m.bearerRunsIn.mockResolvedValue({
      data: [
        {
          id: RUN,
          agent_slug: "engineer",
          channel_slug: null,
          payload: { operator_thread_id: OP_THREAD, intent: "fix it" },
        },
      ],
      error: null,
    });
    const { res, status, body } = mkRes();
    await approvalsList(mkReq({ query: {} }), res);
    expect(status()).toBe(200);
    const decisions = (body() as { decisions: Record<string, unknown>[] }).decisions;
    expect(decisions[0].thread_id).toBe(OP_THREAD);
    expect(decisions[0].agent_slug).toBe("engineer");
    expect(m.bearerRunsEq).toHaveBeenCalledWith("tenant_id", TENANT);
  });

  it("payload.thread_id still wins when both are present", async () => {
    const RUN = "30000000-0000-4000-8000-000000000012";
    m.bearerListLimit.mockResolvedValue({ data: [decisionOn(RUN)], error: null });
    m.bearerRunsIn.mockResolvedValue({
      data: [
        {
          id: RUN,
          agent_slug: "operator",
          channel_slug: null,
          payload: { thread_id: CHAT_THREAD, operator_thread_id: OP_THREAD },
        },
      ],
      error: null,
    });
    const { res, body } = mkRes();
    await approvalsList(mkReq({ query: {} }), res);
    const decisions = (body() as { decisions: Record<string, unknown>[] }).decisions;
    expect(decisions[0].thread_id).toBe(CHAT_THREAD);
  });
});

void TENANT;
void USER;
