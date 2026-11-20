import { describe, expect, it, vi } from "vitest";
import type { SiteRow } from "@/services/sites/contract";
import type { ShardRow } from "../contract";
import { REQUIRED_SHARD_SCHEMA, V2_SHARD_SCHEMA, isSiteDatabaseCapacityError } from "../contract";
import {
  createTestSiteWith,
  destroyTestSiteWith,
  randomPreviewLabel,
  sweepTestSitesWith,
  testSiteOwnerLinkWith,
  TestSiteRefused,
  TestSiteUnavailable,
  type TestSiteDeps,
} from "../test-site";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const LIVE_SITE = "22222222-2222-4222-8222-222222222222";
const LIVE_SHARD = "33333333-3333-4333-8333-333333333333";
const VSHARD = "44444444-4444-4444-8444-444444444444";
const TEST_ID = "55555555-5555-4555-8555-555555555555";
const USER = "66666666-6666-4666-8666-666666666666";
const VREF = "validationrefabcdefg";
const DOMAIN = "zavi-preview.dev";
const LABEL = "abcdefghijklmnopqrstuvwxyz";
const HOST = `${LABEL}.${DOMAIN}`;
const DEPLOY = "d012345678-0a1b2c3d";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const EXPIRES = "2026-10-01T12:15:00.000Z";

const MANIFEST = { schemaVersion: 1, collections: { bookings: { kind: "records", rules: { create: ["anyone"], read: ["owner"] }, fields: {} } } };

type Row = { id: string; tenant_id: string; state: string; preview_host: string; shard_id: string; project_ref: string; url: string; expires_at: string; attempts: number; live_site_id: string; env: string; deploy_id: string };

function vshard(over: Partial<ShardRow> = {}): ShardRow {
  return {
    id: VSHARD, env: "dev", name: "zavi-shard-dev-7", project_ref: VREF, url: `https://${VREF}.supabase.co`, region: "us-west-1",
    state: "full", is_canary: false, schema_version: null, provision_step: "done", max_sites: 2000, site_count: 1,
    created_at: "2026-10-01T00:00:00Z", purpose: "validation", ...over,
  };
}

