import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const state = vi.hoisted(() => ({
  staffThrows: false,
  pages: [
    [
      { id: "u-1", email: "owner@acme.com", app_metadata: {} as Record<string, unknown> },
      { id: "u-2", email: "other@beta.com", app_metadata: {} as Record<string, unknown> },
    ],
  ] as Array<Array<{ id: string; email: string | null; app_metadata: Record<string, unknown> }>>,
  listUsersErr: null as { message: string } | null,
  memberships: [{ tenant_id: "t-1", role: "owner" }] as Array<{ tenant_id: string; role: string }>,
  membershipErr: null as { message: string } | null,
  tenants: [{ id: "t-1", slug: "acme", display_name: "Acme" }] as Array<{
    id: string;
    slug: string;
    display_name: string | null;
  }>,
  tenantErr: null as { message: string } | null,
}));

class FakeStaffError extends Error {
  status = 403;
  constructor() {
    super("not_staff");
  }
}

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => {
    if (state.staffThrows) throw new FakeStaffError();
    return { user_id: "staff-1", email: "ravi@upcar.ai" };
  },
}));

vi.mock("@/services/supabase", () => {
  class Chain {
    table: string;
    constructor(table: string) {
      this.table = table;
    }
    select() {
      return this;
    }
    eq() {
      return this;
    }
    async in() {
      if (this.table === "tenants") return { data: state.tenants, error: state.tenantErr };
      return { data: [], error: null };
    }
    then(resolve: (v: { data: unknown; error: unknown }) => void) {
      if (this.table === "tenant_users") {
        resolve({ data: state.memberships, error: state.membershipErr });
      } else {
        resolve({ data: [], error: null });
      }
    }
  }
  const svc = {
    from: (table: string) => new Chain(table),
    auth: {
      admin: {
        listUsers: async ({ page }: { page: number; perPage: number }) => {
          if (state.listUsersErr) return { data: null, error: state.listUsersErr };
          const users = state.pages[page - 1] ?? [];
          return { data: { users }, error: null };
        },
      },
    },
  };
  return { serviceClient: () => svc };
});

import { staffUserLookup } from "@/routes/admin/user-lookup";

function mockReqRes(query: unknown) {
  const req = { query } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function payloadOf(res: Response) {
  return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

beforeEach(() => {
  state.staffThrows = false;
  state.pages = [
    [
      { id: "u-1", email: "owner@acme.com", app_metadata: {} },
      { id: "u-2", email: "other@beta.com", app_metadata: {} },
    ],
  ];
  state.listUsersErr = null;
  state.memberships = [{ tenant_id: "t-1", role: "owner" }];
  state.membershipErr = null;
  state.tenants = [{ id: "t-1", slug: "acme", display_name: "Acme" }];
  state.tenantErr = null;
});

describe("GET /api/admin/user-lookup", () => {
  it("happy path → resolves email (case-insensitive) → user + tenants", async () => {
    const { req, res } = mockReqRes({ email: "Owner@Acme.com" });
    await staffUserLookup(req, res);
    const p = payloadOf(res);
    expect(p.user_id).toBe("u-1");
    expect(p.email).toBe("owner@acme.com");
    expect(p.tenants).toHaveLength(1);
    expect(p.tenants[0]).toMatchObject({ tenant_id: "t-1", slug: "acme", role: "owner" });
  });

  it("returns ALL tenants for a multi-tenant user, sorted by display name", async () => {
    state.memberships = [
      { tenant_id: "t-1", role: "member" },
      { tenant_id: "t-2", role: "owner" },
    ];
    state.tenants = [
      { id: "t-1", slug: "zeta", display_name: "Zeta" },
      { id: "t-2", slug: "acme", display_name: "Acme" },
    ];
    const { req, res } = mockReqRes({ email: "owner@acme.com" });
    await staffUserLookup(req, res);
    const p = payloadOf(res);
    expect(p.tenants.map((t: { slug: string }) => t.slug)).toEqual(["acme", "zeta"]);
  });

  it("BLOCKS a staff target (403, no tenants leaked)", async () => {
    state.pages = [[{ id: "u-1", email: "owner@acme.com", app_metadata: { role: "staff" } }]];
    const { req, res } = mockReqRes({ email: "owner@acme.com" });
    await staffUserLookup(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).error.code).toBe("staff_target_forbidden");
  });

  it("unknown email → 404", async () => {
    const { req, res } = mockReqRes({ email: "nobody@nowhere.com" });
    await staffUserLookup(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).error.code).toBe("user_not_found");
  });

  it("user with no memberships → 200 with empty tenants", async () => {
    state.memberships = [];
    const { req, res } = mockReqRes({ email: "owner@acme.com" });
    await staffUserLookup(req, res);
    const p = payloadOf(res);
    expect(p.user_id).toBe("u-1");
    expect(p.tenants).toEqual([]);
  });

  it("drops an orphaned membership whose tenant was deleted", async () => {
    state.memberships = [
      { tenant_id: "t-1", role: "owner" },
      { tenant_id: "t-gone", role: "member" },
    ];
    state.tenants = [{ id: "t-1", slug: "acme", display_name: "Acme" }];
    const { req, res } = mockReqRes({ email: "owner@acme.com" });
    await staffUserLookup(req, res);
    const p = payloadOf(res);
    expect(p.tenants).toHaveLength(1);
    expect(p.tenants[0].tenant_id).toBe("t-1");
  });

  it("invalid email → 400", async () => {
    const { req, res } = mockReqRes({ email: "not-an-email" });
    await staffUserLookup(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).error.code).toBe("bad_request");
  });

  it("staff-gated — assertStaff throwing prevents any lookup", async () => {
    state.staffThrows = true;
    const { req, res } = mockReqRes({ email: "owner@acme.com" });
    await expect(staffUserLookup(req, res)).rejects.toBeInstanceOf(FakeStaffError);
  });
});
