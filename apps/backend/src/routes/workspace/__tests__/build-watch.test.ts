import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  stamps: [] as Array<{ tenant: string; bucket: string }>,
  clears: [] as Array<{ tenant: string; bucket: string }>,
  fail: false,
  readFail: false,
  runs: [] as Array<{ id: string; tenant_id: string; kind: string }>,
  tokens: { "t-a": "tenant-a", "t-b": "tenant-b" } as Record<string, string>,
  reads: [] as string[],
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: (token: string) => ({
    from: (table: string) => {
      h.reads.push(table);
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => (filters.push([col, val]), q),
        maybeSingle: async () => {
          if (h.readFail) return { data: null, error: { message: "read down" } };
          const visible = h.runs.filter((r) => r.tenant_id === h.tokens[token]);
          const hit = visible.find((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
          return { data: hit ? { id: hit.id } : null, error: null };
        },
      };
      return q;
    },
  }),
  serviceClient: () => {
    throw new Error("service role must not be used for the session check");
  },
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  stampTenantMarker: vi.fn(async (tenant: string, bucket: string) => {
    if (h.fail) throw new Error("db down");
    h.stamps.push({ tenant, bucket });
  }),
  clearTenantMarker: vi.fn(async (tenant: string, bucket: string) => {
    h.clears.push({ tenant, bucket });
  }),
  tenantMarkerAt: vi.fn(async () => null),
}));

import { postBuildWatch } from "../build-watch";

const SESSION = "0f8e2a7c-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const OTHER = "9a9a9a9a-1111-4222-8333-444455556666";
const FOREIGN = "b0b0b0b0-1111-4222-8333-444455556666";
const NOT_BUILD = "c0c0c0c0-1111-4222-8333-444455556666";
const AUTH_A = { tenant_id: "tenant-a", user_id: "u1", access_token: "t-a" };

function res() {
  return {
    statusCode: 0,
    ended: false,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.ended = true;
      return this;
    },
  };
}

describe("POST /api/workspace/autopilot/build-watch", () => {
  beforeEach(() => {
    h.requireAuth.mockReset();
    h.stamps = [];
    h.clears = [];
    h.fail = false;
    h.readFail = false;
    h.reads = [];
    h.runs = [
      { id: SESSION, tenant_id: "tenant-a", kind: "build_app" },
      { id: OTHER, tenant_id: "tenant-a", kind: "build_app" },
      { id: FOREIGN, tenant_id: "tenant-b", kind: "build_app" },
      { id: NOT_BUILD, tenant_id: "tenant-a", kind: "company_goal" },
    ];
  });

  it("stamps the build session's own watch bucket for the authenticated tenant", async () => {
    h.requireAuth.mockResolvedValue(AUTH_A);
    const r = res();
    await postBuildWatch({ body: { session_id: SESSION } } as never, r as never);
    expect(r.statusCode).toBe(204);
    expect(h.stamps).toEqual([{ tenant: "tenant-a", bucket: `build_watch:${SESSION}` }]);
    await postBuildWatch({ body: { session_id: OTHER } } as never, res() as never);
    expect(h.stamps).toEqual([
      { tenant: "tenant-a", bucket: `build_watch:${SESSION}` },
      { tenant: "tenant-a", bucket: `build_watch:${OTHER}` },
    ]);
  });

  it("stamps the caller's own tenant, never one named in the body or query", async () => {
    h.requireAuth.mockResolvedValue(AUTH_A);
    const r = res();
    await postBuildWatch({ body: { tenant_id: "tenant-b", session_id: SESSION }, query: { tenant_id: "tenant-b" } } as never, r as never);
    expect(r.statusCode).toBe(204);
    expect(h.stamps).toEqual([{ tenant: "tenant-a", bucket: `build_watch:${SESSION}` }]);
  });

  it.each([
    ["no body", undefined],
    ["an empty body", {}],
    ["a null session", { session_id: null }],
    ["a numeric session", { session_id: 42 }],
    ["a non-uuid session", { session_id: "run-a" }],
    ["a uuid with a suffix", { session_id: `${SESSION}:x` }],
    ["a path-shaped session", { session_id: `../${SESSION}` }],
  ])("stamps nothing and answers 204 for %s", async (_label, body) => {
    h.requireAuth.mockResolvedValue(AUTH_A);
    const r = res();
    await postBuildWatch({ body } as never, r as never);
    expect(r.statusCode).toBe(204);
    expect(r.ended).toBe(true);
    expect(h.stamps).toEqual([]);
  });

  it("a session of another tenant posted by a tenant-a member gets 404 and stamps nothing", async () => {
    h.requireAuth.mockResolvedValue(AUTH_A);
    const r = res();
    await postBuildWatch({ body: { session_id: FOREIGN } } as never, r as never);
    expect(r.statusCode).toBe(404);
    expect(h.stamps).toEqual([]);
    expect(h.reads).toEqual(["conductor_runs"]);
  });

  it("a random uuid or a non-build run gets 404 and stamps nothing, so the marker table cannot be grown", async () => {
    h.requireAuth.mockResolvedValue(AUTH_A);
    for (const id of ["dddddddd-1111-4222-8333-444455556666", NOT_BUILD]) {
      const r = res();
      await postBuildWatch({ body: { session_id: id } } as never, r as never);
      expect(r.statusCode).toBe(404);
    }
    expect(h.stamps).toEqual([]);
  });

  it("left:true on an own session clears that session's marker and stamps nothing", async () => {
    h.requireAuth.mockResolvedValue(AUTH_A);
    const r = res();
    await postBuildWatch({ body: { session_id: SESSION, left: true } } as never, r as never);
    expect(r.statusCode).toBe(204);
    expect(h.clears).toEqual([{ tenant: "tenant-a", bucket: `build_watch:${SESSION}` }]);
    expect(h.stamps).toEqual([]);
  });

  it("left:true with another tenant's session clears nothing", async () => {
    h.requireAuth.mockResolvedValue(AUTH_A);
    const r = res();
    await postBuildWatch({ body: { session_id: FOREIGN, left: true } } as never, r as never);
    expect(r.statusCode).toBe(404);
    expect(h.clears).toEqual([]);
  });

  it("a failed session read stamps and clears nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.readFail = true;
    h.requireAuth.mockResolvedValue(AUTH_A);
    await postBuildWatch({ body: { session_id: SESSION } } as never, res() as never);
    await postBuildWatch({ body: { session_id: SESSION, left: true } } as never, res() as never);
    expect(h.stamps).toEqual([]);
    expect(h.clears).toEqual([]);
    warn.mockRestore();
  });

  it("stamps nothing when unauthenticated", async () => {
    h.requireAuth.mockResolvedValue(null);
    await postBuildWatch({ body: { session_id: SESSION } } as never, res() as never);
    expect(h.stamps).toEqual([]);
  });

  it("a failed stamp still answers 204", async () => {
    h.fail = true;
    h.requireAuth.mockResolvedValue(AUTH_A);
    const r = res();
    await postBuildWatch({ body: { session_id: SESSION } } as never, r as never);
    expect(r.statusCode).toBe(204);
  });
});