function world(opts: { shard?: Partial<ShardRow>; createError?: { code: string; message: string }; liveStatus?: string; failAdmin?: boolean; shardSites?: string[]; noOwner?: boolean; orphanUsers?: string[] } = {}) {
  const calls: Array<{ name: string; tenant: string | null; args: Record<string, unknown> }> = [];
  const sql: Array<{ ref: string; q: string }> = [];
  const kv = new Map<string, string>();
  const kvLog: string[] = [];
  const alerts: string[] = [];
  const logs: string[] = [];
  const rows = new Map<string, Row>();
  const authCalls: Array<Record<string, unknown>> = [];
  const shard = vshard(opts.shard);
  const tenantRpc = vi.fn(async (tenant: string, name: string, args: Record<string, unknown>) => {
    calls.push({ name, tenant, args });
    const id = String(args.p_id ?? "");
    const r = rows.get(id);
    switch (name) {
      case "site_test_site_create": {
        if (opts.createError) return { data: null, error: opts.createError };
        rows.set(TEST_ID, {
          id: TEST_ID, tenant_id: tenant, state: "creating", preview_host: String(args.p_preview_host), shard_id: VSHARD, project_ref: VREF,
          url: `https://${VREF}.supabase.co`, expires_at: EXPIRES, attempts: 0, live_site_id: String(args.p_live_site_id), env: "dev", deploy_id: String(args.p_deploy_id),
        });
        return { data: [{ id: TEST_ID, shard_id: VSHARD, project_ref: VREF, url: `https://${VREF}.supabase.co`, expires_at: EXPIRES }], error: null };
      }
      case "site_test_site_activate":
        if (r) r.state = "active";
        return { data: true, error: null };
      case "site_test_site_get":
        return { data: r && r.tenant_id === tenant ? [r] : [], error: null };
      case "site_test_site_destroy_begin":
        if (!r || r.tenant_id !== tenant) return { data: [], error: null };
        if (r.state === "creating" || r.state === "active") r.state = "destroying";
        return { data: [r], error: null };
      case "site_test_site_destroyed":
        if (r?.state === "destroying") {
          r.state = "destroyed";
          return { data: true, error: null };
        }
        return { data: false, error: null };
      case "site_test_site_failed":
        if (r) r.attempts++;
        return { data: r?.attempts ?? 0, error: null };
      default:
        throw new Error(`unexpected tenant rpc ${name}`);
    }
  });
  const platform = { due: [] as Array<{ id: string; tenant_id: string; state: string }>, stats: { active: 0, overdue: 0, stuck: 0 } as Record<string, number> };
  const platformRpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, tenant: null, args });
    if (name === "site_test_site_due") return { data: platform.due, error: null };
    if (name === "site_test_site_stats") return { data: platform.stats, error: null };
    if (name === "site_test_site_states") {
      const ids = args.p_ids as string[];
      return { data: ids.filter((i) => rows.has(i)).map((i) => ({ id: i, tenant_id: rows.get(i)!.tenant_id, state: rows.get(i)!.state })), error: null };
    }
    throw new Error(`unexpected platform rpc ${name}`);
  });
  const deps: TestSiteDeps = {
    tenantRpc,
    platformRpc,
    registry: {
      get: async (id: string) => (id === VSHARD ? shard : id === LIVE_SHARD ? ({ ...vshard(), id: LIVE_SHARD, purpose: "pool", state: "open", region: "us-east-1" } as ShardRow) : null),
      list: async () => [shard],
    },
    sql: {
      async query(ref, q) {
        sql.push({ ref, q });
        if (q.includes("to_regclass('zsite.migrations')")) return [{ present: true }];
        if (q.startsWith("select version from zsite.migrations")) return [{ version: REQUIRED_SHARD_SCHEMA }, { version: V2_SHARD_SCHEMA }];
        if (q.includes("insert into zsite.sites")) return [{ status: "active" }];
        if (q.includes("as sites,")) return [{ sites: 0, collections: 0, records: 0, identities: 0, members: 0, quotas: 0, usage: 0 }];
        if (q.includes("from zsite.members where site_id")) return [{ ok: 1 }];
        if (q.startsWith("select site_id::text as site_id from zsite.sites")) return (opts.shardSites ?? []).map((site_id) => ({ site_id }));
        if (q.includes("from auth.users u")) return (opts.orphanUsers ?? []).map((id) => ({ id }));
        return [];
      },
    },
    storage: { list: async () => [], remove: async () => undefined },
    auth: {
      async ensureFounderAdmin(i) {
        authCalls.push({ op: "admin", ...i });
        if (opts.failAdmin) throw new Error("broker down");
        return { user_id: USER };
      },
      async ownerMagicLink(i) {
        authCalls.push({ op: "link", ...i });
        return `https://${HOST}/api/auth/callback?type=magiclink&token_hash=SECRETHASH`;
      },
      async deleteAuthUser(i) {
        authCalls.push({ op: "delete", ...i });
      },
    },
    manifest: {
      validateManifest: (raw) => ((raw as { bad?: boolean })?.bad ? { ok: false, errors: ["collections.x: bad"] } : { ok: true, value: raw, hash: "hash-1" }),
      diffManifest: () => [],
    },
    kv: {
      async get(k) {
        return kv.get(k) ?? null;
      },
      async put(k, v) {
        kvLog.push(`put:${k}`);
        kv.set(k, v);
      },
      async delete(k) {
        kvLog.push(`delete:${k}`);
        kv.delete(k);
      },
    },
    getSite: async (t, id) =>
      t === TENANT && id === LIVE_SITE
        ? ({ id: LIVE_SITE, tenant_id: TENANT, hostname: "acme.zaviagent.com", owner_email: opts.noOwner ? null : "founder@acme.com", status: opts.liveStatus ?? "live", shard_id: LIVE_SHARD, backend_mode: "pooled" } as unknown as SiteRow)
        : null,
    env: () => "dev",
    previewDomain: () => DOMAIN,
    ensureRouting: async () => undefined,
    randomLabel: () => LABEL,
    now: () => NOW,
    log: (l) => logs.push(l),
    alert: async (code, msg) => {
      alerts.push(`${code}: ${msg}`);
    },
  };
  return { deps, calls, sql, kv, kvLog, alerts, logs, rows, authCalls, platform };
}

