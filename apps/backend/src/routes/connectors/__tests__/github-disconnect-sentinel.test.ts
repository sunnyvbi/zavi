import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const { authState, fromState, rpc, clientUse } = vi.hoisted(() => ({
  authState: { user_id: "user-A", tenant_id: "t1", access_token: "jwt" },
  fromState: {
    row: null as unknown,
    readError: null as unknown,
    filters: {} as Record<string, unknown>,
  },
  rpc: vi.fn(async () => ({ data: null, error: null as unknown })),
  clientUse: { from: [] as string[], rpc: [] as string[] },
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => authState),
}));
vi.mock("@/services/supabase", () => {
  const makeClient = (tag: string) => {
    const makeBuilder = () => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.eq = (col: string, val: unknown) => {
        fromState.filters[col] = val;
        return b;
      };
      b.maybeSingle = async () => ({
        data: fromState.row,
        error: fromState.readError,
      });
      return b;
    };
    return {
      from: () => {
        clientUse.from.push(tag);
        return makeBuilder();
      },
      rpc: (...args: unknown[]) => {
        clientUse.rpc.push(tag);
        return (rpc as (...a: unknown[]) => unknown)(...args);
      },
    };
  };
  return {
    serviceClient: () => makeClient("service"),
    serverClientFromBearer: () => makeClient("bearer"),
  };
});

import { githubDisconnect } from "../github";

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (c: number) => ((res.statusCode = c), res as Response);
  res.json = (b: unknown) => {
    if (res.statusCode === undefined) res.statusCode = 200;
    res.body = b;
    return res as Response;
  };
  return res as Response & { statusCode?: number; body?: unknown };
}
const req = () =>
  ({ headers: { authorization: "Bearer jwt" } }) as unknown as Request;

beforeEach(() => {
  fromState.row = null;
  fromState.readError = null;
  fromState.filters = {};
  clientUse.from = [];
  clientUse.rpc = [];
  rpc.mockClear();
  rpc.mockImplementation(async () => ({ data: null, error: null }));
});

describe("githubDisconnect — Praxis-build sentinel guard", () => {
  it("REFUSES a Praxis-build sentinel row → 409, and NEVER calls the RPC", async () => {
    fromState.row = { account_login: "Praxis-build" };
    const res = mockRes();
    await githubDisconnect(req(), res);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "not_disconnectable",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("probes connector_metadata scoped to the caller's OWN tenant", async () => {
    fromState.row = { account_login: "Praxis-build" };
    await githubDisconnect(req(), mockRes());
    expect(fromState.filters.tenant_id).toBe("t1");
    expect(fromState.filters.slug).toBe("github");
  });

  it("probes through the USER-SCOPED client, never the service client (stays inside RLS)", async () => {
    fromState.row = { account_login: "Praxis-build" };
    await githubDisconnect(req(), mockRes());
    expect(clientUse.from).toEqual(["bearer"]);
    expect(clientUse.from).not.toContain("service");
  });

  it("calls the RPC through the USER-SCOPED client so _assert_tenant_admin sees auth.uid()", async () => {
    fromState.row = { account_login: "rravi149" };
    await githubDisconnect(req(), mockRes());
    expect(clientUse.rpc).toEqual(["bearer"]);
    expect(clientUse.rpc).not.toContain("service");
  });

  it("does NOT over-block a real GitHub App install → proceeds to the RPC", async () => {
    fromState.row = { account_login: "rravi149" };
    const res = mockRes();
    await githubDisconnect(req(), res);

    expect(rpc).toHaveBeenCalledWith("disconnect_github", { p_tenant_id: "t1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("allows disconnect when no row exists (idempotent no-op path)", async () => {
    fromState.row = null;
    const res = mockRes();
    await githubDisconnect(req(), res);
    expect(rpc).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("fails closed on a connector_metadata read error — does NOT fall through to the RPC", async () => {
    fromState.readError = { message: "boom" };
    const res = mockRes();
    await githubDisconnect(req(), res);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "connector_metadata_read_failed",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("githubDisconnect — RPC error mapping", () => {
  it("maps 42501 (admin gate) → 403 not_admin", async () => {
    rpc.mockImplementation(async () => ({
      data: null,
      error: { code: "42501", message: "permission denied" },
    }));
    const res = mockRes();
    await githubDisconnect(req(), res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_admin");
  });

  it("maps P0001 (the RPC's OWN sentinel raise) → the same 409 not_disconnectable", async () => {
    fromState.row = { account_login: "rravi149" };
    rpc.mockImplementation(async () => ({
      data: null,
      error: {
        code: "P0001",
        message: "github connection is build-managed and cannot be disconnected",
      },
    }));
    const res = mockRes();
    await githubDisconnect(req(), res);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "not_disconnectable",
    );
  });

  it("maps PGRST202 (unapplied migration) → rpc_missing, without leaking the raw PG message", async () => {
    rpc.mockImplementation(async () => ({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.disconnect_github(p_tenant_id) in the schema cache",
      },
    }));
    const res = mockRes();
    await githubDisconnect(req(), res);

    const body = res.body as { error: { code: string; message: string } };
    expect(res.statusCode).toBe(500);
    expect(body.error.code).toBe("rpc_missing");
    expect(body.error.message).not.toMatch(/schema cache/);
  });

  it("maps 42883 (undefined_function) → rpc_missing", async () => {
    rpc.mockImplementation(async () => ({
      data: null,
      error: { code: "42883", message: "function does not exist" },
    }));
    const res = mockRes();
    await githubDisconnect(req(), res);
    expect((res.body as { error: { code: string } }).error.code).toBe("rpc_missing");
  });

  it("falls back to rpc_failed for an unrecognized error code", async () => {
    rpc.mockImplementation(async () => ({
      data: null,
      error: { code: "XX000", message: "internal" },
    }));
    const res = mockRes();
    await githubDisconnect(req(), res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("rpc_failed");
  });
});
