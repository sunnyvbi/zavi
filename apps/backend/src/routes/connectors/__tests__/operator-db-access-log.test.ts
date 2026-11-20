import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  auth: { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt-1" } as Record<string, string> | null,
  role: "owner" as string | null,
  calls: [] as Array<[string, ...unknown[]]>,
  tokens: [] as string[],
  rows: [] as unknown[],
  dbError: null as unknown,
  serviceUsed: false,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!h.auth) {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    }
    return h.auth;
  }),
}));
vi.mock("@/services/auth/members", () => ({
  isTenantAdminOrOwner: vi.fn(async (_c: unknown, userId: string, tenantId: string) => {
    h.calls.push(["isTenantAdminOrOwner", userId, tenantId]);
    return h.role === "owner" || h.role === "admin";
  }),
}));
vi.mock("@/services/supabase", () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    let cursor: { at: string; id: string } | null = null;
    b.or = (clause: string) => {
      h.calls.push(["or", clause]);
      const m = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/.exec(clause);
      if (m) cursor = { at: m[1], id: m[3] };
      return b;
    };
    for (const m of ["select", "eq", "gte", "lt", "ilike", "order", "limit"]) {
      b[m] = (...args: unknown[]) => {
        h.calls.push([m, ...args]);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => {
      const c = cursor;
      const rows = c
        ? (h.rows as Array<{ id: string; created_at: string }>).filter(
            (r) => r.created_at < c.at || (r.created_at === c.at && r.id < c.id),
          )
        : h.rows;
      return resolve({ data: h.dbError ? null : rows, error: h.dbError });
    };
    return b;
  };
  return {
    serverClientFromBearer: (token: string) => {
      h.tokens.push(token);
      return {
        from: (table: string) => {
          h.calls.push(["from", table]);
          return builder();
        },
      };
    },
    serviceClient: () => {
      h.serviceUsed = true;
      throw new Error("service role must not be used");
    },
  };
});

import { operatorDbAccessLog } from "../operator-db-access";

function mockRes() {
  const res: { statusCode: number; body: unknown } & Record<string, unknown> = { statusCode: 200, body: null };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res as unknown as Response & { statusCode: number; body: any };
}
const reqWith = (query: Record<string, string> = {}) =>
  ({ query, headers: { authorization: "Bearer jwt-1" } }) as unknown as Request;

const fromCalled = () => h.calls.some((c) => c[0] === "from");
const callsOf = (name: string) => h.calls.filter((c) => c[0] === name);

