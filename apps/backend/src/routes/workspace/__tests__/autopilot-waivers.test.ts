
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };
const rpcSpy = vi.fn(
  async (_name: string, _args: Record<string, unknown>) => rpcResult,
);

let waiverListResult: { data: unknown; error: unknown } = { data: [], error: null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listChain: any = {
  select: vi.fn(() => listChain),
  eq: vi.fn(() => listChain),
  not: vi.fn(() => listChain),
  gt: vi.fn(() => listChain),
  order: vi.fn(async () => waiverListResult),
};

let authResult: { user_id: string; tenant_id: string; access_token: string } | null = {
  user_id: "u-1",
  tenant_id: "t-1",
  access_token: "tok",
};

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    from: vi.fn(() => listChain),
  })),
  serviceClient: vi.fn(() => ({
    rpc: rpcSpy,
  })),
}));

import {
  postAutopilotWaiver,
  deleteAutopilotWaiver,
  getAutopilotWaivers,
} from "../autopilot";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) { _s = c; return res; },
    json(b: unknown) { _b = b; return res; },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}
function mkReq(body: unknown, params?: Record<string, string>): Request {
  return { body, params: params ?? {} } as unknown as Request;
}

const futureIso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

beforeEach(() => {
  rpcResult = { data: { ok: true }, error: null };
  waiverListResult = { data: [], error: null };
  rpcSpy.mockClear();
  Object.values(listChain).forEach((m) => {
    if ("mockClear" in (m as object)) (m as ReturnType<typeof vi.fn>).mockClear();
  });
  authResult = { user_id: "u-1", tenant_id: "t-1", access_token: "tok" };
});

describe("POST /api/workspace/autopilot/waivers", () => {
  it("401 unauthed", async () => {
    authResult = null;
    const { res, status } = mkRes();
    await postAutopilotWaiver(
      mkReq({ decision_class: "send_email", expires_at: futureIso(60_000), max_daily_usd: 5 }),
      res,
    );
    expect(status()).toBe(401);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 missing decision_class", async () => {
    const { res, status, body } = mkRes();
    await postAutopilotWaiver(mkReq({ expires_at: futureIso(60_000), max_daily_usd: 5 }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("bad_request");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 expires_at in the past", async () => {
    const { res, status, body } = mkRes();
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: new Date(Date.now() - 1000).toISOString(),
        max_daily_usd: 5,
      }),
      res,
    );
    expect(status()).toBe(400);
    expect((body() as { error: { message: string } }).error.message).toMatch(/in the future/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 expires_at exceeds 7-day ceiling", async () => {
    const { res, status, body } = mkRes();
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: futureIso(8 * 24 * 60 * 60 * 1000),
        max_daily_usd: 5,
      }),
      res,
    );
    expect(status()).toBe(400);
    expect((body() as { error: { message: string } }).error.message).toMatch(/7-day ceiling/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 max_daily_usd > $100 ceiling", async () => {
    const { res, status, body } = mkRes();
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: futureIso(60_000),
        max_daily_usd: 250,
      }),
      res,
    );
    expect(status()).toBe(400);
    expect((body() as { error: { message: string } }).error.message).toMatch(/\$100 ceiling/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 negative max_daily_usd", async () => {
    const { res, status } = mkRes();
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: futureIso(60_000),
        max_daily_usd: -1,
      }),
      res,
    );
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 non-integer cooling_off_seconds", async () => {
    const { res, status } = mkRes();
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: futureIso(60_000),
        max_daily_usd: 5,
        cooling_off_seconds: 1.5,
      }),
      res,
    );
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("200 happy path — calls grant_autopilot_waiver with server-derived tenant_id", async () => {
    const { res, status, body } = mkRes();
    const expIso = futureIso(60_000);
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: expIso,
        max_daily_usd: 5,
        cooling_off_seconds: 30,
      }),
      res,
    );
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy.mock.calls[0]).toEqual([
      "grant_autopilot_waiver",
      {
        p_tenant_id: "t-1",
        p_decision_class: "send_email",
        p_expires_at: expIso,
        p_max_daily_usd: 5,
        p_cooling_off_seconds: 30,
      },
    ]);
  });

  it("cooling_off_seconds defaults to 0 when omitted", async () => {
    const { res, status } = mkRes();
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: futureIso(60_000),
        max_daily_usd: 5,
      }),
      res,
    );
    expect(status()).toBe(200);
    expect(rpcSpy.mock.calls[0][1]).toMatchObject({ p_cooling_off_seconds: 0 });
  });

  it("500 on RPC error", async () => {
    rpcResult = { data: null, error: { message: "rpc boom" } };
    const { res, status, body } = mkRes();
    await postAutopilotWaiver(
      mkReq({
        decision_class: "send_email",
        expires_at: futureIso(60_000),
        max_daily_usd: 5,
      }),
      res,
    );
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("grant_waiver_failed");
  });
});

