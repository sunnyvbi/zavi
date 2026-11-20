import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const { authState, flagState, fromState } = vi.hoisted(() => ({
  authState: { user_id: "user-A", tenant_id: "t1", access_token: "jwt" } as
    | { user_id: string; tenant_id: string; access_token: string }
    | null,
  flagState: { on: true },
  fromState: { rows: [] as unknown[], filters: {} as Record<string, unknown> },
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!authState) {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    }
    return authState;
  }),
}));
vi.mock("@/agents/social/social-publish-flag", () => ({
  isSocialPublishEnabled: vi.fn(async () => flagState.on),
}));
vi.mock("@/services/supabase", () => {
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.order = self;
    b.eq = (col: string, val: unknown) => {
      fromState.filters[col] = val;
      return b;
    };
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: fromState.rows, error: null });
    return b;
  };
  return { serviceClient: () => ({ from: () => makeBuilder() }) };
});

import { socialList } from "../social";

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

beforeEach(() => {
  flagState.on = true;
  fromState.rows = [];
  fromState.filters = {};
});

describe("socialList — owner-scoped (Gap3/D1-P3)", () => {
  it("returns the caller's OWN connections, filtered by tenant AND owner", async () => {
    fromState.rows = [
      { platform: "linkedin", handle: "acme", status: "connected" },
    ];
    const res = mockRes();
    await socialList({} as Request, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { connections: unknown[] }).connections).toHaveLength(1);
    expect(fromState.filters.tenant_id).toBe("t1");
    expect(fromState.filters.owner_user_id).toBe("user-A");
  });

  it("empty when the caller owns no connections (never another member's)", async () => {
    fromState.rows = [];
    const res = mockRes();
    await socialList({} as Request, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { connections: unknown[] }).connections).toEqual([]);
    expect(fromState.filters.owner_user_id).toBe("user-A");
  });

  it("503 when the social-publish flag is OFF (surface inert, no query)", async () => {
    flagState.on = false;
    const res = mockRes();
    await socialList({} as Request, res);
    expect(res.statusCode).toBe(503);
    expect(fromState.filters).toEqual({});
  });
});
