import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const { authState, fromState, rpc } = vi.hoisted(() => ({
  authState: { user_id: "user-A", tenant_id: "t1", access_token: "jwt" } as
    | { user_id: string; tenant_id: string; access_token: string }
    | null,
  fromState: { ownedRow: null as unknown, filters: {} as Record<string, unknown> },
  rpc: vi.fn(async () => ({ data: null, error: null })),
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
  isSocialPublishEnabled: vi.fn(async () => true),
}));
vi.mock("@/services/supabase", () => {
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = (col: string, val: unknown) => {
      fromState.filters[col] = val;
      return b;
    };
    b.maybeSingle = async () => ({ data: fromState.ownedRow, error: null });
    return b;
  };
  return { serviceClient: () => ({ from: () => makeBuilder(), rpc }) };
});

import { socialDisconnect } from "../social";

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
const req = (body: unknown) => ({ body }) as Request;

beforeEach(() => {
  fromState.ownedRow = null;
  fromState.filters = {};
  rpc.mockClear();
});

describe("socialDisconnect — owner-scoped (Gap3/D1-P2)", () => {
  it("owner disconnects their OWN connection → clears it", async () => {
    fromState.ownedRow = { id: "row-1" };
    const res = mockRes();
    await socialDisconnect(req({ platform: "linkedin", handle: "h" }), res);
    expect(fromState.filters.owner_user_id).toBe("user-A");
    expect(rpc).toHaveBeenCalledWith("clear_social_connection", {
      p_tenant_id: "t1",
      p_platform: "linkedin",
      p_handle: "h",
    });
    expect(res.statusCode).toBe(200);
  });

  it("member disconnecting ANOTHER member's connection → 404, NEVER clears", async () => {
    fromState.ownedRow = null;
    const res = mockRes();
    await socialDisconnect(req({ platform: "linkedin", handle: "h" }), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "connection_not_found",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
