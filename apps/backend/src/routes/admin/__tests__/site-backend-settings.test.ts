import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JWTPayload } from "jose";

let jwtPayload: JWTPayload | null = { sub: "user-not-staff", email: "stranger@example.com" };
let gateResult: { data: { user_id: string } | null; error: { message: string } | null } = { data: null, error: null };

vi.mock("@/services/auth/jwt", () => ({
  verifyJwt: vi.fn(async () => {
    if (!jwtPayload) throw new Error("bad signature");
    return jwtPayload;
  }),
  readBearerToken: vi.fn(() => "fake.jwt.token"),
  customerJwksUrl: vi.fn(() => "https://example.test/auth/v1/.well-known/jwks.json"),
  customerExpectedIssuer: vi.fn(() => "https://example.test/auth/v1"),
  verifyBearer: vi.fn(async () => null),
}));

const auditInsert = vi.fn(async (_row: unknown) => ({ error: null }));
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "staff_users") {
        return { select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => gateResult }) }) }) };
      }
      return { insert: auditInsert };
    }),
  })),
}));

const rpcCalls: Array<[string, Record<string, unknown>]> = [];
vi.mock("@/services/tenant-client", () => ({
  siteShardRpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push([name, args]);
    throw new Error("data layer reached");
  }),
}));

import { staffMiddleware } from "@/services/auth/staff-middleware";
import { _setGraduationApi, _setSiteSettingsDeps, staffSiteBackendSettingsGet, staffSiteBackendSettingsPut, staffSiteGraduate, staffSiteGraduation } from "../site-backend-settings";

const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";
const STAFF = "33333333-3333-4333-8333-333333333333";

function mockRes() {
  return {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  } as any;
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.test";
  jwtPayload = { sub: "user-not-staff", email: "stranger@example.com" };
  gateResult = { data: null, error: null };
  auditInsert.mockClear();
  rpcCalls.length = 0;
  _setSiteSettingsDeps(null);
  _setGraduationApi(null);
});

describe("non-staff callers", () => {
  for (const [label, handler, req] of [
    ["GET", staffSiteBackendSettingsGet, { params: { site_id: SITE }, headers: {}, query: {} }],
    ["PUT", staffSiteBackendSettingsPut, { params: { site_id: SITE }, headers: {}, query: {}, body: { turnstile_enabled: false } }],
    ["POST graduate", staffSiteGraduate, { params: { site_id: SITE }, headers: {}, query: {}, body: {} }],
    ["GET graduation", staffSiteGraduation, { params: { site_id: SITE }, headers: {}, query: {} }],
  ] as const) {
    it(`${label} is refused with not_staff before the handler, the DB, the shard or KV`, async () => {
      const res = mockRes();
      let reached = false;
      await staffMiddleware()(req as any, res, () => {
        reached = true;
        return handler(req as any, res);
      });
      expect(reached).toBe(false);
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
      expect(JSON.stringify(res.payload)).toMatch(/not_staff/);
      expect(rpcCalls).toEqual([]);
    });
  }
});

