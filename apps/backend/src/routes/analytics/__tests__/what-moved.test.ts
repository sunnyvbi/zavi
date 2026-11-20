
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  eqCalls: [] as Array<[string, unknown]>,
  upserts: [] as Array<{ tenant: string; row: Record<string, unknown>; opts: unknown }>,
  deletes: [] as Array<{ tenant: string; key: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const done = Promise.resolve({ data: [{ table }], error: null });
      for (const k of ["select", "gte", "order"]) chain[k] = () => chain;
      chain.eq = (c: string, v: unknown) => (m.eqCalls.push([c, v]), chain);
      chain.limit = () => done;
      return chain;
    },
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>, opts: unknown) => (m.upserts.push({ tenant, row, opts }), { error: null }),
      delete: () => ({ eq: async (_c: string, key: unknown) => (m.deletes.push({ tenant, key }), { error: null }) }),
    }),
  }),
}));

import { getWhatMoved, postAnomalyMute, MUTE_KEY_RE } from "../what-moved";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200 };
  res.status = vi.fn((c: number) => ((res.statusCode = c), res));
  res.json = vi.fn((b: unknown) => ((res.body = b), res));
  return res as unknown as import("express").Response & { statusCode: number; body: Record<string, unknown> };
}
const req = (body: unknown = {}) => ({ body, headers: {}, query: {} }) as unknown as import("express").Request;

beforeEach(() => {
  m.eqCalls = [];
  m.upserts = [];
  m.deletes = [];
  m.requireAuth.mockReset();
  m.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t-1", access_token: "tok" });
});

describe("GET /api/analytics/what-moved", () => {
  it("returns incidents, moves and mutes for the session's tenant only", async () => {
    const res = mockRes();
    await getWhatMoved(req(), res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body)).toEqual(["incidents", "moves", "mutes"]);
    expect(m.eqCalls).toEqual([["tenant_id", "t-1"], ["tenant_id", "t-1"], ["tenant_id", "t-1"]]);
  });

  it("unauthenticated: stops at requireAuth", async () => {
    m.requireAuth.mockResolvedValue(null);
    const res = mockRes();
    await getWhatMoved(req(), res);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("POST /api/analytics/anomaly-mutes", () => {
  it("mutes a metric for the session's tenant, ignoring any tenant in the body", async () => {
    const res = mockRes();
    await postAnomalyMute(req({ key: "sessions", tenant_id: "t-other" }), res);
    expect(res.body).toEqual({ ok: true, key: "sessions", muted: true });
    expect(m.upserts).toEqual([{ tenant: "t-1", row: { mute_key: "sessions", muted_by: "u1" }, opts: { onConflict: "tenant_id,mute_key", ignoreDuplicates: true } }]);
  });

  it("unmutes with muted:false, and mutes all with *", async () => {
    await postAnomalyMute(req({ key: "sessions", muted: false }), mockRes());
    expect(m.deletes).toEqual([{ tenant: "t-1", key: "sessions" }]);
    await postAnomalyMute(req({ key: "*" }), mockRes());
    expect(m.upserts[0].row.mute_key).toBe("*");
  });

  it("refuses when expect_tenant is not the session's tenant, and writes when it is", async () => {
    const res = mockRes();
    await postAnomalyMute(req({ key: "sessions", muted: false, expect_tenant: "t-other" }), res);
    expect(res.statusCode).toBe(409);
    expect(m.deletes).toEqual([]);
    await postAnomalyMute(req({ key: "sessions", expect_tenant: "t-1" }), mockRes());
    expect(m.upserts).toHaveLength(1);
  });

  it("rejects a key that is not a metric id, read_failed:<source> or *", async () => {
    for (const bad of ["", "DROP TABLE", "a".repeat(65), "read_failed:", "x,y"]) {
      const res = mockRes();
      await postAnomalyMute(req({ key: bad }), res);
      expect(res.statusCode, bad).toBe(400);
    }
    expect(MUTE_KEY_RE.test("read_failed:google_analytics")).toBe(true);
    expect(m.upserts).toEqual([]);
  });
});
