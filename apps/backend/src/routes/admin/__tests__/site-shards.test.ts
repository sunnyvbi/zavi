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

const auditRows: unknown[] = [];
let auditFails = false;
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "staff_users") {
        return { select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => gateResult }) }) }) };
      }
      return { insert: async (row: unknown) => (auditFails ? { error: { message: "audit down" } } : (auditRows.push(row), { error: null })) };
    }),
  })),
}));

const rpcCalls: string[] = [];
vi.mock("@/services/tenant-client", () => ({
  siteShardRpc: vi.fn(async (name: string) => {
    rpcCalls.push(name);
    throw new Error("data layer reached");
  }),
}));

import { staffMiddleware } from "@/services/auth/staff-middleware";
import { _setSiteShardsDeps, staffSiteShardsAutoProvisioning, staffSiteShardsList, staffSiteShardsProvision } from "../site-shards";
import type { AutoProvStore, Claim, ProvisionEvent } from "@/services/site-shards/autoprovision";

const STAFF = { user_id: "33333333-3333-4333-8333-333333333333", email: "ops@zavi" };

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

function fake(claims: Claim[], allowed = true) {
  const sent: ProvisionEvent[] = [];
  const claimCalls: unknown[] = [];
  const paused: boolean[] = [];
  const store: AutoProvStore = {
    claim: async (i) => (claimCalls.push(i), claims.shift() ?? { action: "none", reason: "cap", created_today: 10, cap: 10 }),
    finish: async () => ({ status: "open", consecutive_failures: 0, paused: false, tripped: false, already: false }),
    setPaused: async (env, p) => (paused.push(p), { env, paused: p, paused_reason: null, paused_by: null, consecutive_failures: 0, last_attempt_at: null }),
    status: async (env) => ({ state: { env, paused: false, paused_reason: null, paused_by: null, consecutive_failures: 0, last_attempt_at: null }, day: "2026-10-01", created_today: 0, ledger: [] }),
    notice: async () => true,
  };
  _setSiteShardsDeps({
    env: "prod",
    allowed: () => (allowed ? { ok: true } : { ok: false, reason: "not_deployed_backend" }),
    listShards: async () => [
      { id: "s1", name: "zavi-shard-prod-1", state: "open", project_ref: "refaaaaaaaa", site_count: 1000, max_sites: 2000, fill_ratio: 0.8, m_records: 5, lim_records: 100 } as any,
    ],
    settings: async () => ({ enabled: true, thresholdPct: 20, maxPerDay: 10, region: "us-west-1", dryRun: false }),
    prereqsMissing: () => [],
    store,
    send: async (e) => void sent.push(e),
    alert: async () => undefined,
  });
  return { sent, claimCalls, paused };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.test";
  jwtPayload = { sub: "user-not-staff", email: "stranger@example.com" };
  gateResult = { data: null, error: null };
  auditRows.length = 0;
  auditFails = false;
  rpcCalls.length = 0;
  _setSiteShardsDeps(null);
});

describe("non-staff callers", () => {
  for (const [label, handler, body] of [
    ["GET list", staffSiteShardsList, undefined],
    ["POST provision", staffSiteShardsProvision, { override_cap: true, reason: "need one" }],
    ["POST auto-provisioning", staffSiteShardsAutoProvisioning, { paused: false }],
  ] as const) {
    it(`${label} is refused with not_staff before the handler, a claim or the DB`, async () => {
      const f = fake([{ action: "create", ledger_id: "L1", day: "2026-10-01", seq: 1, shard_name: "zavi-shard-prod-2", n: 2, region: "us-west-1", canary: false, created_today: 1 }]);
      const req = { headers: {}, query: {}, params: {}, body } as any;
      const res = mockRes();
      let reached = false;
      await staffMiddleware()(req, res, () => {
        reached = true;
        return handler(req, res);
      });
      expect(reached).toBe(false);
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
      expect(JSON.stringify(res.payload)).toMatch(/not_staff/);
      expect(f.claimCalls).toEqual([]);
      expect(f.sent).toEqual([]);
      expect(rpcCalls).toEqual([]);
    });
  }
});

