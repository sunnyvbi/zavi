import { describe, it, expect, beforeEach, vi } from "vitest";
const audit = vi.hoisted(() => ({ record: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: audit.record }));
import type { Request, Response } from "express";

const { rpc, clientUse, bearerTokens, getSecret, revoke, swap } = vi.hoisted(() => ({
  rpc: vi.fn(async (..._a: unknown[]) => ({ data: null, error: null as unknown })),
  clientUse: [] as string[],
  bearerTokens: [] as unknown[],
  getSecret: vi.fn(async (..._a: unknown[]) => "access-token" as string | null),
  revoke: vi.fn(async (..._a: unknown[]) => undefined),
  swap: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "user-A", tenant_id: "t1", access_token: "jwt" })),
}));
vi.mock("@/services/supabase", () => {
  const client = (tag: string) => ({
    rpc: (...args: unknown[]) => { clientUse.push(tag); return rpc(...args); },
  });
  return {
    serviceClient: () => client("service"),
    serverClientFromBearer: (token: unknown) => {
      bearerTokens.push(token);
      return client("bearer");
    },
  };
});
vi.mock("@/services/secrets/vault", () => ({ getSecret }));
vi.mock("@/services/connectors/core/registry", () => ({
  isKnownConnector: (slug: string) => slug === "x_social" || slug === "linear",
  getConnector: (slug: string) =>
    slug === "x_social"
      ? { slug, serverId: "x_social", revokeToken: revoke }
      : slug === "linear"
        ? { slug, serverId: "linear" }
        : null,
}));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: swap }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn() }));

import { connectorDisconnect } from "../connector";

function mockRes() {
  const res: { statusCode: number; body: unknown } & Record<string, unknown> = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res as unknown as Response & { statusCode: number; body: any };
}
const reqFor = (connector: string) =>
  ({ params: { connector }, headers: { authorization: "bearer jwt" } }) as unknown as Request;

beforeEach(() => {
  audit.record.mockClear();
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  getSecret.mockReset().mockResolvedValue("access-token");
  revoke.mockReset().mockResolvedValue(undefined);
  swap.mockReset().mockResolvedValue(undefined);
  clientUse.length = 0;
  bearerTokens.length = 0;
});

describe("connectorDisconnect", () => {
  it("runs disconnect_connector for the caller's tenant on the user-scoped client, then revokes", async () => {
    const res = mockRes();
    await connectorDisconnect(reqFor("x_social"), res);
    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith("disconnect_connector", {
      p_tenant_id: "t1",
      p_slug: "x_social",
      p_server_id: "x_social",
    });
    expect(clientUse).toEqual(["bearer"]);
    expect(bearerTokens).toEqual(["jwt"]);
    expect(revoke).toHaveBeenCalledWith("access-token");
    expect(res.body).toEqual({ ok: true, revoked: true });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("cancels the dropped account's queued posts, since reconnect can no longer see a swap", async () => {
    await connectorDisconnect(reqFor("x_social"), mockRes());
    expect(swap).toHaveBeenCalledWith("t1", "x_social");
  });

  it("404s an unknown slug without touching Vault or the database", async () => {
    const res = mockRes();
    await connectorDisconnect(reqFor("../../etc"), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("unknown_connector");
    expect(getSecret).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads no secret for a connector with no revoke endpoint", async () => {
    const res = mockRes();
    await connectorDisconnect(reqFor("linear"), res);
    expect(res.statusCode).toBe(200);
    expect(getSecret).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, revoked: false });
  });

  it("maps the admin gate to 403 not_admin and does not revoke", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not admin" } });
    const res = mockRes();
    await connectorDisconnect(reqFor("x_social"), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("not_admin");
    expect(revoke).not.toHaveBeenCalled();
    expect(swap).not.toHaveBeenCalled();
  });

  it("still disconnects when the token read fails, and reports the revoke as not done", async () => {
    getSecret.mockRejectedValue(new Error("vault down"));
    const res = mockRes();
    await connectorDisconnect(reqFor("x_social"), res);
    expect(res.statusCode).toBe(200);
    expect(revoke).not.toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, revoked: false });
  });

  it("reports revoked:false when the vendor rejects the revocation", async () => {
    revoke.mockRejectedValue(new Error("x 500"));
    const res = mockRes();
    await connectorDisconnect(reqFor("x_social"), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, revoked: false });
  });

  it("revokes only after the teardown RPC succeeds", async () => {
    const order: string[] = [];
    rpc.mockImplementation(async () => {
      order.push("rpc");
      return { data: null, error: null };
    });
    revoke.mockImplementation(async () => {
      order.push("revoke");
    });
    await connectorDisconnect(reqFor("x_social"), mockRes());
    expect(order).toEqual(["rpc", "revoke"]);
  });
});
