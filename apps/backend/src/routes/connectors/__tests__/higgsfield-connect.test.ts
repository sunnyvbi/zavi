import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rpc: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/services/connectors/higgsfield/connect", () => ({ probeHiggsfield: mocks.probe }));

import { higgsfieldConnect } from "../higgsfield";

function mockRes() {
  const res: { statusCode: number; body: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.rpc.mockReset();
  mocks.probe.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1" });
});

describe("higgsfieldConnect — probe-before-store", () => {
  it("400s an invalid body and never probes or stores", async () => {
    const res = mockRes();
    await higgsfieldConnect({ body: { access_token: "x" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a bad token at the probe and NEVER stores it (no rpc call)", async () => {
    mocks.probe.mockResolvedValueOnce({ ok: false, error: "401 unauthorized" });
    const res = mockRes();
    await higgsfieldConnect({ body: { access_token: "hf_badtoken_123" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("higgsfield_token_invalid");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stores via set_higgsfield_connection only after a passing probe", async () => {
    mocks.probe.mockResolvedValueOnce({ ok: true, balance: "1200 credits" });
    mocks.rpc.mockResolvedValueOnce({ error: null });
    const res = mockRes();
    await higgsfieldConnect(
      { body: { access_token: "hf_goodtoken_456", workspace_id: "ws_1" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean; balance: string }).ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("set_higgsfield_connection", {
      p_tenant_id: "tnt-1",
      p_access_token: "hf_goodtoken_456",
      p_workspace_id: "ws_1",
      p_workspace_name: null,
    });
  });

  it("500s on an RPC error and NEVER echoes the token or RPC detail to the client", async () => {
    mocks.probe.mockResolvedValueOnce({ ok: true, balance: "ok" });
    mocks.rpc.mockResolvedValueOnce({ error: { code: "23505", message: "secret-bearing detail" } });
    const res = mockRes();
    await higgsfieldConnect({ body: { access_token: "hf_goodtoken_789" } } as never, res as never);
    expect(res.statusCode).toBe(500);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("hf_goodtoken_789");
    expect(serialized).not.toContain("secret-bearing detail");
    expect((res.body as { error: { code: string } }).error.code).toBe("higgsfield_connect_failed");
  });

  it("returns early when auth fails (requireAuth already responded)", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await higgsfieldConnect({ body: { access_token: "hf_anything_000" } } as never, res as never);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