const input = (over: Record<string, unknown> = {}) => ({ tenant_id: TENANT, live_site_id: LIVE_SITE, manifestRaw: MANIFEST, deploy_id: DEPLOY, ...over });

describe("randomPreviewLabel", () => {
  it("is 26 lowercase base32 chars and not repeated", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const l = randomPreviewLabel();
      expect(l).toMatch(/^[a-z2-7]{26}$/);
      seen.add(l);
    }
    expect(seen.size).toBe(200);
  });
});

describe("createTestSite", () => {
  it("applies the candidate contract to a NEW site id on the validation shard and binds the preview host", async () => {
    const w = world();
    const h = await createTestSiteWith(w.deps, input());
    expect(h).toEqual({
      test_site_id: TEST_ID, preview_host: HOST, owner_email: `gate-owner@${HOST}`, expires_at: EXPIRES,
      owner_login: `https://${HOST}/api/auth/callback?type=magiclink&token_hash=SECRETHASH`,
      customer_login: null,
    });
    const create = w.calls.find((c) => c.name === "site_test_site_create")!;
    expect(create).toMatchObject({ tenant: TENANT, args: { p_live_site_id: LIVE_SITE, p_env: "dev", p_region: "us-east-1", p_preview_host: HOST, p_deploy_id: DEPLOY, p_ttl_seconds: 900 } });
    expect(w.sql.every((s) => s.ref === VREF)).toBe(true);
    expect(w.sql.some((s) => s.q.includes(LIVE_SITE))).toBe(false);
    expect(w.sql.some((s) => s.q.includes(`insert into zsite.sites (site_id) values ('${TEST_ID}'::uuid)`))).toBe(true);
    expect(w.sql.some((s) => s.q.includes("bookings") && s.q.includes(TEST_ID))).toBe(true);
    expect(w.authCalls[0]).toMatchObject({ op: "admin", site_id: TEST_ID, email: `gate-owner@${HOST}`, shard: { id: VSHARD, project_ref: VREF } });
    expect(w.authCalls[1]).toMatchObject({ op: "link", site_id: TEST_ID, redirect_to: `https://${HOST}/` });
    const rec = JSON.parse(w.kv.get(`preview:${HOST}`)!);
    expect(rec).toEqual({ v: 1, hostname: "acme.zaviagent.com", test_site_id: TEST_ID, deploy_id: DEPLOY, exp: Date.parse(EXPIRES) / 1000, shard_id: VREF, shard_url: `https://${VREF}.supabase.co` });
    expect(w.kvLog.some((k) => k.startsWith("put:host:"))).toBe(false);
    expect(w.calls.map((c) => c.name)).toEqual(["site_test_site_create", "site_test_site_activate"]);
    expect(w.rows.get(TEST_ID)!.state).toBe("active");
    expect(w.logs.join("\n")).not.toContain("SECRETHASH");
  });

  it("makes a signed-up CUSTOMER of the test site (owner as the actor) and mints its link, never logging it", async () => {
    const w = world();
    const customerCalls: Array<Record<string, unknown>> = [];
    w.deps.auth = {
      ...w.deps.auth!,
      async ensureCustomer(i) {
        customerCalls.push({ op: "customer", ...i });
        return { user_id: "cust-1" };
      },
      async customerMagicLink(i) {
        customerCalls.push({ op: "customer-link", ...i });
        return `https://${HOST}/api/auth/callback?type=magiclink&token_hash=CUSTOMERHASH`;
      },
    };
    const h = await createTestSiteWith(w.deps, input());
    expect(h.customer_login).toBe(`https://${HOST}/api/auth/callback?type=magiclink&token_hash=CUSTOMERHASH`);
    expect(customerCalls[0]).toMatchObject({
      op: "customer", site_id: TEST_ID, email: `gate-customer@${HOST}`, admin_email: `gate-owner@${HOST}`, shard: { project_ref: VREF },
    });
    expect(customerCalls[1]).toMatchObject({ op: "customer-link", site_id: TEST_ID, email: `gate-customer@${HOST}`, redirect_to: `https://${HOST}/` });
    expect(w.logs.join("\n")).not.toContain("CUSTOMERHASH");
  });

  it("no owner means no customer either (the owner is the customer's actor)", async () => {
    const w = world({ noOwner: true });
    const ensureCustomer = vi.fn(async () => ({ user_id: "cust-1" }));
    w.deps.auth = { ...w.deps.auth!, ensureCustomer, customerMagicLink: vi.fn(async () => "x") };
    const h = await createTestSiteWith(w.deps, input());
    expect(h.customer_login).toBeNull();
    expect(ensureCustomer).not.toHaveBeenCalled();
  });

  it("an invalid candidate manifest is refused before anything is created", async () => {
    const w = world();
    await expect(createTestSiteWith(w.deps, input({ manifestRaw: { bad: true } }))).rejects.toBeInstanceOf(TestSiteRefused);
    expect(w.calls).toHaveLength(0);
    expect(w.sql).toHaveLength(0);
  });

  it("refuses a bad deploy id, a foreign or missing live site, and a site that is going away", async () => {
    await expect(createTestSiteWith(world().deps, input({ deploy_id: "../x" }))).rejects.toBeInstanceOf(TestSiteRefused);
    await expect(createTestSiteWith(world().deps, input({ tenant_id: OTHER_TENANT }))).rejects.toThrow(/site not found/);
    await expect(createTestSiteWith(world({ liveStatus: "deleting" }).deps, input())).rejects.toThrow(/deleting/);
  });

  it("no validation capacity is a retryable unavailability with an alert, never the live site", async () => {
    const w = world({ createError: { code: "53400", message: "no validation capacity in dev" } });
    const e = await createTestSiteWith(w.deps, input()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TestSiteUnavailable);
    expect(isSiteDatabaseCapacityError(e)).toBe(true);
    expect(w.alerts.join()).toMatch(/sites\.test_sites\.no_capacity/);
    expect(w.sql).toHaveLength(0);
  });

  it("a non-validation shard is refused and the half-made test site is destroyed", async () => {
    const w = world({ shard: { purpose: "pool", state: "open" } });
    await expect(createTestSiteWith(w.deps, input())).rejects.toBeInstanceOf(TestSiteUnavailable);
    expect(w.rows.get(TEST_ID)!.state).toBe("destroyed");
    expect(w.kv.has(`preview:${HOST}`)).toBe(false);
  });

  it("a failure mid-create destroys everything it made (KV, shard rows) and rethrows", async () => {
    const w = world({ failAdmin: true });
    await expect(createTestSiteWith(w.deps, input())).rejects.toBeInstanceOf(TestSiteUnavailable);
    const r = w.rows.get(TEST_ID)!;
    expect(r.state).toBe("destroyed");
    expect(w.sql.some((s) => s.q.includes(`update zsite.sites set status = 'deleting' where site_id = '${TEST_ID}'::uuid`))).toBe(true);
    expect(w.sql.some((s) => s.q.includes(`delete from zsite.sites where site_id = '${TEST_ID}'::uuid`))).toBe(true);
  });

  it("without a preview domain or the auth broker it is unavailable (no fallback)", async () => {
    const a = world();
    a.deps.previewDomain = () => null;
    await expect(createTestSiteWith(a.deps, input())).rejects.toThrow(/SITE_PREVIEW_DOMAIN/);
    const b = world();
    b.deps.auth = null;
    await expect(createTestSiteWith(b.deps, input())).rejects.toBeInstanceOf(TestSiteUnavailable);
    expect(a.calls.length + b.calls.length).toBe(0);
  });

  it("no live owner email = no test owner and owner_login null; the live founder's email is never used", async () => {
    const w = world({ noOwner: true });
    const h = await createTestSiteWith(w.deps, input());
    expect(h).toMatchObject({ owner_login: null, owner_email: null, preview_host: HOST });
    expect(w.authCalls).toHaveLength(0);
    const v = world();
    await createTestSiteWith(v.deps, input());
    expect(JSON.stringify(v.authCalls)).not.toContain("founder@acme.com");
  });

  it("waits until the edge sees the preview host; gives up (and cleans up) when it never does", async () => {
    const w = world();
    let probes = 0;
    let clock = NOW;
    w.deps.now = () => clock;
    w.deps.sleep = async (ms) => { clock += ms; };
    w.deps.edgeReady = async (host) => (expect(host).toBe(HOST), ++probes >= 3);
    await createTestSiteWith(w.deps, input());
    expect(probes).toBe(3);
    expect(w.rows.get(TEST_ID)!.state).toBe("active");
    const v = world();
    let c2 = NOW;
    v.deps.now = () => c2;
    v.deps.sleep = async (ms) => { c2 += ms; };
    v.deps.edgeReady = async () => false;
    await expect(createTestSiteWith(v.deps, input())).rejects.toThrow(/not visible at the edge/);
    expect(v.rows.get(TEST_ID)!.state).toBe("destroyed");
    expect(v.kv.has(`preview:${HOST}`)).toBe(false);
  });

  it("a create past its deadline stops before adding identities and cleans up", async () => {
    const w = world();
    let clock = NOW;
    w.deps.now = () => clock;
    const q = w.deps.sql.query;
    w.deps.sql = { query: async (ref, sql) => { if (sql.includes("from zsite.site_contracts")) clock += 11 * 60_000; return q(ref, sql); } };
    await expect(createTestSiteWith(w.deps, input())).rejects.toThrow(/timed out before owner/);
    expect(w.authCalls).toHaveLength(0);
    expect(w.rows.get(TEST_ID)!.state).toBe("destroyed");
  });

  it("clamps the TTL", async () => {
    const w = world();
    await createTestSiteWith(w.deps, input({ ttl: 999_999 }));
    expect(w.calls[0].args.p_ttl_seconds).toBe(3600);
    const v = world();
    await createTestSiteWith(v.deps, input({ ttl: 1 }));
    expect(v.calls[0].args.p_ttl_seconds).toBe(300);
  });
});

