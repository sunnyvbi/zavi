import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  auth: { user_id: "u-1", tenant_id: "t-own", access_token: "tok-1" } as
    | { user_id: string; tenant_id: string; access_token: string }
    | null,
  catalog: { dialect: "mongodb", catalog_hash: "h1" } as Record<string, unknown> | null,
  existing: null as null | { confirmed_map: Record<string, unknown> },
  rpcError: null as null | { code: string; message: string },
  rpcCalls: [] as Array<{ token: string; fn: string; args: Record<string, unknown> }>,
  sends: [] as unknown[],
  setup: { state: "no_db" } as Record<string, unknown>,
  intel: { configured: false, tenant_id: "t-own" } as Record<string, unknown>,
  lastRun: {} as Record<string, unknown>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => m.auth }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => true,
  getSetting: async () => m.lastRun,
}));
vi.mock("@/services/tools/growth/marketplace_intelligence", () => ({
  getMarketplaceIntel: async () => m.intel,
}));
vi.mock("@/services/tools/operator-db/catalog", () => ({
  getCatalog: async () => m.catalog,
}));
vi.mock("@/services/tools/operator-db/mapping", () => ({
  getConfirmedMapping: async () => m.existing,
}));
vi.mock("@/services/marketplace-intel/self-serve", async (orig) => {
  const real = await orig<typeof import("@/services/marketplace-intel/self-serve")>();
  return { ...real, getSupplyDemandSetup: async () => m.setup };
});
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: (token: string) => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      m.rpcCalls.push({ token, fn, args });
      return { data: null, error: m.rpcError };
    },
  }),
}));
vi.mock("@/../workers/client", () => ({
  inngest: { send: async (e: unknown) => void m.sends.push(e) },
}));

import {
  marketplaceIntelligenceDashboard,
  marketplaceIntelligenceSetup,
} from "../marketplace-intelligence-dashboard";

const ANSWERS = {
  bookings: { table: "orders", created_at_field: "createdAt", geo_field: "city", listing_ref_field: "itemId" },
  listings: { table: "items", id_field: "_id", geo_field: "state" },
};

function res() {
  const r = { statusCode: 200, body: undefined as unknown };
  return Object.assign(r, {
    status(c: number) { r.statusCode = c; return this; },
    json(b: unknown) { r.body = b; return this; },
  });
}

beforeEach(() => {
  m.auth = { user_id: "u-1", tenant_id: "t-own", access_token: "tok-1" };
  m.catalog = { dialect: "mongodb", catalog_hash: "h1" };
  m.existing = null;
  m.rpcError = null;
  m.rpcCalls = [];
  m.sends = [];
  m.setup = { state: "no_db" };
  m.intel = { configured: false, tenant_id: "t-own" };
  m.lastRun = {};
});