describe("DELETE /api/workspace/autopilot/waivers/:decision_class", () => {
  it("401 unauthed", async () => {
    authResult = null;
    const { res, status } = mkRes();
    await deleteAutopilotWaiver(mkReq({}, { decision_class: "send_email" }), res);
    expect(status()).toBe(401);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 empty decision_class path param", async () => {
    const { res, status } = mkRes();
    await deleteAutopilotWaiver(mkReq({}, { decision_class: " " }), res);
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("200 happy revoke — RPC returned had_waiver:true", async () => {
    rpcResult = { data: { ok: true, had_waiver: true }, error: null };
    const { res, status, body } = mkRes();
    await deleteAutopilotWaiver(mkReq({}, { decision_class: "send_email" }), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true, decision_class: "send_email" });
    expect(rpcSpy).toHaveBeenCalledWith("revoke_autopilot_waiver", {
      p_tenant_id: "t-1",
      p_decision_class: "send_email",
    });
  });

  it("404 when there was no active waiver to revoke (had_waiver:false)", async () => {
    rpcResult = { data: { ok: true, had_waiver: false }, error: null };
    const { res, status, body } = mkRes();
    await deleteAutopilotWaiver(mkReq({}, { decision_class: "send_email" }), res);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("no_active_waiver");
    expect(rpcSpy).toHaveBeenCalledTimes(1);
  });

  it("500 on RPC error", async () => {
    rpcResult = { data: null, error: { message: "rpc boom" } };
    const { res, status, body } = mkRes();
    await deleteAutopilotWaiver(mkReq({}, { decision_class: "send_email" }), res);
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("revoke_waiver_failed");
  });
});

describe("GET /api/workspace/autopilot/waivers", () => {
  it("401 unauthed", async () => {
    authResult = null;
    const { res, status } = mkRes();
    await getAutopilotWaivers(mkReq({}), res);
    expect(status()).toBe(401);
  });

  it("200 empty list (no active waivers)", async () => {
    waiverListResult = { data: [], error: null };
    const { res, status, body } = mkRes();
    await getAutopilotWaivers(mkReq({}), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ waivers: [] });
    expect(listChain.eq).toHaveBeenCalledWith("tenant_id", "t-1");
    expect(listChain.not).toHaveBeenCalledWith("waiver_expires_at", "is", null);
    expect(listChain.gt).toHaveBeenCalledWith("waiver_expires_at", expect.any(String));
    expect(listChain.order).toHaveBeenCalledWith("waiver_expires_at", { ascending: true });
  });

  it("200 maps rows to the public shape (cap from string → number)", async () => {
    waiverListResult = {
      data: [
        {
          decision_class: "send_email",
          waiver_expires_at: "2099-01-01T00:00:00Z",
          waiver_max_daily_usd: "25.50",
          waiver_cooling_off_seconds: 30,
        },
        {
          decision_class: "post_slack_message",
          waiver_expires_at: "2099-02-01T00:00:00Z",
          waiver_max_daily_usd: 5,
          waiver_cooling_off_seconds: null,
        },
      ],
      error: null,
    };
    const { res, status, body } = mkRes();
    await getAutopilotWaivers(mkReq({}), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({
      waivers: [
        {
          decision_class: "send_email",
          expires_at: "2099-01-01T00:00:00Z",
          max_daily_usd: 25.5,
          cooling_off_seconds: 30,
        },
        {
          decision_class: "post_slack_message",
          expires_at: "2099-02-01T00:00:00Z",
          max_daily_usd: 5,
          cooling_off_seconds: 0,
        },
      ],
    });
  });

  it("500 on DB error", async () => {
    waiverListResult = { data: null, error: { message: "db boom" } };
    const { res, status, body } = mkRes();
    await getAutopilotWaivers(mkReq({}), res);
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("list_waivers_failed");
  });
});