describe("staff save", () => {
  function fakeDeps() {
    const shardSql: string[] = [];
    const kv = new Map<string, string>();
    let row: any = { id: SITE, tenant_id: TENANT, hostname: "qa-ab12.zaviagent.com", status: "live", host_version: 3,
      gateway_binding: { shard_id: "shardref", shard_url: "https://shardref000.supabase.co", status: "active", manifest_hash: "h" }, gateway_config: null };
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push([name, args]);
      if (args.p_site_id !== SITE) return { data: null, error: { code: "P0002", message: "not found" } };
      const patch = args.p_patch as Record<string, unknown>;
      row = { ...row, host_version: row.host_version + 1, gateway_config: { turnstile: { enabled: patch.turnstile_enabled !== false, site_key: null } } };
      return { data: { site_id: SITE, tenant_id: TENANT, max_records: patch.max_records ?? null, max_bytes: null, max_writes_per_min: 5,
        recipient_creates_per_min: null, turnstile_enabled: patch.turnstile_enabled ?? null, turnstile_site_key: null,
        turnstile_secret_set: !!args.p_turnstile_secret, shard_id: "44444444-4444-4444-8444-444444444444", host_version: row.host_version }, error: null };
    });
    _setSiteSettingsDeps({
      rpc,
      registry: { get: async () => ({ project_ref: "shardref" }) as any },
      sql: { query: async (_ref, q) => (shardSql.push(q), q.includes("information_schema") ? [{ n: 0 }] : [{ site_id: SITE }]) },
      host: {
        kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
        bump: async () => ((row = { ...row, host_version: row.host_version + 1 }), { ...row }),
        get: async () => ({ ...row }),
      },
    });
    return { shardSql, kv, rpc };
  }

  it("validates the body (strict keys, contract cap on recipient creates)", async () => {
    fakeDeps();
    for (const body of [{ max_records: -1 }, { recipient_creates_per_min: 31 }, { evil: 1 }, { turnstile_site_key: "a b" }, { turnstile_secret: "x".repeat(12), clear_turnstile_secret: true }]) {
      const res = mockRes();
      await staffSiteBackendSettingsPut({ staff: { user_id: STAFF, email: "ops@zavi" }, params: { site_id: SITE }, body } as any, res);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const res = mockRes();
    await staffSiteBackendSettingsPut({ staff: { user_id: STAFF, email: "ops@zavi" }, params: { site_id: "not-a-uuid" }, body: {} } as any, res);
    expect(res.statusCode).toBe(400);
  });

  it("applies to THIS site's shard quotas and the KV turnstile block; the secret never comes back or reaches the audit", async () => {
    const f = fakeDeps();
    const res = mockRes();
    const secret = "0x4AAAAAAAsecretsecret";
    const refused = mockRes();
    await staffSiteBackendSettingsPut({ staff: { user_id: STAFF, email: "ops@zavi" }, params: { site_id: SITE }, body: { turnstile_secret: secret } } as any, refused);
    expect(refused.statusCode).toBe(400);
    expect(refused.payload.error.code).toBe("turnstile_pair_required");
    expect(f.rpc).not.toHaveBeenCalled();
    await staffSiteBackendSettingsPut(
      { staff: { user_id: STAFF, email: "ops@zavi" }, params: { site_id: SITE }, body: { max_records: 50, turnstile_enabled: false, turnstile_site_key: "0x4AAAAAAAsitekey", turnstile_secret: secret } } as any,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_site_id: SITE, p_actor_user_id: STAFF, p_patch: { max_records: 50, turnstile_enabled: false, turnstile_site_key: "0x4AAAAAAAsitekey" }, p_turnstile_secret: secret });
    const upd = f.shardSql.find((q) => q.startsWith("update zsite.quotas")) as string;
    expect(upd).toMatch(new RegExp(`set max_records = 50, max_bytes = default, max_writes_per_min = 5 where site_id = '${SITE}'::uuid`));
    expect(upd).not.toContain(OTHER);
    const kvRec = JSON.parse([...f.kv.values()][0]);
    expect(kvRec.turnstile).toBe(false);
    expect(JSON.stringify(kvRec)).not.toContain(secret);
    expect(JSON.stringify(res.payload)).not.toContain(secret);
    const audit = auditInsert.mock.calls[0][0] as any;
    expect(audit).toMatchObject({ action: "site_backend_settings.set", target_id: SITE, tenant_id: TENANT, actor_user_id: STAFF });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(audit.meta.turnstile_secret).toBe("set");
  });

  it("an unknown site is a 404, and nothing reaches a shard or KV", async () => {
    const f = fakeDeps();
    const res = mockRes();
    await staffSiteBackendSettingsPut({ staff: { user_id: STAFF, email: "ops@zavi" }, params: { site_id: OTHER }, body: { max_records: 1 } } as any, res);
    expect(res.statusCode).toBe(404);
    expect(f.shardSql).toEqual([]);
    expect(f.kv.size).toBe(0);
  });
});

describe("staff graduation", () => {
  it("requests the move (tenant from the site row), audits it, and starts it now", async () => {
    const kicked: string[] = [];
    _setGraduationApi({
      request: async (id) => (id === SITE ? { tenant_id: TENANT, state: "requested" } : null),
      status: async () => null,
      kick: (t, s) => void kicked.push(`${t}:${s}`),
    });
    const res = mockRes();
    await staffSiteGraduate({ staff: { user_id: STAFF, email: "ops@zavi" }, params: { site_id: SITE } } as any, res);
    expect(res.statusCode).toBe(202);
    expect(kicked).toEqual([`${TENANT}:${SITE}`]);
    expect(auditInsert.mock.calls[0][0]).toMatchObject({ action: "site_graduation.request", target_id: SITE, tenant_id: TENANT });
    const res2 = mockRes();
    await staffSiteGraduate({ staff: { user_id: STAFF, email: "ops@zavi" }, params: { site_id: OTHER } } as any, res2);
    expect(res2.statusCode).toBe(409);
    expect(kicked).toHaveLength(1);
  });
});