describe("POST /api/agents/marketplace-intelligence/confirm-setup", () => {
  it("saves via the USER-scoped RPC for the caller's tenant (body tenant ignored) and requests a rollup", async () => {
    const r = res();
    await marketplaceIntelligenceSetup(
      { body: { tenant_id: "t-victim", catalog_hash: "h1", answers: ANSWERS } } as never,
      r as never,
    );
    expect(r.statusCode).toBe(200);
    expect(m.rpcCalls).toHaveLength(1);
    expect(m.rpcCalls[0].token).toBe("tok-1");
    expect(m.rpcCalls[0].fn).toBe("set_mapping_confirmed");
    expect(m.rpcCalls[0].args.p_tenant_id).toBe("t-own");
    expect(m.sends).toEqual([{ name: "marketplace.rollup.requested", data: { tenant_id: "t-own" } }]);
  });

  it("merges into the existing confirmation instead of replacing it", async () => {
    m.existing = { confirmed_map: { cancellations: { table: "orders", reason_field: "why" } } };
    await marketplaceIntelligenceSetup({ body: { catalog_hash: "h1", answers: ANSWERS } } as never, res() as never);
    const map = m.rpcCalls[0].args.p_confirmed_map as Record<string, unknown>;
    expect(map.cancellations).toEqual({ table: "orders", reason_field: "why" });
    expect(Object.keys(map).sort()).toEqual(["bookings", "cancellations", "listings", "supply_demand"]);
  });

  it("non-admin → 403 admin_required, no rollup", async () => {
    m.rpcError = { code: "42501", message: "not admin" };
    const r = res();
    await marketplaceIntelligenceSetup({ body: { catalog_hash: "h1", answers: ANSWERS } } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: "admin_required" });
    expect(m.sends).toHaveLength(0);
  });

  it("RPC rejection → 400 without echoing DB text", async () => {
    m.rpcError = { code: "22023", message: "mapping key bookings references unknown field orders.secret" };
    const r = res();
    await marketplaceIntelligenceSetup({ body: { catalog_hash: "h1", answers: ANSWERS } } as never, r as never);
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });

  it("operator-shaped name → 400 before any RPC", async () => {
    const r = res();
    await marketplaceIntelligenceSetup(
      { body: { catalog_hash: "h1", answers: { ...ANSWERS, bookings: { ...ANSWERS.bookings, geo_field: "$where" } } } } as never,
      r as never,
    );
    expect(r.statusCode).toBe(400);
    expect(m.rpcCalls).toHaveLength(0);
  });

  it("stale structure → 409 database_changed; non-Mongo → 409 database_not_ready", async () => {
    const r1 = res();
    await marketplaceIntelligenceSetup({ body: { catalog_hash: "old", answers: ANSWERS } } as never, r1 as never);
    expect(r1.statusCode).toBe(409);
    expect(r1.body).toEqual({ error: "database_changed" });
    m.catalog = { dialect: "dynamodb", catalog_hash: "h1" };
    const r2 = res();
    await marketplaceIntelligenceSetup({ body: { catalog_hash: "h1", answers: ANSWERS } } as never, r2 as never);
    expect(r2.statusCode).toBe(409);
    expect(m.rpcCalls).toHaveLength(0);
  });

  it("unauthenticated → nothing happens", async () => {
    m.auth = null;
    await marketplaceIntelligenceSetup({ body: { catalog_hash: "h1", answers: ANSWERS } } as never, res() as never);
    expect(m.rpcCalls).toHaveLength(0);
  });
});

describe("error handling", () => {
  it("a database timeout answers 500 instead of rejecting (which crashed the server)", async () => {
    m.intel = null as never;
    const orig = m.catalog;
    const r = res();
    m.intel = new Proxy({}, { get: () => { throw new Error("upstream request timeout"); } }) as never;
    await expect(marketplaceIntelligenceDashboard({ query: {} } as never, r as never)).resolves.toBeUndefined();
    expect(r.statusCode).toBe(500);
    m.catalog = orig;
  });
});

