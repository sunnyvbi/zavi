import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mockRpc = vi.fn();
const mockRequireAuth = vi.fn();
const mockFrom = vi.fn();
const mockAssertMembership = vi.fn();
const mockResolveInstall = vi.fn();
const mockListBranches = vi.fn();

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...a: unknown[]) => mockRequireAuth(...a),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc: mockRpc, from: mockFrom }),
}));
vi.mock("@/services/mcp/internal/github", () => ({
  assertReadRepoMembership: (...a: unknown[]) => mockAssertMembership(...a),
  resolveInstallationId: (...a: unknown[]) => mockResolveInstall(...a),
  listBranchesImpl: (...a: unknown[]) => mockListBranches(...a),
}));

import {
  listRepoBranchesHandler,
  setRepoBranchHandler,
} from "../../routes/connectors/github-repo-branch";

function makeReq(opts: { body?: unknown; query?: unknown } = {}): Request {
  return {
    body: opts.body ?? {},
    query: opts.query ?? {},
    headers: { authorization: "Bearer tok" },
  } as unknown as Request;
}
function makeRes() {
  const res: Partial<Response> & { _status?: number; _body?: unknown } = {};
  res.status = vi.fn((n: number) => ((res._status = n), res as Response));
  res.json = vi.fn((b: unknown) => ((res._body = b), res as Response));
  return res as Response & { _status?: number; _body?: unknown };
}
function mockCurrentBranch(map: Record<string, string> | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: { repo_default_branches: map }, error: null }),
  };
  mockFrom.mockReturnValue(chain);
}

beforeEach(() => {
  [mockRpc, mockRequireAuth, mockFrom, mockAssertMembership, mockResolveInstall, mockListBranches].forEach(
    (m) => m.mockReset(),
  );
});

describe("GET listRepoBranchesHandler", () => {
  it("401s when auth fails, never touches GitHub", async () => {
    mockRequireAuth.mockResolvedValueOnce(null);
    const res = makeRes();
    await listRepoBranchesHandler(makeReq({ query: { repo_full_name: "a/b" } }), res);
    expect(mockAssertMembership).not.toHaveBeenCalled();
  });

  it("400s on a malformed repo_full_name (not owner/repo)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await listRepoBranchesHandler(makeReq({ query: { repo_full_name: "justrepo" } }), res);
    expect(res._status).toBe(400);
    expect(mockAssertMembership).not.toHaveBeenCalled();
  });

  it("checks membership BEFORE listing, then returns branch names", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockAssertMembership.mockResolvedValueOnce(undefined);
    mockResolveInstall.mockResolvedValueOnce(42);
    mockListBranches.mockResolvedValueOnce({
      branches: [{ name: "main" }, { name: "development" }],
    });
    mockCurrentBranch({ "acme/web": "development" });
    const res = makeRes();
    await listRepoBranchesHandler(makeReq({ query: { repo_full_name: "acme/web" } }), res);
    expect(mockAssertMembership).toHaveBeenCalledWith("t1", "acme", "web");
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ branches: ["main", "development"], current: "development" });
  });

  it("guarantees the currently-set branch is present even if past page 1 (Codex P2)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockAssertMembership.mockResolvedValueOnce(undefined);
    mockResolveInstall.mockResolvedValueOnce(1);
    mockListBranches.mockResolvedValueOnce({ branches: [{ name: "main" }] });
    mockCurrentBranch({ "acme/web": "staging" });
    const res = makeRes();
    await listRepoBranchesHandler(makeReq({ query: { repo_full_name: "acme/web" } }), res);
    const body = res._body as { branches: string[] };
    expect(body.branches).toContain("staging");
  });

  it("reads every page of branches (100 per page) until a short page", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockAssertMembership.mockResolvedValueOnce(undefined);
    mockResolveInstall.mockResolvedValueOnce(1);
    const page = (from: number, n: number) => ({
      branches: Array.from({ length: n }, (_, i) => ({ name: `b-${from + i}` })),
    });
    mockListBranches
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 100))
      .mockResolvedValueOnce(page(200, 40));
    mockCurrentBranch({});
    const res = makeRes();
    await listRepoBranchesHandler(makeReq({ query: { repo_full_name: "acme/web" } }), res);
    const body = res._body as { branches: string[] };
    expect(body.branches).toHaveLength(240);
    expect(body.branches).toContain("b-239");
    expect(mockListBranches).toHaveBeenCalledTimes(3);
    expect(mockListBranches.mock.calls.map((c) => c[3])).toEqual([1, 2, 3]);
  });

  it("404s when membership assertion throws (scoped-out repo), never lists", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockAssertMembership.mockRejectedValueOnce(new Error("not_found"));
    const res = makeRes();
    await listRepoBranchesHandler(makeReq({ query: { repo_full_name: "acme/web" } }), res);
    expect(res._status).toBe(404);
    expect(mockListBranches).not.toHaveBeenCalled();
  });
});

describe("POST setRepoBranchHandler", () => {
  it("400s on missing branch", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setRepoBranchHandler(makeReq({ body: { repo_full_name: "a/b" } }), res);
    expect(res._status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls set_github_repo_base_branch via user-scoped client", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = makeRes();
    await setRepoBranchHandler(makeReq({ body: { repo_full_name: "acme/web", branch: "development" } }), res);
    expect(mockRpc).toHaveBeenCalledWith("set_github_repo_base_branch", {
      p_tenant_id: "t1",
      p_repo_full_name: "acme/web",
      p_branch: "development",
    });
    expect(res._status).toBe(200);
  });

  it("maps 42501 → 403 (non-admin)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "not admin" } });
    const res = makeRes();
    await setRepoBranchHandler(makeReq({ body: { repo_full_name: "acme/web", branch: "dev" } }), res);
    expect(res._status).toBe(403);
  });

  it("maps 23514 → 422 (repo not connected) and 22023 → 400 (unsafe branch)", async () => {
    mockRequireAuth.mockResolvedValue({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "23514", message: "x" } });
    let res = makeRes();
    await setRepoBranchHandler(makeReq({ body: { repo_full_name: "acme/web", branch: "dev" } }), res);
    expect(res._status).toBe(422);
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "x" } });
    res = makeRes();
    await setRepoBranchHandler(makeReq({ body: { repo_full_name: "acme/web", branch: "-bad" } }), res);
    expect(res._status).toBe(400);
  });
});
