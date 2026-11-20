
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  pipelineEnabled: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  eqCalls: [] as Array<[string, unknown]>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/fundraising/flag", () => ({
  fundraisingPipelineEnabled: mocks.pipelineEnabled,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
  serverClientFromBearer: () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      select: () => chain,
      eq: (col: string, val: unknown) => {
        mocks.eqCalls.push([col, val]);
        return chain;
      },
      limit: () => chain,
      maybeSingle: () => mocks.maybeSingle(),
    };
    return chain;
  },
}));

import { fundraisingSetOutreachState } from "../fundraising-outreach-state";

function makeReqRes(body: unknown) {
  const req = { headers: { authorization: "Bearer tok" }, body } as never;
  let jsonPayload: unknown;
  let statusCode = 200;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      jsonPayload = payload;
    },
    get jsonPayload() {
      return jsonPayload;
    },
    get statusCode() {
      return statusCode;
    },
  } as never & { jsonPayload: unknown; statusCode: number };
  return { req, res };
}

const TENANT = "11111111-1111-1111-1111-111111111111";
const FOREIGN_INVESTOR = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eqCalls = [];
  mocks.requireAuth.mockResolvedValue({
    tenant_id: TENANT,
    access_token: "tok",
    user_id: "u1",
  });
  mocks.pipelineEnabled.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ error: null });
});

describe("fundraisingSetOutreachState — guards + C8 trust boundary", () => {
  it("(c) invalid state → 400, never touches auth/flag/DB", async () => {
    const { req, res } = makeReqRes({ identity_key: "acme|", state: "bogus" });
    await fundraisingSetOutreachState(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a body with NEITHER identity_key nor investor_id → 400", async () => {
    const { req, res } = makeReqRes({ state: "sent" });
    await fundraisingSetOutreachState(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });

  it("rejects a body with BOTH identity_key and investor_id → 400", async () => {
    const { req, res } = makeReqRes({
      identity_key: "acme|",
      investor_id: FOREIGN_INVESTOR,
      state: "sent",
    });
    await fundraisingSetOutreachState(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });

  it("(b) flag-off tenant → 404, never looks up or writes", async () => {
    mocks.pipelineEnabled.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes({ identity_key: "acme|", state: "sent" });
    await fundraisingSetOutreachState(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(404);
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("(a) cross-tenant investor_id → 404 (lookup returns null), RPC never called", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { req, res } = makeReqRes({
      investor_id: FOREIGN_INVESTOR,
      state: "sent",
    });
    await fundraisingSetOutreachState(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.eqCalls).toContainEqual(["tenant_id", TENANT]);
  });

  it("(d) happy path → resolves tenant-scoped investor, calls RPC with JWT tenant", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { id: "inv-1" },
      error: null,
    });
    const { req, res } = makeReqRes({ identity_key: "acme|ed sim", state: "replied" });
    await fundraisingSetOutreachState(req, res as never);

    expect((res as { statusCode: number }).statusCode).toBe(200);
    const payload = (res as { jsonPayload: unknown }).jsonPayload as Record<
      string,
      unknown
    >;
    expect(payload.ok).toBe(true);
    expect(payload.investor_id).toBe("inv-1");
    expect(payload.state).toBe("replied");

    expect(mocks.rpc).toHaveBeenCalledOnce();
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fundraising_set_outreach_state");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_investor_id).toBe("inv-1");
    expect(args.p_state).toBe("replied");
    expect(mocks.eqCalls).toContainEqual(["tenant_id", TENANT]);
    expect(mocks.eqCalls).toContainEqual(["identity_key", "acme|ed sim"]);
  });

  it("a body-supplied tenant_id is IGNORED — the RPC gets the JWT tenant", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: { id: "inv-1" }, error: null });
    const { req, res } = makeReqRes({
      identity_key: "acme|",
      state: "sent",
      tenant_id: "attacker-tenant",
    });
    await fundraisingSetOutreachState(req, res as never);
    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_tenant_id).not.toBe("attacker-tenant");
  });
});
