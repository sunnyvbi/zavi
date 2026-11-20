
import { describe, it, expect, beforeEach } from "vitest";
import type { Request, Response } from "express";

const t1 = "00000000-0000-0000-0000-000000000001";
const ownerId = "10000000-0000-0000-0000-000000000001";
const adminId = "10000000-0000-0000-0000-000000000002";
const memberId = "10000000-0000-0000-0000-000000000003";
const strangerId = "10000000-0000-0000-0000-0000000000ff";

type Row = { tenant_id: string; user_id: string; role: "owner" | "admin" | "member" };

const state: {
  auth: { user_id: string; tenant_id: string; access_token: string } | null;
  rows: Row[];
  demoteAffectsZero: boolean;
  step2Error: { code?: string; message: string } | null;
  step2Mutates: boolean;
} = {
  auth: null,
  rows: [],
  demoteAffectsZero: false,
  step2Error: null,
  step2Mutates: true,
};

function resetState() {
  state.auth = { user_id: ownerId, tenant_id: t1, access_token: "fake-jwt" };
  state.rows = [
    { tenant_id: t1, user_id: ownerId, role: "owner" },
    { tenant_id: t1, user_id: adminId, role: "admin" },
    { tenant_id: t1, user_id: memberId, role: "member" },
  ];
  state.demoteAffectsZero = false;
  state.step2Error = null;
  state.step2Mutates = true;
}

import { vi } from "vitest";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!state.auth) {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    }
    return state.auth;
  }),
}));

function makeServiceClient() {
  function from(_table: string) {
    const q = {
      mode: null as null | "select" | "update",
      patch: null as null | Partial<Row>,
      filters: [] as Array<{ op: "eq" | "in"; col: keyof Row; val: unknown }>,
      head: false,
      returnAffected: false,
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        if (q.mode === "update") q.returnAffected = true;
        else {
          q.mode = "select";
          q.head = !!opts?.head;
        }
        return q;
      },
      update(patch: Partial<Row>) {
        q.mode = "update";
        q.patch = patch;
        return q;
      },
      eq(col: keyof Row, val: unknown) {
        q.filters.push({ op: "eq", col, val });
        return q;
      },
      in(col: keyof Row, val: unknown[]) {
        q.filters.push({ op: "in", col, val });
        return q;
      },
      then(resolve: (v: { data: unknown; error: unknown; count?: number }) => void) {
        resolve(run());
      },
    };

    const matches = (row: Row) =>
      q.filters.every((f) =>
        f.op === "eq" ? row[f.col] === f.val : (f.val as unknown[]).includes(row[f.col]),
      );

    function doApply(): { affected: Row[] } | { conflict: true } {
      const matched = state.rows.filter(matches);
      if (q.patch?.role === "owner") {
        const tenant = matched[0]?.tenant_id;
        const otherOwner = state.rows.find(
          (r) => r.tenant_id === tenant && r.role === "owner" && !matched.includes(r),
        );
        if (otherOwner) return { conflict: true };
      }
      matched.forEach((r) => Object.assign(r, q.patch));
      return { affected: matched };
    }

    function run(): { data: unknown; error: unknown; count?: number } {
      if (q.mode === "select") {
        const matched = state.rows.filter(matches);
        if (q.head) return { data: null, error: null, count: matched.length };
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (q.patch?.role === "admin" && state.demoteAffectsZero) {
        return { data: q.returnAffected ? [] : null, error: null };
      }
      const isPromote = q.patch?.role === "owner" && q.filters.some((f) => f.col === "role" && f.op === "in");
      if (isPromote && state.step2Error) {
        if (state.step2Mutates) doApply();
        return { data: q.returnAffected ? [] : null, error: state.step2Error };
      }
      const r = doApply();
      if ("conflict" in r) {
        return { data: null, error: { code: "23505", message: "duplicate owner" } };
      }
      return { data: q.returnAffected ? r.affected.map((x) => ({ ...x })) : null, error: null };
    }

    return q;
  }
  return { from };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: () => ({}), rpc: async () => ({ data: null, error: null }) }),
  serviceClient: () => makeServiceClient(),
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

import { membersRouter } from "@/routes/members";
const router = membersRouter();

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

const ownerCount = () => state.rows.filter((r) => r.role === "owner").length;
const roleOf = (id: string) => state.rows.find((r) => r.user_id === id)?.role ?? null;

beforeEach(() => {
  resetState();
});

describe("POST /:userId/transfer-ownership", () => {
  it("happy path: owner→admin, target→owner, exactly one owner", async () => {
    const res = await dispatch("POST", `/${adminId}/transfer-ownership`, {});
    expect(res.statusCode).toBe(200);
    expect(roleOf(ownerId)).toBe("admin");
    expect(roleOf(adminId)).toBe("owner");
    expect(ownerCount()).toBe(1);
  });

  it("non-owner caller → 403, no mutation", async () => {
    state.auth = { user_id: adminId, tenant_id: t1, access_token: "fake-jwt" };
    const res = await dispatch("POST", `/${memberId}/transfer-ownership`, {});
    expect(res.statusCode).toBe(403);
    expect(roleOf(ownerId)).toBe("owner");
    expect(roleOf(memberId)).toBe("member");
    expect(ownerCount()).toBe(1);
  });

  it("self-transfer → 400", async () => {
    const res = await dispatch("POST", `/${ownerId}/transfer-ownership`, {});
    expect(res.statusCode).toBe(400);
    expect(roleOf(ownerId)).toBe("owner");
  });

  it("target not a member of this tenant → 404", async () => {
    const res = await dispatch("POST", `/${strangerId}/transfer-ownership`, {});
    expect(res.statusCode).toBe(404);
    expect(roleOf(ownerId)).toBe("owner");
    expect(ownerCount()).toBe(1);
  });

  it("non-UUID userId → 400 before any work", async () => {
    const res = await dispatch("POST", `/not-a-uuid/transfer-ownership`, {});
    expect(res.statusCode).toBe(400);
    expect(ownerCount()).toBe(1);
  });

  it("race: demote affects 0 rows (caller lost ownership) → non-2xx, one owner survives", async () => {
    state.demoteAffectsZero = true;
    const res = await dispatch("POST", `/${adminId}/transfer-ownership`, {});
    expect((res.statusCode ?? 200) >= 400).toBe(true);
    expect(roleOf(ownerId)).toBe("owner");
    expect(ownerCount()).toBe(1);
  });

  it("step-2 committed but response lost → reconcile reads success (200)", async () => {
    state.step2Error = { code: "500", message: "network blip after commit" };
    state.step2Mutates = true;
    const res = await dispatch("POST", `/${adminId}/transfer-ownership`, {});
    expect(res.statusCode).toBe(200);
    expect(roleOf(adminId)).toBe("owner");
    expect(ownerCount()).toBe(1);
  });

  it("genuine step-2 failure (no mutation) → restore original owner, exactly one owner, 500", async () => {
    state.step2Error = { code: "08006", message: "connection failure" };
    state.step2Mutates = false;
    const res = await dispatch("POST", `/${adminId}/transfer-ownership`, {});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(roleOf(ownerId)).toBe("owner");
    expect(roleOf(adminId)).toBe("admin");
    expect(ownerCount()).toBe(1);
  });
});
