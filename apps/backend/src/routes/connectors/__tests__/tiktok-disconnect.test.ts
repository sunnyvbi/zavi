import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const { rpc, clientUse, getSecret, revoke } = vi.hoisted(() => ({
  rpc: vi.fn(async (..._a: unknown[]) => ({ data: null, error: null as unknown })),
  clientUse: [] as string[],
  getSecret: vi.fn(async (..._a: unknown[]) => "access-token" as string | null),
  revoke: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "user-A", tenant_id: "t1", access_token: "jwt" })),
}));
vi.mock("@/services/supabase", () => {
  const client = (tag: string) => ({
    rpc: (...args: unknown[]) => { clientUse.push(tag); return rpc(...args); },
  });
  return { serviceClient: () => client("service"), serverClientFromBearer: () => client("bearer") };
});
vi.mock("@/services/secrets/vault", () => ({ getSecret }));
vi.mock("@/services/tenant-client", () => ({ oauthCallbackClient: vi.fn() }));
vi.mock("@/services/connectors/tiktok/api", () => ({
  exchangeTikTokCode: vi.fn(),
  tiktokAuthorizeUrl: vi.fn(),
  revokeTikTokToken: revoke,
}));

import { tiktokDisconnect } from "../tiktok";

function mockRes() {
  const res: { statusCode: number; body: unknown } & Record<string, unknown> = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res as unknown as Response & { statusCode: number; body: any };
}
const req = { headers: { authorization: "Bearer jwt" } } as unknown as Request;

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  getSecret.mockReset().mockResolvedValue("access-token");
  revoke.mockReset().mockResolvedValue(undefined);
  clientUse.length = 0;
});

describe("tiktokDisconnect", () => {
  it("runs disconnect_tiktok for the caller's tenant on the user-scoped client, then revokes", async () => {
    const res = mockRes();
    await tiktokDisconnect(req, res);
    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith("disconnect_tiktok", { p_tenant_id: "t1" });
    expect(clientUse).toEqual(["bearer"]);
    expect(revoke).toHaveBeenCalledWith("access-token");
  });

  it("maps the admin gate to 403 not_admin and does not revoke", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not admin" } });
    const res = mockRes();
    await tiktokDisconnect(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("not_admin");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("still disconnects when the token read fails, and a revoke failure is swallowed", async () => {
    getSecret.mockRejectedValue(new Error("vault down"));
    const res = mockRes();
    await tiktokDisconnect(req, res);
    expect(res.statusCode).toBe(200);
    expect(revoke).not.toHaveBeenCalled();

    getSecret.mockResolvedValue("access-token");
    revoke.mockRejectedValue(new Error("tiktok 500"));
    const res2 = mockRes();
    await tiktokDisconnect(req, res2);
    expect(res2.statusCode).toBe(200);
  });
});
