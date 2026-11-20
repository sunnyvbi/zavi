
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  requireAuth: vi.fn(),
  send: vi.fn(),
  writes: [] as Array<{ table: string; op: string }>,
  profile: null as null | { active_tenant_id: string | null },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: mocks.verifyBearer }));
vi.mock("@/services/agents/visibility", () => ({ getTenantDisabledSlugs: vi.fn() }));
vi.mock("../../../../workers/client", () => ({ inngest: { send: mocks.send } }));

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte"]) b[m] = chain;
  for (const op of ["insert", "upsert", "update", "delete"]) {
    b[op] = () => {
      mocks.writes.push({ table, op });
      return b;
    };
  }
  b.maybeSingle = async () => ({ data: table === "profiles" ? mocks.profile : null, error: null });
  b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return b;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: (t: string) => builder(t) }),
  serviceClient: () => ({ from: (t: string) => builder(t) }),
}));

import { homeSummary } from "../summary";

function res() {
  const r: { statusCode: number; body: unknown; status: (c: number) => typeof r; json: (b: unknown) => typeof r } = {
    statusCode: 200,
    body: undefined,
    status(c) {
      r.statusCode = c;
      return r;
    },
    json(b) {
      r.body = b;
      return r;
    },
  };
  return r;
}

describe("GET /api/home/summary for a user with no active tenant", () => {
  beforeEach(() => {
    mocks.writes.length = 0;
    mocks.send.mockReset();
    mocks.requireAuth.mockReset();
    mocks.verifyBearer.mockResolvedValue({ user_id: "u-1", access_token: "tok" });
  });

  it.each([
    ["profile row with no active tenant", { active_tenant_id: null }],
    ["no profile row at all", null],
  ])("%s -> 409 no_active_tenant, nothing written or sent", async (_label, profile) => {
    mocks.profile = profile;
    const r = res();
    await homeSummary({ headers: { authorization: "Bearer tok" } } as never, r as never);
    expect(r.statusCode).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("no_active_tenant");
    expect(mocks.writes).toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });
});
