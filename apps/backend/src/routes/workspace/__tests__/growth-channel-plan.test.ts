
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authResult:
  | { tenant_id: string; user_id?: string; access_token: string; tenant_overridden?: boolean }
  | null = null;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: "ok",
  error: null,
};

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

const cleared: Array<{ tenant: string; slug?: string }> = [];
vi.mock("@/services/growth/goal-owner", () => ({
  clearCgoPauseReasons: async (tenant: string, slug?: string) => {
    cleared.push({ tenant, slug });
  },
}));

let roleAllowed = true;
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, _allowed: unknown, res: Response) => {
    if (roleAllowed) return true;
    res.status(403).json({ error: { code: "forbidden", message: "nope" } });
    return false;
  }),
}));

import { postGrowthChannelPlan } from "../growth-channel-plan";

function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.body = null;
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res as unknown as Response & { statusCode: number; body: any };
}

const req = (slug: string, body: unknown): Request =>
  ({ params: { slug }, body }) as unknown as Request;

beforeEach(() => {
  roleAllowed = true;
  authResult = { tenant_id: "tenant-real", user_id: "user-1", access_token: "tok" };
  rpcCalls.length = 0;
  rpcResult = { data: "ok", error: null };
});

describe("postGrowthChannelPlan", () => {
  it("sends the SERVER-derived tenant_id, never one from the request", async () => {
    const res = mockRes();
    await postGrowthChannelPlan(
      req("seo", { in_plan: true, tenant_id: "tenant-attacker" }),
      res,
    );
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("set_channel_in_plan");
    expect(rpcCalls[0].args.p_tenant_id).toBe("tenant-real");
    expect(JSON.stringify(rpcCalls[0].args)).not.toContain("tenant-attacker");
  });

  it("passes the slug and boolean through and reports who set it", async () => {
    const res = mockRes();
    await postGrowthChannelPlan(req("google_ads", { in_plan: true }), res);
    expect(rpcCalls[0].args).toMatchObject({ p_channel_slug: "google_ads", p_in_plan: true });
    expect(res.body).toEqual({ channel_slug: "google_ads", in_plan: true, set_by: "founder" });
  });

  it("never sends autorun: adding a channel is not permission to run it", async () => {
    const res = mockRes();
    await postGrowthChannelPlan(req("meta_ads", { in_plan: true, autorun: true }), res);
    expect(rpcCalls[0].args).not.toHaveProperty("p_autorun");
  });

  it("refuses an unknown channel slug rather than writing a dead row", async () => {
    const res = mockRes();
    await postGrowthChannelPlan(req("not_a_channel", { in_plan: true }), res);
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses adding a retired channel but still lets the founder remove it", async () => {
    const add = mockRes();
    await postGrowthChannelPlan(req("blog", { in_plan: true }), add);
    expect(add.statusCode).toBe(400);
    expect(add.body.error.code).toBe("channel_retired");
    expect(rpcCalls).toHaveLength(0);

    const remove = mockRes();
    await postGrowthChannelPlan(req("blog", { in_plan: false }), remove);
    expect(rpcCalls[0].args).toMatchObject({ p_channel_slug: "blog", p_in_plan: false });
  });

  it("refuses a non-boolean in_plan instead of coercing it", async () => {
    for (const bad of ["false", "true", 0, 1, null, undefined]) {
      const res = mockRes();
      await postGrowthChannelPlan(req("seo", { in_plan: bad }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("stops a channel Zavi picked instead of refusing, naming the founder", async () => {
    rpcResult = { data: "stopped", error: null };
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: false }), res);
    expect(res.statusCode).toBe(200);
    expect(rpcCalls[0].args).toMatchObject({ p_channel_slug: "seo", p_in_plan: false, p_actor_user_id: "user-1" });
    expect(res.body).toEqual({ channel_slug: "seo", in_plan: false, set_by: "founder_stopped" });
  });

  it("reports who owns a channel restored from a stop", async () => {
    for (const [data, set_by] of [["restored_plan", "plan"], ["restored_founder", "founder"]] as const) {
      rpcResult = { data, error: null };
      const res = mockRes();
      await postGrowthChannelPlan(req("seo", { in_plan: true }), res);
      expect(res.body).toEqual({ channel_slug: "seo", in_plan: true, set_by });
    }
  });

  it("treats the retired not_founder answer as a write that did not land", async () => {
    rpcResult = { data: "not_founder", error: null };
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: false }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("write_unconfirmed");
  });

  it("does not claim a Zavi pick as the founder's add", async () => {
    rpcResult = { data: "already_in_plan", error: null };
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: true }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ channel_slug: "seo", in_plan: true, set_by: "plan" });
  });

  it("reports failure when the RPC could not confirm its own write", async () => {
    for (const data of ["failed", null, true, undefined]) {
      rpcResult = { data, error: null };
      const res = mockRes();
      await postGrowthChannelPlan(req("seo", { in_plan: true }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error.code).toBe("write_unconfirmed");
    }
  });

  it("surfaces an RPC error as a failed write", async () => {
    rpcResult = { data: null, error: { message: "function set_channel_in_plan does not exist" } };
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: true }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("write_failed");
  });

  it("a founder add or remove clears Autopilot's pause reason for that channel", async () => {
    cleared.length = 0;
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: false }), res);
    expect(res.statusCode).toBe(200);
    expect(cleared).toEqual([{ tenant: "tenant-real", slug: "seo" }]);
  });

  it("refuses a member who is not owner or admin", async () => {
    roleAllowed = false;
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: true }), res);
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses an overridden tenant", async () => {
    authResult = {
      tenant_id: "tenant-real",
      access_token: "tok",
      tenant_overridden: true,
    } as typeof authResult;
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: true }), res);
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("does not write at all when the caller is unauthenticated", async () => {
    authResult = null;
    const res = mockRes();
    await postGrowthChannelPlan(req("seo", { in_plan: true }), res);
    expect(res.statusCode).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });
});
