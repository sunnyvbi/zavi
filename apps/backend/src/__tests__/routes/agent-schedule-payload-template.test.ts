
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const AUTH = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  user_id: "u1",
  access_token: "tok",
};

let _authResult: typeof AUTH | null = AUTH;

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => _authResult),
}));

const upsertMock = vi.fn(async () => undefined);
vi.mock("@/services/agents/schedules", () => ({
  getSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  upsertSchedule: (...args: unknown[]) => upsertMock(...(args as [])),
  ScheduleValidationError: class extends Error {},
  ScheduleForbiddenError: class extends Error {},
}));

import { agentSchedulePut } from "@/routes/agents/schedule";

function mkRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function mkReq(body: Record<string, unknown>) {
  return { params: { slug: "operator" }, body } as unknown as Request;
}

const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const goodTemplate = {
  standing_order: {
    prompt: "Post stalled approvals + GMV",
    deliver: { kind: "chat_thread", thread_id: THREAD_ID },
  },
};

describe("PUT /api/agents/:slug/schedule — payload_template", () => {
  beforeEach(() => {
    _authResult = AUTH;
    upsertMock.mockReset();
    upsertMock.mockResolvedValue(undefined);
  });

  it("back-compat: no payload_template ⇒ upsert called with null (RPC preserves existing)", async () => {
    const res = mkRes();
    await agentSchedulePut(mkReq({ cron_expression: "0 16 * * 1" }), res);
    expect(res.statusCode).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith(
      "tok",
      AUTH.tenant_id,
      "operator",
      "0 16 * * 1",
      true,
      null,
      undefined,
    );
  });

  it("valid standing_order template is validated and forwarded", async () => {
    const res = mkRes();
    await agentSchedulePut(
      mkReq({ cron_expression: "0 16 * * 1", payload_template: goodTemplate }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith(
      "tok",
      AUTH.tenant_id,
      "operator",
      "0 16 * * 1",
      true,
      goodTemplate,
      undefined,
    );
  });

  it("non-object template ⇒ 400 bad_payload_template, no write", async () => {
    const res = mkRes();
    await agentSchedulePut(
      mkReq({ cron_expression: "0 16 * * 1", payload_template: ["x"] }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "bad_payload_template",
    );
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("secret literal in template ⇒ 400, no write", async () => {
    const res = mkRes();
    await agentSchedulePut(
      mkReq({
        cron_expression: "0 16 * * 1",
        payload_template: { note: "token xoxb-1234567890-abcdefghij" },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("malformed standing_order shape ⇒ 400, no write", async () => {
    const res = mkRes();
    await agentSchedulePut(
      mkReq({
        cron_expression: "0 16 * * 1",
        payload_template: { standing_order: { prompt: "x" } },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("bad cron still rejected before any template handling", async () => {
    const res = mkRes();
    await agentSchedulePut(
      mkReq({ cron_expression: "nope", payload_template: goodTemplate }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("bad_cron");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
