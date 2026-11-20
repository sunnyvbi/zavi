
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireAuthMock, state } = vi.hoisted(() => {
  const s = {
    auth: { user_id: "u-1", tenant_id: "11111111-1111-1111-1111-111111111111", access_token: "tok-1" } as
      | { user_id: string; tenant_id: string; access_token: string }
      | null,
  };
  return { requireAuthMock: vi.fn(async (_req: unknown, _res: unknown) => s.auth), state: s };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

const { rpcMock, rpcState } = vi.hoisted(() => {
  const rs = {
    args: [] as Array<[string, Record<string, unknown>]>,
    result: { data: { feedback_id: "fb-1", tenant_id: "11111111-1111-1111-1111-111111111111" }, error: null } as {
      data: unknown;
      error: { message: string } | null;
    },
  };
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    rs.args.push([name, args]);
    return { single: async () => rs.result };
  });
  return { rpcMock: rpc, rpcState: rs };
});
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({ rpc: rpcMock })),
}));

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: trackMock }));

import { feedbackProductSubmit } from "../product";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const FILE = "33333333-3333-3333-3333-333333333333";

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (body: unknown) => feedbackProductSubmit({ body } as any, makeRes() as any);
const callRes = async (body: unknown) => {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await feedbackProductSubmit({ body } as any, res as any);
  return res;
};

describe("POST /api/feedback/product", () => {
  beforeEach(() => {
    rpcState.args.length = 0;
    rpcState.result = { data: { feedback_id: "fb-1", tenant_id: TENANT }, error: null };
    state.auth = { user_id: "u-1", tenant_id: TENANT, access_token: "tok-1" };
    trackMock.mockClear();
  });

  it("saves the feedback and reports the row id", async () => {
    const res = await callRes({ body: "the chart colours are unreadable" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, feedback_id: "fb-1" });
    expect(rpcState.args[0][0]).toBe("submit_tenant_feedback");
    expect(rpcState.args[0][1].p_body).toBe("the chart colours are unreadable");
  });

  it("passes the SESSION tenant to the RPC and ignores a forged one in the body", async () => {
    await run({ body: "hi", tenant_id: OTHER, p_tenant_id: OTHER });
    const rejected = await callRes({ body: "hi", tenant_id: OTHER });
    expect(rejected.statusCode).toBe(400);

    const ok = await callRes({ body: "hi" });
    expect(ok.statusCode).toBe(200);
    const args = rpcState.args[rpcState.args.length - 1][1];
    expect(args.p_tenant_id).toBe(TENANT);
    expect(Object.values(args)).not.toContain(OTHER);
  });

  it("refuses an attachment path from another workspace", async () => {
    const res = await callRes({ body: "look", attachments: [`${OTHER}/${FILE}.jpg`] });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("invalid_attachment");
    expect(rpcState.args).toHaveLength(0);
  });

  it("accepts the caller's own attachment paths only in the shapes the upload routes return", async () => {
    const ok = await callRes({ body: "look", attachments: [`${TENANT}/${FILE}.jpg`, `${TENANT}/${FILE}.mp4`] });
    expect(ok.statusCode).toBe(200);
    const bad = await callRes({ body: "look", attachments: [`${TENANT}/${FILE}.exe`] });
    expect(bad.statusCode).toBe(400);
  });

  it("rejects empty feedback", async () => {
    expect((await callRes({ body: "" })).statusCode).toBe(400);
    expect((await callRes({})).statusCode).toBe(400);
  });

  it("surfaces an RPC rejection as a 400 so the client can keep the user's text", async () => {
    rpcState.result = { data: null, error: { message: "unauthorized" } };
    const res = await callRes({ body: "hi" });
    expect(res.statusCode).toBe(400);
  });

  it("never sends the feedback text to analytics", async () => {
    await callRes({ body: "my email is someone@example.com" });
    const props = trackMock.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(props)).not.toContain("someone@example.com");
    expect(props.tenant_id).toBe(TENANT);
  });
});