describe("staff", () => {
  it("lists shards with state, metrics and load, and the env's headroom", async () => {
    fake([]);
    const res = mockRes();
    await staffSiteShardsList({ staff: STAFF } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ env: "prod", deployed_backend: true, open: 1, created_today: 0 });
    expect(res.payload.shards[0]).toMatchObject({ name: "zavi-shard-prod-1", state: "open", site_count: 1000, load: 0.5, metrics: { records: 5 } });
    expect(res.payload.headroom).toBeCloseTo(0.375);
  });

  it("create now: claims, enqueues ONE job, audits; 202", async () => {
    const f = fake([{ action: "create", ledger_id: "L1", day: "2026-10-01", seq: 1, shard_name: "zavi-shard-prod-2", n: 2, region: "us-west-1", canary: false, created_today: 1 }]);
    const res = mockRes();
    await staffSiteShardsProvision({ staff: STAFF, body: {} } as any, res);
    expect(res.statusCode).toBe(202);
    expect(res.payload).toMatchObject({ action: "create", shard_name: "zavi-shard-prod-2", cap_override: false });
    expect(f.claimCalls[0]).toMatchObject({ source: "staff", override: false, actor: "ops@zavi" });
    expect(f.sent.map((e) => e.data.shard_name)).toEqual(["zavi-shard-prod-2"]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "site_shards.provision", meta: { result: "create", override_cap: false } });
  });

  it("cap reached: 429 and nothing sent; override needs a reason, and is audited BEFORE the claim (a failed audit stops it)", async () => {
    let f = fake([{ action: "none", reason: "cap", created_today: 10, cap: 10 }]);
    let res = mockRes();
    await staffSiteShardsProvision({ staff: STAFF, body: {} } as any, res);
    expect(res.statusCode).toBe(429);
    expect(f.sent).toEqual([]);

    res = mockRes();
    await staffSiteShardsProvision({ staff: STAFF, body: { override_cap: true } } as any, res);
    expect(res.statusCode).toBe(400);

    f = fake([{ action: "create", ledger_id: "L2", day: "2026-10-01", seq: 11, shard_name: "zavi-shard-prod-11", n: 11, region: "us-west-1", canary: false, created_today: 11 }]);
    auditFails = true;
    res = mockRes();
    await staffSiteShardsProvision({ staff: STAFF, body: { override_cap: true, reason: "launch spike" } } as any, res);
    expect(res.statusCode).toBe(500);
    expect(f.claimCalls).toEqual([]);
    expect(f.sent).toEqual([]);

    auditFails = false;
    auditRows.length = 0;
    res = mockRes();
    await staffSiteShardsProvision({ staff: STAFF, body: { override_cap: true, reason: "launch spike" } } as any, res);
    expect(res.statusCode).toBe(202);
    expect(res.payload).toMatchObject({ shard_name: "zavi-shard-prod-11", cap_override: true });
    expect(auditRows[0]).toMatchObject({ action: "site_shards.provision_cap_override", meta: { reason: "launch spike" } });
    expect(auditRows[1]).toMatchObject({ action: "site_shards.provision", meta: { result: "create", override_cap: true } });
  });

  it("on a local / probe backend: 409 not_deployed_backend, no claim", async () => {
    const f = fake([], false);
    const res = mockRes();
    await staffSiteShardsProvision({ staff: STAFF, body: {} } as any, res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.error.code).toBe("not_deployed_backend");
    expect(f.claimCalls).toEqual([]);
  });

  it("pause / resume is audited", async () => {
    const f = fake([]);
    const res = mockRes();
    await staffSiteShardsAutoProvisioning({ staff: STAFF, body: { paused: true, reason: "investigating" } } as any, res);
    expect(res.statusCode).toBe(200);
    await staffSiteShardsAutoProvisioning({ staff: STAFF, body: { paused: false } } as any, mockRes());
    expect(f.paused).toEqual([true, false]);
    expect(auditRows.map((r: any) => r.action)).toEqual(["site_shards.auto_pause", "site_shards.auto_resume"]);
    const bad = mockRes();
    await staffSiteShardsAutoProvisioning({ staff: STAFF, body: { paused: "yes" } } as any, bad);
    expect(bad.statusCode).toBe(400);
  });
});
