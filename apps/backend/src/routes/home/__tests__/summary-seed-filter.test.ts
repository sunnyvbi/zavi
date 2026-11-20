
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  verifyBearer: vi.fn(),
  getTenantDisabledSlugs: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: mocks.requireAuth,
}));

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: mocks.verifyBearer,
}));

vi.mock("@/services/agents/visibility", () => ({
  getTenantDisabledSlugs: mocks.getTenantDisabledSlugs,
}));

vi.mock("../../../../workers/client", () => ({
  inngest: { send: vi.fn() },
}));

const neqCalls: Array<{ table: string; col: string; val: unknown }> = [];

function makeBuilder(table: string) {
  const result: { data: unknown[]; count: number; error: null } = {
    data: [],
    count: 0,
    error: null,
  };
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.gte = chain;
  builder.lte = chain;
  builder.in = chain;
  builder.is = chain;
  builder.order = chain;
  builder.limit = chain;
  builder.neq = (col: string, val: unknown) => {
    neqCalls.push({ table, col, val });
    return builder;
  };
  builder.maybeSingle = async () => ({
    data: table === "profiles" ? { active_tenant_id: "t-fresh" } : null,
    error: null,
  });
  builder.then = (resolve: (v: typeof result) => unknown) => resolve(result);
  return builder;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => makeBuilder(table),
  }),
  serviceClient: () => ({
    from: (table: string) => makeBuilder(table),
  }),
}));

import { homeSummary } from "../summary";

function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res as unknown as import("express").Response & {
    statusCode: number;
    body: { spend_total_usd: number; recent_activity: unknown[]; active_runs_today: unknown[] };
  };
}

describe("home/summary — seed-corpus exclusion (F2)", () => {
  beforeEach(() => {
    neqCalls.length = 0;
    mocks.verifyBearer.mockResolvedValue({ user_id: "u1", access_token: "tok" });
    mocks.requireAuth.mockResolvedValue({
      user_id: "u1",
      tenant_id: "t-fresh",
      access_token: "tok",
    });
    mocks.getTenantDisabledSlugs.mockResolvedValue(new Set<string>());
  });

  it("excludes seed rows: spend=0, empty feed, empty active-today", async () => {
    const req = { body: {}, headers: { authorization: "Bearer tok" } } as unknown as import("express").Request;
    const res = mockRes();

    await homeSummary(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.spend_total_usd).toBe(0);
    expect(body.recent_activity).toEqual([]);
    expect(body.active_runs_today).toEqual([]);

    const agentRunSeedGuards = neqCalls.filter(
      (c) => c.table === "agent_runs" && c.col === "agent_definition_hash" && c.val === "seed-synthetic",
    );
    expect(agentRunSeedGuards.length).toBe(3);
  });
});
