import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mockRpc = vi.fn();
const mockRequireAuth = vi.fn();

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc: mockRpc }),
}));

import { setDefaultRepoHandler } from "../../routes/connectors/github-default-repo";

function makeReq(opts: { body?: unknown; auth?: string } = {}): Request {
  return {
    body: opts.body ?? {},
    headers: { authorization: opts.auth ?? "Bearer faketoken" },
  } as unknown as Request;
}

function makeRes() {
  const res: Partial<Response> & { _status?: number; _body?: unknown } = {};
  res.status = vi.fn((n: number) => {
    res._status = n;
    return res as Response;
  });
  res.json = vi.fn((b: unknown) => {
    res._body = b;
    return res as Response;
  });
  return res as Response & { _status?: number; _body?: unknown };
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRequireAuth.mockReset();
});

describe("setDefaultRepoHandler", () => {
  it("401s when requireAuth fails", async () => {
    mockRequireAuth.mockResolvedValueOnce(null);
    const res = makeRes();
    await setDefaultRepoHandler(makeReq({ body: { repo_full_name: "acme/web" } }), res);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400s on empty repo_full_name", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setDefaultRepoHandler(makeReq({ body: { repo_full_name: "" } }), res);
    expect(res._status).toBe(400);
  });

  it("calls set_github_default_repo RPC via user-scoped client", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = makeRes();
    await setDefaultRepoHandler(makeReq({ body: { repo_full_name: "acme/web" } }), res);
    expect(mockRpc).toHaveBeenCalledWith("set_github_default_repo", {
      p_tenant_id: "t1",
      p_repo_full_name: "acme/web",
    });
    expect(res._status).toBe(200);
  });

  it("403s on _assert_tenant_admin role refusal (Postgres 42501)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "forbidden — role member cannot perform admin action" },
    });
    const res = makeRes();
    await setDefaultRepoHandler(makeReq({ body: { repo_full_name: "acme/web" } }), res);
    expect(res._status).toBe(403);
  });

  it("422s on CHECK violation (repo not connected, Postgres 23514)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "23514", message: "repo_full_name not in connected repo_full_names" },
    });
    const res = makeRes();
    await setDefaultRepoHandler(makeReq({ body: { repo_full_name: "evil/repo" } }), res);
    expect(res._status).toBe(422);
    expect(res._body).toMatchObject({ error: { code: "repo_not_connected" } });
  });

  it("422s with repo_not_selected when repo SCOPING excludes the pick (also 23514)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23514",
        message:
          "set_github_default_repo: acme/web is not in the tenant's selected repositories",
      },
    });
    const res = makeRes();
    await setDefaultRepoHandler(makeReq({ body: { repo_full_name: "acme/web" } }), res);
    expect(res._status).toBe(422);
    expect(res._body).toMatchObject({ error: { code: "repo_not_selected" } });
  });
});