function row(i: number, extra: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-00000000000${i}`,
    created_at: `2026-10-11T10:0${i}:00.000Z`,
    query_text: "select 1",
    ...extra,
  };
}

beforeEach(() => {
  h.auth = { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt-1" };
  h.role = "owner";
  h.calls = [];
  h.tokens = [];
  h.rows = [];
  h.dbError = null;
  h.serviceUsed = false;
});

describe("operatorDbAccessLog auth", () => {
  it("unauthenticated -> 401, nothing read", async () => {
    h.auth = null;
    const res = mockRes();
    await operatorDbAccessLog(reqWith(), res);
    expect(res.statusCode).toBe(401);
    expect(fromCalled()).toBe(false);
  });

  it.each(["member", "viewer", null])("role %s -> 403 not_admin, the log is never queried", async (role) => {
    h.role = role;
    const res = mockRes();
    await operatorDbAccessLog(reqWith(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("not_admin");
    expect(callsOf("from")).toEqual([]);
  });

  it("checks the role for the auth user in the auth tenant", async () => {
    await operatorDbAccessLog(reqWith(), mockRes());
    expect(callsOf("isTenantAdminOrOwner")).toEqual([["isTenantAdminOrOwner", "user-1", "tenant-A"]]);
  });

  it("dual membership: owner of A and B active in A reads A only; ?tenant_id=B is ignored", async () => {
    const res = mockRes();
    await operatorDbAccessLog(reqWith({ tenant_id: "tenant-B" }), res);
    expect(res.statusCode).toBe(200);
    expect(callsOf("from")).toEqual([["from", "data_access_log"]]);
    const tenantEqs = callsOf("eq").filter((c) => c[1] === "tenant_id");
    expect(tenantEqs).toEqual([["eq", "tenant_id", "tenant-A"]]);
    expect(h.calls.some((c) => c.includes("tenant-B"))).toBe(false);
  });

  it("reads with the caller's own JWT client, never the service role", async () => {
    await operatorDbAccessLog(reqWith(), mockRes());
    expect(h.tokens.every((t) => t === "jwt-1")).toBe(true);
    expect(h.tokens.length).toBeGreaterThan(0);
    expect(h.serviceUsed).toBe(false);
  });

  it("admin is allowed", async () => {
    h.role = "admin";
    const res = mockRes();
    await operatorDbAccessLog(reqWith(), res);
    expect(res.statusCode).toBe(200);
  });
});

describe("operatorDbAccessLog query", () => {
  it("defaults: last 30 days, newest first, 50 rows (+1 to detect more)", async () => {
    const before = Date.now();
    await operatorDbAccessLog(reqWith(), mockRes());
    const gte = callsOf("gte");
    expect(gte).toHaveLength(1);
    expect(gte[0][1]).toBe("created_at");
    const since = Date.parse(String(gte[0][2]));
    expect(Math.round((before - since) / 86_400_000)).toBe(30);
    expect(callsOf("order")[0]).toEqual(["order", "created_at", { ascending: false }]);
    expect(callsOf("limit")).toEqual([["limit", 51]]);
  });

  it("agent filter: a slug, background, person", async () => {
    await operatorDbAccessLog(reqWith({ agent: "growth-lead" }), mockRes());
    expect(callsOf("eq")).toEqual(
      expect.arrayContaining([["eq", "caller_kind", "agent"], ["eq", "agent_slug", "growth-lead"]]),
    );
    h.calls = [];
    await operatorDbAccessLog(reqWith({ agent: "background" }), mockRes());
    expect(callsOf("eq")).toEqual(expect.arrayContaining([["eq", "caller_kind", "background"]]));
    expect(callsOf("eq").some((c) => c[1] === "agent_slug")).toBe(false);
    h.calls = [];
    await operatorDbAccessLog(reqWith({ agent: "person" }), mockRes());
    expect(callsOf("eq")).toEqual(expect.arrayContaining([["eq", "caller_kind", "person"]]));
  });

  it("mode, result, days, before filters", async () => {
    await operatorDbAccessLog(
      reqWith({ mode: "connector", result: "refused", days: "7", before: "2026-10-10T00:00:00.000Z" }),
      mockRes(),
    );
    expect(callsOf("eq")).toEqual(expect.arrayContaining([["eq", "mode", "connector"], ["eq", "result", "refused"]]));
    expect(callsOf("lt")).toEqual([["lt", "created_at", "2026-10-10T00:00:00.000Z"]]);
    const since = Date.parse(String(callsOf("gte")[0][2]));
    expect(Math.round((Date.now() - since) / 86_400_000)).toBe(7);
  });

  it("search escapes LIKE wildcards", async () => {
    await operatorDbAccessLog(reqWith({ q: "50%_off\\x" }), mockRes());
    expect(callsOf("ilike")).toEqual([["ilike", "query_text", "%50\\%\\_off\\\\x%"]]);
  });

  it("id: one entry, no date window (deep link from chat)", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    h.rows = [row(1, { id })];
    const res = mockRes();
    await operatorDbAccessLog(reqWith({ id }), res);
    expect(callsOf("eq")).toEqual(expect.arrayContaining([["eq", "id", id], ["eq", "tenant_id", "tenant-A"]]));
    expect(callsOf("gte")).toEqual([]);
    expect(res.body.rows).toHaveLength(1);
  });

  it.each([
    [{ days: "0" }],
    [{ days: "366" }],
    [{ limit: "500" }],
    [{ mode: "both" }],
    [{ result: "pwned" }],
    [{ agent: "Robert'); drop" }],
    [{ id: "not-a-uuid" }],
    [{ before: "yesterday" }],
    [{ q: "x".repeat(201) }],
  ])("invalid query %j -> 400 and no read", async (q) => {
    const res = mockRes();
    await operatorDbAccessLog(reqWith(q as Record<string, string>), res);
    expect(res.statusCode).toBe(400);
    expect(fromCalled()).toBe(false);
  });

  it("next_before is set only when more rows exist", async () => {
    h.rows = [row(3), row(2), row(1)];
    const res = mockRes();
    await operatorDbAccessLog(reqWith({ limit: "2" }), res);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.next_before).toBe(row(2).created_at);

    h.rows = [row(1)];
    const res2 = mockRes();
    await operatorDbAccessLog(reqWith({ limit: "2" }), res2);
    expect(res2.body.next_before).toBeNull();
  });

  it("paging never skips rows that share a created_at (compound cursor)", async () => {
    const at = "2026-10-11T10:00:00.000Z";
    h.rows = [row(2, { created_at: at }), row(1, { created_at: at })];
    const res = mockRes();
    await operatorDbAccessLog(reqWith({ limit: "1" }), res);
    expect(res.body.rows.map((r: { id: string }) => r.id)).toEqual([row(2).id]);
    expect(res.body).toMatchObject({ next_before: at, next_before_id: row(2).id });
    expect(callsOf("order")).toEqual([
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
    ]);

    h.calls = [];
    const res2 = mockRes();
    await operatorDbAccessLog(reqWith({ limit: "1", before: at, before_id: row(2).id }), res2);
    expect(res2.body.rows.map((r: { id: string }) => r.id)).toEqual([row(1).id]);
    expect(callsOf("lt")).toEqual([]);
  });

  it("a malformed before_id is 400", async () => {
    const res = mockRes();
    await operatorDbAccessLog(reqWith({ before: "2026-10-11T10:00:00.000Z", before_id: "1),id.gt.0" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("db error -> 500 without the error text", async () => {
    h.dbError = { message: "relation secret_thing does not exist" };
    const res = mockRes();
    await operatorDbAccessLog(reqWith(), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret_thing");
  });
});
