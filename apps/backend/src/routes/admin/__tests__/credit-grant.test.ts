import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const state = vi.hoisted(() => ({
  tenants: new Set<string>(),
  memberships: new Map<string, string[]>(),
  failTable: null as string | null,
  calls: [] as string[],
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => ({ user_id: "staff-1", email: "ravi@upcar.ai" }),
}));

vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, val: string) => {
          state.calls.push(table);
          const fail = state.failTable === table ? { message: "boom" } : null;
          if (table === "tenant_users") {
            const rows = fail ? null : (state.memberships.get(val) ?? []).map((tenant_id) => ({ tenant_id }));
            return Promise.resolve({ data: rows, error: fail });
          }
          return {
            maybeSingle: async () => {
              if (fail) return { data: null, error: fail };
              return { data: state.tenants.has(val) ? { id: val } : null, error: null };
            },
          };
        },
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push(`rpc:${fn}`);
      state.rpcCalls.push({ fn, args });
      return { data: true, error: null };
    },
  }),
}));

import { staffCreditGrant } from "../credit-grant";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const USER = "13e52d59-ae72-476f-a486-11da040f40c2";
const MULTI_USER = "0335f3eb-8f08-4f72-91e1-6cd085503f13";
const USERS_TENANT = "04caef7a-ac9d-4ec1-8050-8254e4c6262f";
const OTHER_TENANT = "e0fe9ea8-0000-4000-8000-000000000001";

async function call(tenant_id: string) {
  const out = { code: 200, body: null as unknown };
  const res = {
    status(c: number) { out.code = c; return this; },
    json(b: unknown) { out.body = b; return this; },
  } as unknown as Response;
  await staffCreditGrant({ body: { tenant_id, amount: 5000, reason: "QA comp", grant_key: "key-12345678" } } as Request, res);
  return out;
}

const errOf = (out: { body: unknown }) => (out.body as { error: { code: string; message: string } }).error;

beforeEach(() => {
  state.tenants = new Set([TENANT]);
  state.memberships = new Map([
    [USER, [USERS_TENANT]],
    [MULTI_USER, [USERS_TENANT, OTHER_TENANT]],
  ]);
  state.failTable = null;
  state.calls = [];
  state.rpcCalls = [];
});

describe("POST /api/admin/credit-grant tenant check", () => {
  it("grants to an existing tenant: lookup first, then the unchanged RPC call", async () => {
    const out = await call(TENANT);
    expect(out.code).toBe(200);
    expect(out.body).toEqual({ granted: true, idempotent_replay: false });
    expect(state.calls).toEqual(["tenants", "rpc:grant_promo_credits"]);
    expect(state.rpcCalls).toEqual([
      {
        fn: "grant_promo_credits",
        args: {
          p_tenant_id: TENANT,
          p_credits: 5000,
          p_reason: "QA comp",
          p_grant_key: "key-12345678",
          p_actor_email: "ravi@upcar.ai",
        },
      },
    ]);
  });

  it("refuses a user id and names that user's only tenant, without granting", async () => {
    const out = await call(USER);
    expect(out.code).toBe(404);
    expect(errOf(out).code).toBe("tenant_not_found");
    expect(errOf(out).message).toContain(USERS_TENANT);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("lists every tenant of a multi-tenant user instead of picking one", async () => {
    const out = await call(MULTI_USER);
    expect(out.code).toBe(404);
    expect(errOf(out).message).toContain(USERS_TENANT);
    expect(errOf(out).message).toContain(OTHER_TENANT);
    expect(errOf(out).message).not.toContain("That user's tenant is");
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("refuses an unknown id without granting", async () => {
    const out = await call("00000000-0000-4000-8000-000000000000");
    expect(out.code).toBe(404);
    expect(errOf(out).code).toBe("tenant_not_found");
    expect(errOf(out).message).toBe("No tenant with id 00000000-0000-4000-8000-000000000000.");
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("fails closed with 503 when the tenants lookup errors", async () => {
    state.failTable = "tenants";
    const out = await call(TENANT);
    expect(out.code).toBe(503);
    expect(errOf(out).code).toBe("tenant_lookup_failed");
    expect(state.calls).toEqual(["tenants"]);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("fails closed with 503 when the membership lookup errors", async () => {
    state.failTable = "tenant_users";
    const out = await call(USER);
    expect(out.code).toBe(503);
    expect(errOf(out).code).toBe("tenant_lookup_failed");
    expect(state.rpcCalls).toHaveLength(0);
  });
});