describe("destroyTestSite", () => {
  it("removes the edge binding, then the shard data and credentials, then frees the slot; idempotent", async () => {
    const w = world();
    await createTestSiteWith(w.deps, input());
    w.sql.length = 0;
    expect(await destroyTestSiteWith(w.deps, { tenant_id: TENANT, test_site_id: TEST_ID })).toBe("destroyed");
    expect(w.kv.has(`preview:${HOST}`)).toBe(false);
    expect(w.sql[0].q).toContain(`update zsite.sites set status = 'deleting' where site_id = '${TEST_ID}'::uuid`);
    expect(w.sql.every((s) => s.ref === VREF && !s.q.includes(LIVE_SITE))).toBe(true);
    expect(await destroyTestSiteWith(w.deps, { tenant_id: TENANT, test_site_id: TEST_ID })).toBe("already");
  });

  it("another tenant cannot destroy (or even see) the test site", async () => {
    const w = world();
    await createTestSiteWith(w.deps, input());
    expect(await destroyTestSiteWith(w.deps, { tenant_id: OTHER_TENANT, test_site_id: TEST_ID })).toBe("absent");
    expect(w.rows.get(TEST_ID)!.state).toBe("active");
    expect(w.kv.has(`preview:${HOST}`)).toBe(true);
  });

  it("never deletes a preview record that names another test site", async () => {
    const w = world();
    await createTestSiteWith(w.deps, input());
    w.kv.set(`preview:${HOST}`, JSON.stringify({ v: 1, test_site_id: "77777777-7777-4777-8777-777777777777" }));
    await destroyTestSiteWith(w.deps, { tenant_id: TENANT, test_site_id: TEST_ID });
    expect(w.kv.has(`preview:${HOST}`)).toBe(true);
  });

  it("a failed destroy is recorded (attempts) and rethrown; the row stays destroying for the sweeper", async () => {
    const w = world();
    await createTestSiteWith(w.deps, input());
    w.deps.storage = { list: async () => { throw new Error("storage down"); }, remove: async () => undefined };
    await expect(destroyTestSiteWith(w.deps, { tenant_id: TENANT, test_site_id: TEST_ID })).rejects.toThrow(/storage down/);
    expect(w.rows.get(TEST_ID)).toMatchObject({ state: "destroying", attempts: 1 });
  });
});

