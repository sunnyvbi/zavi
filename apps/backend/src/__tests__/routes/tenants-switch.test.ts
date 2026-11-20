
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const callerId = "33333333-3333-4333-8333-333333333333";

const state = {
  auth: {
    user_id: callerId,
    tenant_id: tenantA,
    access_token: "fake-jwt",
  } as { user_id: string; tenant_id: string; access_token: string } | null,
  memberOf: [] as string[],
  membershipChecks: [] as Array<{ user_id: string; tenant_id: string }>,
  mineRows: [] as Array<{
    tenant_id: string;
    role: string;
    tenants: { id: string; slug: string; display_name: string; product_url?: unknown };
  }>,
  syncCalls: [] as Array<{ user_id: string; tenant_id: string }>,
};

function resetState() {
  state.auth = { user_id: callerId, tenant_id: tenantA, access_token: "fake-jwt" };
  state.memberOf = [tenantA];
  state.membershipChecks = [];
  state.mineRows = [
    {
      tenant_id: tenantA,
      role: "owner",
      tenants: { id: tenantA, slug: "upcar-ai", display_name: "UpcarAI" },
    },
  ];
  state.syncCalls = [];
}

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async (_req: Request) => {
    if (!state.auth) return null;
    return {
      user_id: state.auth.user_id,
      access_token: state.auth.access_token,
    };
  }),
}));

function bearerClientStub(): unknown {
  return {
    from(_table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        async maybeSingle() {
          const uid = filters.user_id as string;
          const tid = filters.tenant_id as string;
          state.membershipChecks.push({ user_id: uid, tenant_id: tid });
          if (uid === state.auth?.user_id && state.memberOf.includes(tid)) {
            return { data: { tenant_id: tid }, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (v: { data: unknown; error: null }) => void) {
          const uid = filters.user_id as string;
          const rows =
            uid === state.auth?.user_id ? state.mineRows : [];
          resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => bearerClientStub(),
  serviceClient: () => ({}),
}));

vi.mock("@/services/tenants/active-tenant", () => ({
  syncActiveTenant: vi.fn(async (user_id: string, tenant_id: string) => {
    state.syncCalls.push({ user_id, tenant_id });
  }),
  syncActiveTenantStrict: vi.fn(async (user_id: string, tenant_id: string) => {
    state.syncCalls.push({ user_id, tenant_id });
  }),
}));

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res as Response;
  };
  res.send = (body?: unknown) => {
    res.body = body;
    return res as Response;
  };
  return res as Response & { statusCode?: number; body?: unknown };
}

import { tenantsRouter } from "@/routes/tenants";

const router = tenantsRouter();

function dispatch(
  method: string,
  path: string,
  body: unknown = {},
): Promise<Response & { statusCode?: number; body?: unknown }> {
  return new Promise((resolve) => {
    const res = mockRes();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    const origJson = res.json.bind(res);
    res.json = (b: unknown) => {
      const r = origJson(b);
      settle();
      return r;
    };
    const origSend = res.send.bind(res);
    res.send = (b?: unknown) => {
      const r = origSend(b);
      settle();
      return r;
    };
    const req = {
      method: method.toUpperCase(),
      url: path,
      body,
      headers: {},
      query: {},
    } as unknown as Request;
    (router as unknown as (req: Request, res: Response, next: () => void) => void)(
      req,
      res,
      () => {
        if (!res.statusCode) res.status(404);
        settle();
      },
    );
  });
}

beforeEach(() => {
  resetState();
});

describe("POST /v1/tenants/switch — membership gate (cross-tenant matrix)", () => {
  it("non-member switch → 403 not_a_member, no active_tenant_id write", async () => {
    state.memberOf = [tenantA];
    const res = await dispatch("POST", "/switch", { tenant_id: tenantB });

    expect(res.statusCode).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "not_a_member",
    );
    expect(state.membershipChecks).toContainEqual({
      user_id: callerId,
      tenant_id: tenantB,
    });
    expect(state.syncCalls.length).toBe(0);
  });

  it("member switch → 200 + syncActiveTenant(serverUid, target)", async () => {
    state.memberOf = [tenantA, tenantB];
    const res = await dispatch("POST", "/switch", { tenant_id: tenantB });

    expect(res.statusCode).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    expect(state.syncCalls).toEqual([{ user_id: callerId, tenant_id: tenantB }]);
  });

  it("recovery path: a user with NO valid active tenant (null/revoked) can still switch INTO a tenant they belong to → 200", async () => {
    state.memberOf = [tenantB];
    const res = await dispatch("POST", "/switch", { tenant_id: tenantB });

    expect(res.statusCode).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    expect(state.syncCalls).toEqual([{ user_id: callerId, tenant_id: tenantB }]);
  });

  it("uid is re-derived server-side — a spoofed body user_id is ignored", async () => {
    state.memberOf = [tenantA, tenantB];
    const res = await dispatch("POST", "/switch", {
      tenant_id: tenantB,
      user_id: "99999999-9999-9999-9999-999999999999",
    });

    expect(res.statusCode).toBe(200);
    expect(state.membershipChecks).toContainEqual({
      user_id: callerId,
      tenant_id: tenantB,
    });
    expect(state.syncCalls).toEqual([{ user_id: callerId, tenant_id: tenantB }]);
  });

  it("non-uuid tenant_id → 400, no membership read, no write", async () => {
    const res = await dispatch("POST", "/switch", { tenant_id: "not-a-uuid" });

    expect(res.statusCode).toBe(400);
    expect(state.membershipChecks.length).toBe(0);
    expect(state.syncCalls.length).toBe(0);
  });
});

describe("GET /v1/tenants/mine — RLS-scoped membership list", () => {
  it("returns the caller's tenants projected to {tenant_id, slug, display_name, role, website}", async () => {
    state.mineRows = [
      {
        tenant_id: tenantA,
        role: "owner",
        tenants: {
          id: tenantA,
          slug: "upcar-ai",
          display_name: "UpcarAI",
          product_url: { marketing: "https://upcar.ai", api: "https://api.upcar.ai" },
        },
      },
      {
        tenant_id: tenantB,
        role: "member",
        tenants: { id: tenantB, slug: "apna-tutor", display_name: "Apna Tutor", product_url: null },
      },
    ];
    const res = await dispatch("GET", "/mine");

    expect(res.statusCode === undefined || res.statusCode === 200).toBe(true);
    const tenants = (res.body as { tenants?: Array<Record<string, unknown>> })
      .tenants;
    expect(tenants).toBeDefined();
    expect(tenants!.length).toBe(2);
    expect(tenants![0]).toEqual({
      tenant_id: tenantA,
      slug: "upcar-ai",
      display_name: "UpcarAI",
      role: "owner",
      website: "https://upcar.ai",
    });
    expect(tenants![1]).toEqual({
      tenant_id: tenantB,
      slug: "apna-tutor",
      display_name: "Apna Tutor",
      role: "member",
      website: null,
    });
    for (const t of tenants!) {
      expect([tenantA, tenantB]).toContain(t.tenant_id);
    }
  });
});
