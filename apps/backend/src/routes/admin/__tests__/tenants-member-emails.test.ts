
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: "u-staff", email: "staff@example.com" })),
}));

const { cfg, client } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null };
  const c = {
    tables: {} as Record<string, Result>,
    listUsers: (async () => ({ data: { users: [] }, error: null })) as () => Promise<unknown>,
  };
  const cl = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "is", "order", "limit", "range"]) b[op] = () => b;
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(c.tables[table] ?? { data: null, error: null }).then(onF, onR);
      return b;
    },
    auth: { admin: { listUsers: () => c.listUsers() } },
  };
  return { cfg: c, client: cl };
});
vi.mock("@/services/supabase", () => ({ serviceClient: () => client }));

import type { Request, Response } from "express";
import { staffTenants } from "../tenants";

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown } as {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}

const withEmails = { query: { include_member_emails: "1" } } as unknown as Request;

describe("staffTenants member_emails", () => {
  beforeEach(() => {
    cfg.tables = {
      tenants: { data: [{ id: "t1", slug: "acme" }, { id: "t2", slug: "beta" }], error: null },
      tenant_users: { data: [{ tenant_id: "t1", user_id: "u1" }, { tenant_id: "t1", user_id: "u2" }], error: null },
      tenant_member_invites: { data: [{ tenant_id: "t2", email: "Invitee@Beta.io" }], error: null },
    };
    cfg.listUsers = async () => ({
      data: { users: [{ id: "u1", email: "Owner@Acme.com" }, { id: "u2", email: "b@acme.com" }] },
      error: null,
    });
  });

  it("attaches lowercased member + pending-invite emails per tenant", async () => {
    const res = mockRes();
    await staffTenants(withEmails, res as unknown as Response);
    expect(res.body).toEqual({
      tenants: [
        { id: "t1", slug: "acme", member_emails: ["b@acme.com", "owner@acme.com"] },
        { id: "t2", slug: "beta", member_emails: ["invitee@beta.io"] },
      ],
      member_emails_complete: true,
    });
  });

  it("still returns the grid when the auth admin lookup throws", async () => {
    cfg.listUsers = async () => {
      throw new Error("auth down");
    };
    const res = mockRes();
    await staffTenants(withEmails, res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { tenants: unknown[]; member_emails_complete: boolean };
    expect(body.tenants).toHaveLength(2);
    expect(body.member_emails_complete).toBe(false);
  });

  it("omits emails unless the caller opts in", async () => {
    const res = mockRes();
    await staffTenants({ query: {} } as unknown as Request, res as unknown as Response);
    expect(res.body).toEqual({ tenants: [{ id: "t1", slug: "acme" }, { id: "t2", slug: "beta" }] });
  });
});