describe("testSiteOwnerLink", () => {
  it("mints a fresh link for an active test site only", async () => {
    const w = world();
    await createTestSiteWith(w.deps, input());
    await expect(testSiteOwnerLinkWith(w.deps, { tenant_id: TENANT, test_site_id: TEST_ID })).resolves.toContain(HOST);
    await expect(testSiteOwnerLinkWith(w.deps, { tenant_id: OTHER_TENANT, test_site_id: TEST_ID })).rejects.toBeInstanceOf(TestSiteRefused);
    w.deps.now = () => Date.parse(EXPIRES) + 1;
    await expect(testSiteOwnerLinkWith(w.deps, { tenant_id: TENANT, test_site_id: TEST_ID })).rejects.toBeInstanceOf(TestSiteRefused);
  });
});

describe("sweepTestSites", () => {
  it("destroys due test sites, purges orphans on validation shards, reports metrics and alerts on leaks", async () => {
    const ORPHAN = "88888888-8888-4888-8888-888888888888";
    const w = world({ shardSites: [TEST_ID, ORPHAN] });
    await createTestSiteWith(w.deps, input());
    w.platform.due = [{ id: TEST_ID, tenant_id: TENANT, state: "active" }];
    w.platform.stats = { active: 0, overdue: 2, stuck: 1, leaked: 2 };
    const r = await sweepTestSitesWith(w.deps);
    expect(r).toMatchObject({ due: 1, destroyed: 1, failed: 0, orphans: 2, orphans_purged: 2, leak: 2 });
    expect(w.sql.some((s) => s.q.includes(`update zsite.sites set status = 'deleting' where site_id = '${ORPHAN}'::uuid`))).toBe(true);
    expect(w.alerts.some((a) => a.startsWith("sites.test_sites.leak"))).toBe(true);
    expect(w.logs.some((l) => l.includes("event=metrics") && l.includes("leak=2"))).toBe(true);
  });

  it("deletes leaked auth users (no identity) on validation shards, whatever the create timing", async () => {
    const LEAKED = "abababab-0000-4000-8000-0000000000ab";
    const w = world({ orphanUsers: [LEAKED] });
    const r = await sweepTestSitesWith(w.deps);
    expect(r).toMatchObject({ orphan_users: 1, orphan_users_deleted: 1, leak: 0 });
    expect(w.authCalls).toEqual([expect.objectContaining({ op: "delete", auth_user_id: LEAKED, shard: expect.objectContaining({ project_ref: VREF }) })]);
    expect(w.alerts.some((a) => a.startsWith("sites.test_sites.leak"))).toBe(true);
    expect(w.sql.find((s) => s.q.includes("from auth.users u"))!.q).toMatch(/not exists \(select 1 from zsite\.identities/);
  });

  it("a live (not destroyed) test site on the shard is never purged as an orphan", async () => {
    const w = world({ shardSites: [TEST_ID] });
    await createTestSiteWith(w.deps, input());
    const r = await sweepTestSitesWith(w.deps);
    expect(r.orphans).toBe(0);
    expect(w.rows.get(TEST_ID)!.state).toBe("active");
    expect(w.alerts).toHaveLength(0);
  });

  it("never throws when the DB is unreachable", async () => {
    const w = world();
    w.deps.platformRpc = async () => ({ data: null, error: { message: "down" } });
    const r = await sweepTestSitesWith(w.deps);
    expect(r.failed).toBe(1);
  });
});
