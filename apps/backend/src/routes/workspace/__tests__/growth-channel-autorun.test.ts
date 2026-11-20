
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authResult:
  | { tenant_id: string; user_id?: string; access_token: string; tenant_overridden?: boolean }
  | null = null;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: true,
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

let roleAllowed = true;
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, _allowed: unknown, res: Response) => {
    if (roleAllowed) return true;
    res.status(403).json({ error: { code: "forbidden", message: "nope" } });
    return false;
  }),
}));

let tierDecision: { allowed: boolean; required_tier: string } | Error = {
  allowed: true,
  required_tier: "starter",
};
const tierChecks: Array<{ tenant: string; slug: string }> = [];
vi.mock("@/services/agents/entitlement", () => ({
  checkAgentTier: async (tenant: string, slug: string) => {
    tierChecks.push({ tenant, slug });
    if (tierDecision instanceof Error) throw tierDecision;
    return tierDecision;
  },
  planUpgradeErrorBody: (slug: string, tier: string) => ({
    error: { code: "plan_upgrade_required", required_tier: tier, message: `${slug} needs ${tier}` },
  }),
}));

import { postGrowthChannelAutorun } from "../growth-channel-autorun";

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
  authResult = { tenant_id: "tenant-real", access_token: "tok" };
  rpcCalls.length = 0;
  rpcResult = { data: true, error: null };
  tierDecision = { allowed: true, required_tier: "starter" };
  tierChecks.length = 0;
});

describe("postGrowthChannelAutorun", () => {
  it("sends the SERVER-derived tenant_id, never one from the request", async () => {
    const res = mockRes();
    await postGrowthChannelAutorun(
      req("seo", { autorun: true, tenant_id: "tenant-attacker" }),
      res,
    );
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_tenant_id).toBe("tenant-real");
    expect(JSON.stringify(rpcCalls[0].args)).not.toContain("tenant-attacker");
  });

  it("refuses an unknown channel slug rather than writing a dead row", async () => {
    const res = mockRes();
    await postGrowthChannelAutorun(req("not_a_channel", { autorun: true }), res);
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a non-boolean autorun instead of coercing it", async () => {
    for (const bad of ["false", "true", 0, 1, null, undefined]) {
      const res = mockRes();
      await postGrowthChannelAutorun(req("seo", { autorun: bad }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("reports failure when the RPC could not confirm its own write", async () => {
    rpcResult = { data: false, error: null };
    const res = mockRes();
    await postGrowthChannelAutorun(req("seo", { autorun: true }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("write_unconfirmed");
  });

  it("passes the boolean through and reports who set it", async () => {
    const res = mockRes();
    await postGrowthChannelAutorun(req("seo", { autorun: false }), res);
    expect(rpcCalls[0].args.p_autorun).toBe(false);
    expect(rpcCalls[0].args.p_channel_slug).toBe("seo");
    expect(res.body).toEqual({
      channel_slug: "seo",
      autorun: false,
      set_by: "founder",
    });
  });

  it("refuses a member who is not owner or admin", async () => {
    roleAllowed = false;
    const res = mockRes();
    await postGrowthChannelAutorun(req("seo", { autorun: true }), res);
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses an overridden tenant, even though the override is membership-checked", async () => {
    authResult = {
      tenant_id: "tenant-real",
      access_token: "tok",
      tenant_overridden: true,
    } as typeof authResult;
    const res = mockRes();
    await postGrowthChannelAutorun(req("seo", { autorun: true }), res);
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("does not write at all when the caller is unauthenticated", async () => {
    authResult = null;
    const res = mockRes();
    await postGrowthChannelAutorun(req("seo", { autorun: true }), res);
    expect(res.statusCode).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("postGrowthChannelAutorun — three-tier pricing", () => {
  it("refuses turning ON a channel the tier does not include (403 upgrade body, no write)", async () => {
    tierDecision = { allowed: false, required_tier: "pro" };
    const res = mockRes();
    await postGrowthChannelAutorun(req("meta_ads", { autorun: true }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("plan_upgrade_required");
    expect(res.body.error.required_tier).toBe("pro");
    expect(rpcCalls).toHaveLength(0);
    expect(tierChecks).toEqual([{ tenant: "tenant-real", slug: "meta_ads" }]);
  });

  it("turning OFF is always allowed and does not check the tier", async () => {
    tierDecision = { allowed: false, required_tier: "pro" };
    const res = mockRes();
    await postGrowthChannelAutorun(req("meta_ads", { autorun: false }), res);
    expect(res.statusCode).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(tierChecks).toHaveLength(0);
  });

  it("fails closed when the tier cannot be read", async () => {
    tierDecision = new Error("db down");
    const res = mockRes();
    await postGrowthChannelAutorun(req("seo", { autorun: true }), res);
    expect(res.statusCode).toBe(503);
    expect(rpcCalls).toHaveLength(0);
  });
});

it("ChatGPT paid delegation rejects old unqualified autorun requests", async () => {
 const res = mockRes(); await postGrowthChannelAutorun(req("chatgpt_ads", { autorun: true }), res);
 expect(res.statusCode).toBe(400); expect(res.body.error.code).toBe("paid_consent_required"); expect(rpcCalls).toHaveLength(0);
});
it("ChatGPT paid delegation uses the authenticated actor and tenant", async () => {
 authResult = { tenant_id: "tenant-real", user_id: "owner", access_token: "tok" };
 const res = mockRes(); await postGrowthChannelAutorun(req("chatgpt_ads", { autorun: true, paid_consent: "chatgpt-growth-v1", tenant_id: "evil", user_id: "evil" }), res);
 expect(res.statusCode).toBe(200); expect(rpcCalls).toEqual([{ fn: "set_chatgpt_autopilot", args: { p_tenant_id: "tenant-real", p_actor_user_id: "owner", p_enabled: true } }]);
});
it("ChatGPT can always revoke delegation without repeating consent", async () => {
 authResult = { tenant_id: "tenant-real", user_id: "owner", access_token: "tok" };
 const res = mockRes(); await postGrowthChannelAutorun(req("chatgpt_ads", { autorun: false }), res);
 expect(res.statusCode).toBe(200); expect(rpcCalls[0]).toEqual({ fn: "revoke_chatgpt_autopilot", args: { p_tenant_id: "tenant-real", p_actor_user_id: "owner" } });
});

it("a member may revoke ChatGPT paid delegation but cannot enable it", async () => {
  roleAllowed = false;
  authResult = { tenant_id: "tenant-real", user_id: "member", access_token: "tok" };
  const off = mockRes(); await postGrowthChannelAutorun(req("chatgpt_ads", { autorun: false }), off);
  expect(off.statusCode).toBe(200);
  expect(rpcCalls[0].fn).toBe("revoke_chatgpt_autopilot");
  const on = mockRes(); await postGrowthChannelAutorun(req("chatgpt_ads", { autorun: true, paid_consent: "chatgpt-growth-v1" }), on);
  expect(on.statusCode).toBe(403); expect(rpcCalls).toHaveLength(1);
});
