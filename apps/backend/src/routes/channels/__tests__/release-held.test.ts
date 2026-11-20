
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "11111111-1111-4111-8111-111111111111";
let authResult: { tenant_id: string; user_id: string; tenant_overridden?: boolean } | null = null;
const rpcCalls: Array<{ tid: string; fn: string; args: Record<string, unknown> }> = [];

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated" } });
    return null;
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({}),
  tenantRpc: (tid: string, fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ tid, fn, args });
    return Promise.resolve({ data: 3, error: null });
  },
}));

import { channelActionsReleaseHeld } from "../release-held";

function call(params: Record<string, string>, body: unknown = {}) {
  const res = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown; status: (c: number) => unknown; json: (b: unknown) => unknown };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return channelActionsReleaseHeld({ params, body } as unknown as Request, res as unknown as Response).then(() => res);
}

beforeEach(() => {
  authResult = { tenant_id: T, user_id: "u1" };
  rpcCalls.length = 0;
});

describe("POST /api/channels/:slug/actions/release-held", () => {
  it("releases this channel's held cards for the signed-in workspace, whatever the body says", async () => {
    const res = await call({ slug: "reddit_organic" }, { tenant_id: "22222222-2222-4222-8222-222222222222", p_tenant_id: "x" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, released: 3 });
    expect(rpcCalls).toEqual([{ tid: T, fn: "release_paced_channel_actions", args: { p_channels: ["reddit_organic"], p_ids: null } }]);
  });

  it("refuses without a session, for an overridden tenant, and for an unknown channel", async () => {
    authResult = null;
    expect((await call({ slug: "reddit_organic" })).statusCode).toBe(401);
    authResult = { tenant_id: T, user_id: "u1", tenant_overridden: true };
    expect((await call({ slug: "reddit_organic" })).statusCode).toBe(403);
    authResult = { tenant_id: T, user_id: "u1" };
    expect((await call({ slug: "not_a_channel" })).statusCode).toBe(404);
    expect(rpcCalls).toEqual([]);
  });
});
