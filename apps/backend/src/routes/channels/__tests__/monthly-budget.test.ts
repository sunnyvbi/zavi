
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authResult: { tenant_id: string; access_token: string; tenant_overridden?: boolean } | null = null;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: true, error: null };
let roleAllowed = true;

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (tid: string, fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args: { ...args, p_tenant_id: tid } });
    return Promise.resolve(rpcResult);
  },
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: Response) => {
    if (roleAllowed) return true;
    res.status(403).json({ error: { code: "forbidden", message: "nope" } });
    return false;
  }),
}));

import { putChannelMonthlyBudget } from "../monthly-budget";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
function res() {
  const r: { _status: number; _body: unknown; status: (n: number) => typeof r; json: (b: unknown) => typeof r } = {
    _status: 200,
    _body: undefined,
    status(n) { r._status = n; return r; },
    json(b) { r._body = b; return r; },
  };
  return r;
}
const req = (slug: string, body: unknown) => ({ params: { slug }, body }) as unknown as Request;

beforeEach(() => {
  authResult = { tenant_id: TENANT, access_token: "t" };
  rpcCalls.length = 0;
  rpcResult = { data: true, error: null };
  roleAllowed = true;
});

describe("PUT /api/channels/:slug/monthly-budget", () => {
  it("writes for the caller's tenant, ignoring any tenant in the body", async () => {
    const r = res();
    await putChannelMonthlyBudget(req("google_ads", { usd: 19600, tenant_id: "other", p_tenant_id: "other" }), r as never);
    expect(r._status).toBe(200);
    expect(rpcCalls).toEqual([{ fn: "set_channel_monthly_budget", args: { p_channel_slug: "google_ads", p_usd: 19600, p_tenant_id: TENANT } }]);
    expect(r._body).toEqual({ channel_slug: "google_ads", monthly_budget_usd: 19600 });
  });

  it("null clears the founder value", async () => {
    const r = res();
    await putChannelMonthlyBudget(req("google_ads", { usd: null }), r as never);
    expect(rpcCalls[0].args.p_usd).toBeNull();
  });

  it("refuses strings, negatives, other channels, non-admins and overridden tenants", async () => {
    for (const [slug, body] of [["google_ads", { usd: "500" }], ["google_ads", { usd: -1 }], ["google_ads", {}], ["meta_ads", { usd: 10 }]] as const) {
      const r = res();
      await putChannelMonthlyBudget(req(slug, body), r as never);
      expect(r._status).toBe(400);
    }
    roleAllowed = false;
    const r1 = res();
    await putChannelMonthlyBudget(req("google_ads", { usd: 10 }), r1 as never);
    expect(r1._status).toBe(403);
    roleAllowed = true;
    authResult = { tenant_id: TENANT, access_token: "t", tenant_overridden: true };
    const r2 = res();
    await putChannelMonthlyBudget(req("google_ads", { usd: 10 }), r2 as never);
    expect(r2._status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("an unconfirmed write is a failure, not a success", async () => {
    rpcResult = { data: false, error: null };
    const r = res();
    await putChannelMonthlyBudget(req("google_ads", { usd: 10 }), r as never);
    expect(r._status).toBe(500);
  });
});
