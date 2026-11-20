import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mockRpc = vi.fn();
const mockRequireAuth = vi.fn();
const mockInngestSend = vi.fn();

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc: mockRpc }),
}));

vi.mock("@/../workers/client", () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

import {
  setSelectedReposHandler,
  clearSelectedReposHandler,
} from "../../routes/connectors/github-selected-repos";

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
  mockInngestSend.mockReset();
  mockInngestSend.mockResolvedValue(undefined);
});

describe("setSelectedReposHandler — profile rebuild enqueue", () => {
  it("401s when requireAuth fails; no RPC, no enqueue", async () => {
    mockRequireAuth.mockResolvedValueOnce(null);
    const res = makeRes();
    await setSelectedReposHandler(makeReq({ body: { repo_ids: [1] } }), res);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("400s on non-array repo_ids; no enqueue", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setSelectedReposHandler(makeReq({ body: { repo_ids: "nope" } }), res);
    expect(res._status).toBe(400);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("on a successful write → enqueues repo.profile.build.requested with the tenant payload", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = makeRes();
    await setSelectedReposHandler(makeReq({ body: { repo_ids: [101, 103] } }), res);

    expect(mockRpc).toHaveBeenCalledWith("set_github_selected_repos", {
      p_tenant_id: "t1",
      p_repo_ids: [101, 103],
    });
    expect(res._status).toBe(200);
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "repo.profile.build.requested",
      data: { tenant_id: "t1" },
    });
  });

  it("does NOT enqueue when the selection write FAILS (e.g. 42501 not_admin)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });
    const res = makeRes();
    await setSelectedReposHandler(makeReq({ body: { repo_ids: [101] } }), res);
    expect(res._status).toBe(403);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("enqueue FAILURE does NOT fail the selection write (best-effort, still 200)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    mockInngestSend.mockRejectedValueOnce(new Error("inngest down"));
    const res = makeRes();
    await setSelectedReposHandler(makeReq({ body: { repo_ids: [101] } }), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true, selected_repo_ids: [101] });
  });
});

describe("clearSelectedReposHandler — profile rebuild enqueue", () => {
  it("401s when requireAuth fails; no RPC, no enqueue", async () => {
    mockRequireAuth.mockResolvedValueOnce(null);
    const res = makeRes();
    await clearSelectedReposHandler(makeReq(), res);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("on a successful clear → enqueues repo.profile.build.requested", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = makeRes();
    await clearSelectedReposHandler(makeReq(), res);
    expect(mockRpc).toHaveBeenCalledWith("clear_github_selected_repos", {
      p_tenant_id: "t1",
    });
    expect(res._status).toBe(200);
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "repo.profile.build.requested",
      data: { tenant_id: "t1" },
    });
  });

  it("does NOT enqueue when the clear write FAILS", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });
    const res = makeRes();
    await clearSelectedReposHandler(makeReq(), res);
    expect(res._status).toBe(403);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});