describe("GET dashboard setup state", () => {
  it("attaches the setup state when not configured", async () => {
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    expect(r.body).toMatchObject({ configured: false, setup: { state: "no_db" } });
  });

  const selfServe = (over: Record<string, unknown> = {}) => ({
    configured: true,
    tenant_id: "t-own",
    regions: [],
    weeks: [],
    total: { bookings_n: 0, active_supply_n: 0, total_listings: null },
    window_weeks: 13,
    as_of: new Date().toISOString(),
    provenance: {
      source: "self_serve_confirmed",
      validated: true,
      caveats: [],
      confirmed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      setup_id: "hash-now:confirm-now",
    },
    ...over,
  });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("no run recorded for this setup → calculating (no time guess)", async () => {
    m.intel = selfServe();
    m.lastRun = { status: "ok", at: ago(60 * 60_000), setup_id: "hash-old:confirm-old" };
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    expect(r.body).toMatchObject({ setup: { state: "waiting_first_run" } });
  });

  it("run finished ok with nothing to show → no recent bookings", async () => {
    m.intel = selfServe();
    m.lastRun = { status: "ok", at: ago(60_000), setup_id: "hash-now:confirm-now" };
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    expect(r.body).toMatchObject({ setup: { state: "no_recent_bookings", window_weeks: 13 } });
  });

  it("run failed after confirming → calculation_failed with a code, never raw error text", async () => {
    m.intel = selfServe({ regions: [{ region_key: "leeds", region_label: "Leeds", state: null, bookings_n: 9, active_supply_n: 3, total_listings: 12, completed_listings: 12, balance_label: "balanced", demand_index: 1, confidence: "medium", suppressed: false }], weeks: [{}] });
    m.lastRun = { status: "failed", at: ago(60_000), code: "connection", setup_id: "hash-now:confirm-now" };
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    expect(r.body).toMatchObject({ setup: { state: "calculation_failed", code: "connection" } });
  });

  it("bad date field: admins get the form back, members do not", async () => {
    m.intel = selfServe();
    m.lastRun = { status: "failed", at: ago(60_000), code: "bad_date_field", setup_id: "hash-now:confirm-now" };
    m.setup = { state: "needs_confirm", catalog_hash: "h1", schema: { tables: [{ name: "secret_payments", columns: [] }] } };
    const admin = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, admin as never);
    expect(admin.body).toMatchObject({ setup: { state: "calculation_failed", form: { state: "needs_confirm" } } });
    m.rpcError = { code: "42501", message: "not admin" };
    const member = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, member as never);
    expect(JSON.stringify(member.body)).not.toContain("secret_payments");
  });

  it("rows from a run for a DIFFERENT setup never display as current (reconnect to an earlier-confirmed DB)", async () => {
    m.intel = selfServe({ regions: [{ region_key: "york", region_label: "York", state: null, bookings_n: 9, active_supply_n: 3, total_listings: 12, completed_listings: 12, balance_label: "balanced", demand_index: 1, confidence: "medium", suppressed: false }], weeks: [{}] });
    m.lastRun = { status: "ok", at: ago(60_000), setup_id: "mysql-hash:confirm-later" };
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    expect(r.body).toMatchObject({ setup: { state: "waiting_first_run" } });
  });

  it("fresh rows after confirming → the real dashboard, no setup", async () => {
    m.intel = selfServe({ regions: [{ region_key: "leeds", region_label: "Leeds", state: null, bookings_n: 9, active_supply_n: 3, total_listings: 12, completed_listings: 12, balance_label: "balanced", demand_index: 1, confidence: "medium", suppressed: false }, { region_key: "__other__", region_label: "Other locations", state: null, bookings_n: 2, active_supply_n: 1, total_listings: null, completed_listings: null, balance_label: "not_compared", demand_index: null, confidence: "medium", suppressed: true }], weeks: [{}] });
    m.lastRun = { status: "ok", at: ago(1000), setup_id: "hash-now:confirm-now" };
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    const body = r.body as Record<string, unknown>;
    expect(body.setup).toBeUndefined();
    expect(body.regions).toHaveLength(2);
    expect(body.states).toEqual([
      expect.objectContaining({ state: "Leeds", geo_label: "Leeds", bookings_n: 9, completed_listings: 12, balance_label: "balanced" }),
      expect.objectContaining({ state: "Other locations", balance_label: "insufficient_data" }),
    ]);
    expect(body.us_total).toEqual(body.total);
  });

  const NEEDS = {
    state: "needs_confirm",
    catalog_hash: "h1",
    proposed: { bookings: { table: "orders" } },
    schema: { tables: [{ name: "secret_payments", columns: ["card_last4"] }] },
  };

  it("admin gets the confirm form with schema names (gate checked with the USER token)", async () => {
    m.setup = NEEDS;
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    expect(m.rpcCalls).toEqual([
      { token: "tok-1", fn: "_assert_tenant_admin", args: { p_tenant_id: "t-own" } },
    ]);
    expect(JSON.stringify(r.body)).toContain("secret_payments");
  });

  it("a member gets needs_admin and NO table/column names", async () => {
    m.setup = NEEDS;
    m.rpcError = { code: "42501", message: "not admin" };
    const r = res();
    await marketplaceIntelligenceDashboard({ query: {} } as never, r as never);
    expect(r.body).toMatchObject({ setup: { state: "needs_admin" } });
    expect(JSON.stringify(r.body)).not.toContain("secret_payments");
    expect(JSON.stringify(r.body)).not.toContain("h1");
  });
});
