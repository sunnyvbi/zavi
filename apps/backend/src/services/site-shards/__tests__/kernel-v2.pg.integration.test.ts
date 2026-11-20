import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShardSql } from "../contract";
import { EMPTY_SITE_CONTRACT, type CollectionDef, type SiteContractDef } from "../contract";
import { applyPendingMigrations, loadShardMigrations } from "../migrations";
import { planSite } from "../collections-plan";
import { applySitePlanSql, readCollectionsV2, readSiteContract, refusalFromError, roleHolders } from "../apply-v2";
import { createSqlSiteImporter, exportSiteV2, exportSiteV2Lines, hashSite, type ExportSource } from "../export-v2";
import { ensureShardSite, shardSiteDrained, suspendShardSite, unsuspendShardSite } from "../shard-ops";
import { applyQuotaOverrides } from "../site-settings";
import { collectionsOf, siteContractOf, uncarriedParts } from "../manifest-adapter";
import { defValue } from "../collections-plan";

const ON = process.env.SITE_SHARDS_PG === "1";
const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = Number(process.env.SITE_SHARDS_PG_PORT ?? 55464);
const SHARD_SQL = process.env.SITE_SHARD_SQL_DIR ?? "";
const REPO = resolve(__dirname, "../../../../../..");
const MIG = join(REPO, "supabase/migrations");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgClient = any;
const req = createRequire(__filename);
let dir = "";
const open: PgClient[] = [];
const T1 = "aaaaaaaa-0000-4000-8000-00000000000a";
const T2 = "bbbbbbbb-0000-4000-8000-00000000000b";

async function client(db: string): Promise<PgClient> {
  const { Client } = req("pg");
  const c = new Client({ host: "localhost", port: PORT, user: "postgres", database: db });
  await c.connect();
  open.push(c);
  return c;
}

describe.skipIf(!ON)("K4 control plane on a throwaway Postgres 17", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "k4-pg-"));
    execFileSync(join(PGBIN, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust"], { stdio: "ignore" });
    execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${PORT} -c listen_addresses=localhost -c max_connections=60`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
    const root = await client("postgres");
    for (const db of ["zavi", "pooled", "dedicated"]) await root.query(`create database ${db}`);
  }, 60_000);

  afterAll(async () => {
    for (const c of open) await c.end().catch(() => undefined);
    if (dir) {
      try {
        execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
      } catch {
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("Zavi DB: 20261010120000_site_graduation.sql", () => {
    let z: PgClient;
    let shardId = "";
    const rpc = async (name: string, args: Record<string, unknown>, c: PgClient = z) => {
      const keys = Object.keys(args);
      await c.query("begin; set local role service_role");
      try {
        const r = await c.query(
          `select to_jsonb(x) as j from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) x`,
          keys.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])),
        );
        await c.query("commit");
        return r.rows.map((x: { j: unknown }) => x.j);
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      }
    };
    const newSite = async (tenant: string) => {
      const run = (await z.query("insert into public.conductor_runs (id, tenant_id) values (gen_random_uuid(), $1) returning id", [tenant])).rows[0].id;
      const id = (await z.query("select (public.site_get_or_create_for_run($1, $2, 'Shop', null, '-dev', 'zaviagent.com')).id", [tenant, run])).rows[0].id as string;
      await z.query("select public.site_backend_init_static($1, $2)", [tenant, id]);
      return id;
    };
    const pooledSite = async (tenant = T1) => {
      const id = await newSite(tenant);
      await z.query("select * from public.site_backend_place($1, $2, 'dev')", [tenant, id]);
      return id;
    };
    const verified = async (site: string, tenant = T1) => {
      await z.query("update public.sites set supabase_project_ref = 'dedicatedref0001' where id = $1", [site]);
      await rpc("site_graduation_request", { p_tenant_id: tenant, p_site_id: site, p_reason: "capability", p_capabilities: ["payments"] });
      const k = (await rpc("site_kernel_register", { p_tenant_id: tenant, p_site_id: site, p_env: "dev", p_region: "us-west-1" }))[0];
      await rpc("site_shard_update", { p_id: k.id, p_patch: { provision_step: "done" } });
      await rpc("site_kernel_ready", { p_tenant_id: tenant, p_site_id: site });
      for (const [a, b, patch] of [
        ["requested", "project_ready", { target_project_ref: "dedicatedref0001", target_url: "https://dedicatedref0001.supabase.co" }],
        ["project_ready", "suspended", {}],
        ["suspended", "imported", { sha256: "a".repeat(64), counts: { records: 3 } }],
        ["imported", "verified", {}],
      ] as const) {
        expect((await rpc("site_graduation_advance", { p_tenant_id: tenant, p_site_id: site, p_from: a, p_to: b, p_patch: patch }))[0]?.state).toBe(b);
      }
      return k;
    };
    const binding = { shard_id: "dedicatedref0001", shard_url: "https://dedicatedref0001.supabase.co", status: "active", manifest_hash: "mh" };

    beforeAll(async () => {
      z = await client("zavi");
      await z.query(readFileSync(join(__dirname, "sql/zavi-db-stubs.sql"), "utf8"));
      await z.query(readFileSync(join(MIG, "20261008090000_sites.sql"), "utf8"));
      await z.query(readFileSync(join(MIG, "20261010090000_site_shards.sql"), "utf8"));
      await z.query(readFileSync(join(MIG, "20261010120000_site_graduation.sql"), "utf8"));
      await z.query(readFileSync(join(MIG, "20261010120000_site_graduation.sql"), "utf8"));
      await z.query("insert into public.tenants values ($1), ($2)", [T1, T2]);
      const r = await rpc("site_shard_register", { p_env: "dev", p_name: "zavi-shard-dev-1", p_region: "us-west-1", p_is_canary: false });
      shardId = r[0].id;
      await rpc("site_shard_update", { p_id: shardId, p_patch: { project_ref: "shardref0001", url: "https://shardref0001.supabase.co", provision_step: "done", state: "open" } });
    }, 60_000);

    it("anon / authenticated cannot call any graduation RPC or read the tables", async () => {
      for (const role of ["anon", "authenticated"]) {
        for (const call of [
          `select public.site_graduation_request('${T1}', gen_random_uuid(), 'founder', '{}')`,
          `select public.site_graduation_switch('${T1}', gen_random_uuid(), 0, '{}'::jsonb, now())`,
          `select public.site_backend_dedicate_static('${T1}', gen_random_uuid(), '{}')`,
          `select public.site_graduation_due(10)`,
          `select public.site_member_role_audit_record('${T1}', gen_random_uuid(), 'h', 'shardref0001', 1)`,
          "select * from public.site_graduations",
          "select * from public.site_member_role_events",
        ]) {
          await z.query(`begin; set local role ${role}`);
          await expect(z.query(call)).rejects.toThrow(/permission denied/);
          await z.query("rollback");
        }
      }
    });

    it("build time: a static site becomes dedicated; a placed (pooled) site is refused (it must graduate)", async () => {
      const s = await newSite(T1);
      const row = (await rpc("site_backend_dedicate_static", { p_tenant_id: T1, p_site_id: s, p_capabilities: ["payments"] }))[0];
      expect(row.backend_mode).toBe("dedicated");
      expect((await rpc("site_backend_dedicate_static", { p_tenant_id: T1, p_site_id: s, p_capabilities: [] }))[0].backend_mode).toBe("dedicated");
      expect((await z.query("select state, reason from public.site_graduations where site_id = $1", [s])).rows[0]).toEqual({ state: "build_dedicated", reason: "capability" });
      await expect(z.query("select * from public.site_backend_place($1, $2, 'dev')", [T1, s])).rejects.toThrow(/dedicated/);
      const p = await pooledSite();
      await expect(rpc("site_backend_dedicate_static", { p_tenant_id: T1, p_site_id: p, p_capabilities: [] })).rejects.toThrow(/must graduate/);
      const s2 = await newSite(T1);
      await expect(rpc("site_backend_dedicate_static", { p_tenant_id: T2, p_site_id: s2, p_capabilities: [] })).rejects.toThrow(/not found/);
      expect((await z.query("select backend_mode from public.sites where id = $1", [s2])).rows[0].backend_mode).toBe("static");
    });

    it("request: pooled only, idempotent, tenant-checked", async () => {
      const s = await newSite(T1);
      await expect(rpc("site_graduation_request", { p_tenant_id: T1, p_site_id: s, p_reason: "founder", p_capabilities: [] })).rejects.toThrow(/not pooled/);
      const p = await pooledSite();
      await expect(rpc("site_graduation_request", { p_tenant_id: T2, p_site_id: p, p_reason: "founder", p_capabilities: [] })).rejects.toThrow(/not found/);
      const a = (await rpc("site_graduation_request", { p_tenant_id: T1, p_site_id: p, p_reason: "founder", p_capabilities: [] }))[0];
      const b = (await rpc("site_graduation_request", { p_tenant_id: T1, p_site_id: p, p_reason: "load", p_capabilities: [] }))[0];
      expect(a.state).toBe("requested");
      expect(b.reason).toBe("founder");
      expect(a.source_project_ref).toBe("shardref0001");
    });

    it("advance: compare-and-set along the machine only; patch allowlist enforced", async () => {
      const p = await pooledSite();
      await rpc("site_graduation_request", { p_tenant_id: T1, p_site_id: p, p_reason: "founder", p_capabilities: [] });
      expect(await rpc("site_graduation_advance", { p_tenant_id: T1, p_site_id: p, p_from: "project_ready", p_to: "suspended", p_patch: {} })).toEqual([]);
      await expect(rpc("site_graduation_advance", { p_tenant_id: T1, p_site_id: p, p_from: "requested", p_to: "switched", p_patch: {} })).rejects.toThrow(/not a graduation step/);
      await expect(rpc("site_graduation_advance", { p_tenant_id: T1, p_site_id: p, p_from: "requested", p_to: "project_ready", p_patch: { state: "switched" } })).rejects.toThrow(/allowlist/);
      expect(await rpc("site_graduation_advance", { p_tenant_id: T2, p_site_id: p, p_from: "requested", p_to: "project_ready", p_patch: {} })).toEqual([]);
    });

    it("RACE: concurrent claims take ONE lease", async () => {
      const p = await pooledSite();
      await rpc("site_graduation_request", { p_tenant_id: T1, p_site_id: p, p_reason: "founder", p_capabilities: [] });
      const cs = await Promise.all(Array.from({ length: 6 }, () => client("zavi")));
      const rs = await Promise.all(cs.map((c) => rpc("site_graduation_claim", { p_tenant_id: T1, p_site_id: p, p_lease_seconds: 600 }, c)));
      expect(rs.filter((r) => r.length === 1)).toHaveLength(1);
    });

    it("switch: requires verified + the verified target + the expected host_version; then flips everything at once", async () => {
      const p = await pooledSite();
      const before = (await z.query("select host_version, (select site_count from public.site_shards where id = $2) as n from public.sites where id = $1", [p, shardId])).rows[0];
      const args = { p_tenant_id: T1, p_site_id: p, p_expected_host_version: Number(before.host_version), p_binding: binding, p_archive_after: "2026-10-08T00:00:00Z" };
      await rpc("site_graduation_request", { p_tenant_id: T1, p_site_id: p, p_reason: "founder", p_capabilities: [] });
      await expect(rpc("site_graduation_switch", args)).rejects.toThrow(/not verified/);
      await z.query("delete from public.site_graduations where site_id = $1", [p]);
      const kernel = await verified(p);
      expect(kernel).toMatchObject({ project_ref: "dedicatedref0001", dedicated_site_id: p, max_sites: 1 });
      await expect(rpc("site_shard_update", { p_id: kernel.id, p_patch: { state: "open" } })).rejects.toThrow();
      await expect(rpc("site_kernel_register", { p_tenant_id: T2, p_site_id: p, p_env: "dev", p_region: "us-west-1" })).rejects.toThrow(/not found/);
      await expect(rpc("site_graduation_switch", { ...args, p_tenant_id: T2 })).rejects.toThrow(/not found/);
      await expect(rpc("site_graduation_switch", { ...args, p_expected_host_version: Number(before.host_version) + 1 })).rejects.toThrow(/host_version_conflict/);
      await expect(rpc("site_graduation_switch", { ...args, p_binding: { ...binding, shard_id: "attackerref0001", shard_url: "https://attackerref0001.supabase.co" } })).rejects.toThrow(/verified target/);
      const row = (await rpc("site_graduation_switch", args))[0];
      expect(row).toMatchObject({ backend_mode: "dedicated", shard_id: null, kernel_shard_id: kernel.id, gateway_binding: binding, host_version: Number(before.host_version) + 1 });
      expect((await z.query("select site_count from public.site_shards where id = $1", [shardId])).rows[0].site_count).toBe(before.n - 1);
      expect((await z.query("select state from public.site_graduations where site_id = $1", [p])).rows[0].state).toBe("switched");
      const oldBinding = { shard_id: "shardref0001", shard_url: "https://shardref0001.supabase.co", status: "active", manifest_hash: "mh" };
      await expect(rpc("site_host_bump", { p_tenant_id: T1, p_site_id: p, p_set_binding: true, p_binding: oldBinding })).rejects.toThrow(/binding_not_current/);
      expect((await rpc("site_host_bump", { p_tenant_id: T1, p_site_id: p, p_set_binding: true, p_binding: binding }))[0].gateway_binding).toEqual(binding);
      const m = (await rpc("site_shard_record_metrics", { p_id: kernel.id, p_metrics: { records: 1 } }))[0];
      expect(m.state).toBe("full");
      const st = (await rpc("site_backend_settings_set", { p_site_id: p, p_actor_user_id: "33333333-3333-4333-8333-333333333333", p_actor_email: "ops@zavi", p_patch: { max_records: 10 }, p_turnstile_secret: null, p_clear_secret: false }))[0];
      expect(st.shard_id).toBe(kernel.id);
      await expect(rpc("site_graduation_switch", { ...args, p_expected_host_version: row.host_version })).rejects.toThrow(/not verified/);
      await rpc("site_shard_secret_set", { p_shard_id: kernel.id, p_name: "service_key", p_value: "kernel-service-key-xyz" });
      await expect(rpc("site_kernel_retire", { p_tenant_id: T1, p_site_id: p })).rejects.toThrow(/not being deleted/);
      await z.query("update public.sites set status = 'deleting' where id = $1", [p]);
      await expect(rpc("site_kernel_retire", { p_tenant_id: T2, p_site_id: p })).rejects.toThrow(/not found/);
      expect((await rpc("site_kernel_ref", { p_tenant_id: T1, p_site_id: p }))[0]).toBe("dedicatedref0001");
      expect((await rpc("site_kernel_retire", { p_tenant_id: T1, p_site_id: p }))[0]).toBe("dedicatedref0001");
      expect((await z.query("select count(*)::int as n from public.site_shards where id = $1", [kernel.id])).rows[0].n).toBe(0);
      expect((await z.query("select count(*)::int as n from vault.secrets where secret = 'kernel-service-key-xyz'")).rows[0].n).toBe(0);
      expect((await z.query("select kernel_shard_id from public.sites where id = $1", [p])).rows[0].kernel_shard_id).toBeNull();
      expect((await rpc("site_kernel_retire", { p_tenant_id: T1, p_site_id: p }))[0]).toBeNull();
      const pooledOne = await pooledSite();
      await z.query("update public.sites set status = 'deleting' where id = $1", [pooledOne]);
      expect((await rpc("site_kernel_retire", { p_tenant_id: T1, p_site_id: pooledOne }))[0]).toBeNull();
      expect((await z.query("select count(*)::int as n from public.site_shards where id = $1", [shardId])).rows[0].n).toBe(1);
      await expect(rpc("site_graduation_advance", { p_tenant_id: T1, p_site_id: p, p_from: "switched", p_to: "rolled_back", p_patch: {} })).rejects.toThrow(/not a graduation step/);
    });

    it("due lists open graduations; request_by_site derives the tenant from the site row", async () => {
      const p = await pooledSite(T2);
      const r = (await rpc("site_graduation_request_by_site", { p_site_id: p, p_reason: "size" }))[0];
      expect(r).toMatchObject({ tenant_id: T2, reason: "size", state: "requested" });
      await expect(rpc("site_graduation_request_by_site", { p_site_id: p, p_reason: "founder" })).rejects.toThrow(/load \/ size \/ staff/);
      const due = await rpc("site_graduation_due", { p_limit: 200 });
      expect(due.some((d: { site_id: string; tenant_id: string }) => d.site_id === p && d.tenant_id === T2)).toBe(true);
    });

    it("per-site settings: audited, secret only in Vault, public gateway config + host_version bump, no cross-site effect", async () => {
      const a = await pooledSite();
      const b = await pooledSite();
      const before = (await z.query("select id, host_version, gateway_config from public.sites where id = any($1) order by id", [[a, b]])).rows;
      const STAFF = "33333333-3333-4333-8333-333333333333";
      const secret = "0x4AAAAAAA-real-secret";
      await expect(rpc("site_backend_settings_set", { p_site_id: a, p_actor_user_id: STAFF, p_actor_email: "ops@zavi", p_patch: { shard_id: "x" }, p_turnstile_secret: null, p_clear_secret: false })).rejects.toThrow(/allowlist/);
      await expect(rpc("site_backend_settings_set", { p_site_id: a, p_actor_user_id: STAFF, p_actor_email: "ops@zavi", p_patch: { recipient_creates_per_min: 31 }, p_turnstile_secret: null, p_clear_secret: false })).rejects.toThrow(/check constraint/);
      const r = (await rpc("site_backend_settings_set", {
        p_site_id: a, p_actor_user_id: STAFF, p_actor_email: "ops@zavi",
        p_patch: { max_records: 25, max_writes_per_min: 5, turnstile_enabled: false }, p_turnstile_secret: secret, p_clear_secret: false,
      }))[0];
      expect(r).toMatchObject({ site_id: a, tenant_id: T1, max_records: 25, max_writes_per_min: 5, turnstile_enabled: false, turnstile_secret_set: true });
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(r).not.toHaveProperty("turnstile_secret_id");
      const ev = (await z.query("select actor_user_id, changes from public.site_backend_settings_events where site_id = $1", [a])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0].changes).toMatchObject({ max_records: { from: null, to: 25 }, turnstile_enabled: { from: null, to: false }, turnstile_secret: "set" });
      expect(JSON.stringify(ev)).not.toContain(secret);
      expect((await z.query("select count(*)::int as n from vault.secrets where secret = $1", [secret])).rows[0].n).toBe(1);
      expect((await rpc("site_backend_turnstile_secret", { p_site_id: a }))[0]).toBeNull();
      expect(JSON.stringify((await rpc("site_backend_settings_get", { p_site_id: a }))[0])).not.toContain(secret);
      const after = (await z.query("select id, host_version, gateway_config from public.sites where id = any($1) order by id", [[a, b]])).rows;
      const A1 = after.find((x: { id: string }) => x.id === a);
      const B0 = before.find((x: { id: string }) => x.id === b);
      const B1 = after.find((x: { id: string }) => x.id === b);
      expect(A1.gateway_config).toEqual({ turnstile: { enabled: false, site_key: null } });
      expect(Number(A1.host_version)).toBe(Number(before.find((x: { id: string }) => x.id === a).host_version) + 1);
      expect(B1).toEqual(B0);
      expect((await rpc("site_backend_settings_get", { p_site_id: b }))[0]).toBeNull();
      await rpc("site_backend_settings_set", { p_site_id: a, p_actor_user_id: STAFF, p_actor_email: "ops@zavi", p_patch: { turnstile_enabled: true, turnstile_site_key: "0x4AAAAAAAsitekey" }, p_turnstile_secret: null, p_clear_secret: false });
      expect((await rpc("site_backend_turnstile_secret", { p_site_id: a }))[0]).toBe(secret);
      expect((await rpc("site_backend_turnstile_secret", { p_site_id: b }))[0]).toBeNull();
      await rpc("site_backend_settings_set", { p_site_id: a, p_actor_user_id: STAFF, p_actor_email: "ops@zavi", p_patch: { max_records: null, turnstile_enabled: null }, p_turnstile_secret: null, p_clear_secret: true });
      expect((await z.query("select count(*)::int as n from vault.secrets where secret = $1", [secret])).rows[0].n).toBe(0);
      expect((await rpc("site_backend_turnstile_secret", { p_site_id: a }))[0]).toBeNull();
      expect((await z.query("select gateway_config from public.sites where id = $1", [a])).rows[0].gateway_config).toEqual({ turnstile: { enabled: true, site_key: "0x4AAAAAAAsitekey" } });
      await rpc("site_backend_settings_set", { p_site_id: a, p_actor_user_id: STAFF, p_actor_email: "ops@zavi", p_patch: {}, p_turnstile_secret: secret, p_clear_secret: false });
      expect((await rpc("site_backend_turnstile_secret", { p_site_id: a }))[0]).toBe(secret);
      await z.query("update public.sites set status = 'deleting' where id = $1", [a]);
      expect((await rpc("site_backend_turnstile_secret", { p_site_id: a }))[0]).toBeNull();
      for (const role of ["anon", "authenticated"]) {
        for (const call of [`select public.site_backend_settings_get('${a}')`, `select public.site_backend_turnstile_secret('${a}')`]) {
          await z.query(`begin; set local role ${role}`);
          await expect(z.query(call)).rejects.toThrow(/permission denied/);
          await z.query("rollback");
        }
      }
    });

    it("role audit pointer: one row per (site, manifest hash), tenant-checked; the per-member rows live on the shard", async () => {
      const p = await pooledSite();
      expect((await rpc("site_member_role_audit_record", { p_tenant_id: T1, p_site_id: p, p_manifest_hash: "h1", p_shard_ref: "shardref0001", p_demoted: 2 }))[0]).toBe(1);
      expect((await rpc("site_member_role_audit_record", { p_tenant_id: T1, p_site_id: p, p_manifest_hash: "h1", p_shard_ref: "shardref0001", p_demoted: 2 }))[0]).toBe(0);
      await expect(rpc("site_member_role_audit_record", { p_tenant_id: T2, p_site_id: p, p_manifest_hash: "h2", p_shard_ref: "shardref0001", p_demoted: 1 })).rejects.toThrow(/not found/);
      expect((await z.query("select shard_ref, demoted, audit_action from public.site_member_role_events where site_id = $1", [p])).rows).toEqual([
        { shard_ref: "shardref0001", demoted: 2, audit_action: "set_role" },
      ]);
    });
  });

  describe.skipIf(!SHARD_SQL || !existsSync(join(SHARD_SQL, "migrations", "0008_relational_api.sql")) || !existsSync(join(SHARD_SQL, "auth", "1003_member_admin.sql")))("shard side: v2 apply, freeze, export -> import", () => {
    const A = "aaaaaaaa-1111-4000-8000-00000000000a";
    const B = "bbbbbbbb-1111-4000-8000-00000000000b";
    const dbs: Record<string, PgClient> = {};
    const sql: ShardSql = {
      async query(ref, q) {
        const c = dbs[ref];
        let r;
        try {
          r = await c.query(q);
        } catch (e) {
          await c.query("rollback").catch(() => undefined);
          throw e;
        }
        const last = Array.isArray(r) ? r.filter((x: { rows?: unknown[]; command?: string }) => x.rows && x.command === "SELECT").pop() ?? r[r.length - 1] : r;
        return last?.rows ?? [];
      },
    };

    beforeAll(async () => {
      const root = await client("postgres");
      await root.query(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
          if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin noinherit; end if;
        end $$;
        grant anon, authenticated, service_role to authenticator;`);
      for (const ref of ["pooled", "dedicated"]) {
        const c = await client(ref);
        dbs[ref] = c;
        await c.query(`
          create schema storage;
          create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
            file_size_limit bigint, allowed_mime_types text[]);
          create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
            name text not null, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(),
            updated_at timestamptz default now(), unique (bucket_id, name));
          alter table storage.objects enable row level security;
          grant usage on schema storage to anon, authenticated, service_role;
          grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
          create schema auth;
          create table auth.users (id uuid primary key, email text unique, encrypted_password text,
            email_confirmed_at timestamptz, confirmed_at timestamptz generated always as (email_confirmed_at) stored,
            raw_app_meta_data jsonb, is_anonymous boolean default false, created_at timestamptz default now());
          create table auth.identities (provider_id text not null, user_id uuid not null references auth.users (id) on delete cascade,
            identity_data jsonb not null, provider text not null, email text generated always as (lower(identity_data->>'email')) stored,
            id uuid primary key default gen_random_uuid(), unique (provider_id, provider));
          grant usage on schema auth to supabase_auth_admin;
          grant all on auth.users to supabase_auth_admin;
          create table auth.sessions (id uuid primary key, user_id uuid, not_after timestamptz);`);
        const applied = await applyPendingMigrations(sql, ref, loadShardMigrations(SHARD_SQL));
        expect(applied.failed, JSON.stringify(applied.failed)).toBeUndefined();
      }
      for (const s of [A, B]) await ensureShardSite(sql, "pooled", s);
    }, 90_000);

    const col = (name: string, over: Partial<CollectionDef> = {}): CollectionDef => ({
      name,
      kind: "records",
      rules: { list: ["anyone"], get: ["anyone"], create: ["anyone"] },
      schema: { type: "object", properties: { title: { type: "string", maxLength: 80 }, a: { type: "string", maxLength: 20 }, b: { type: "string", maxLength: 20 }, status: { type: "string", maxLength: 20 }, listing_id: { type: "string", maxLength: 36 }, n: { type: "integer" }, cap: { type: "integer" } } },
      fields: {},
      indexes: {},
      recipient: null,
      unique: [],
      states: null,
      references: {},
      ...over,
    });
    const v2 = (over: Partial<SiteContractDef> = {}): SiteContractDef => ({ ...EMPTY_SITE_CONTRACT, schema_version: 2, ...over });
    const baseProps = () => JSON.parse(JSON.stringify(col("x").schema.properties)) as Record<string, Record<string, unknown>>;
    const stateful = (states: CollectionDef["states"]) =>
      col("listings", { states, schema: { type: "object", required: ["status"], properties: { ...baseProps(), status: { type: "string", maxLength: 20, enum: states!.values } } } });
    const referencing = (over: Partial<CollectionDef>, required: string[] = []) =>
      col("requests", { ...over, schema: { type: "object", required, properties: { ...baseProps(), listing_id: { type: "string", maxLength: 36, format: "uuid" } } } });

    async function apply(site: string, desired: CollectionDef[], contract: SiteContractDef, ref = "pooled") {
      const current = await readCollectionsV2(sql, ref, site);
      const cur = await readSiteContract(sql, ref, site);
      const plan = planSite(current, desired, cur ?? EMPTY_SITE_CONTRACT, contract);
      const holders = await roleHolders(sql, ref, site, plan.backfill.removedRoles);
      try {
        await sql.query(ref, applySitePlanSql(site, plan, current, cur, holders));
        return { ok: true as const, plan, holders };
      } catch (e) {
        const r = refusalFromError(e);
        if (!r) throw e;
        if (process.env.K4_DEBUG) console.log("REFUSAL", String((e as Error).message).slice(0, 400));
        return { ok: false as const, refusal: r };
      }
    }
    const ins = (site: string, collection: string, data: object, owner: string | null = null, id?: string) =>
      dbs.pooled.query(
        `insert into zsite.records (site_id, collection, id, owner_id, data) values ($1, $2, coalesce($5::uuid, gen_random_uuid()), $3, $4) returning id`,
        [site, collection, owner, JSON.stringify(data), id ?? null],
      );
    const snapshot = async (site: string) => ({
      cols: await readCollectionsV2(sql, "pooled", site),
      contract: await readSiteContract(sql, "pooled", site),
      data: (await dbs.pooled.query("select id, data from zsite.records where site_id = $1 order by id", [site])).rows,
      members: (await dbs.pooled.query("select user_id, role from zsite.members where site_id = $1 order by user_id", [site])).rows,
    });

    it("shard SQL order: K2's 1003 after K1's 0006-0008; a re-run of 0002 keeps K2's api.session_valid and its grants", async () => {
      const order = loadShardMigrations(SHARD_SQL).map((f) => f.version);
      expect(order.indexOf("1003_member_admin")).toBeGreaterThan(order.indexOf("0008_relational_api"));
      expect(order.indexOf("1004_signup_sessions")).toBeGreaterThan(order.indexOf("0002_api"));
      await dbs.pooled.query(readFileSync(join(SHARD_SQL, "migrations", "0002_api.sql"), "utf8"));
      const r = (await dbs.pooled.query(
        "select to_regprocedure('api.session_valid()') is not null as present, has_function_privilege('authenticated', 'api.session_valid()', 'execute') as granted",
      )).rows[0];
      expect(r).toEqual({ present: true, granted: true });
    });

    it("v2 apply writes the contract + relational fields; re-apply is a no-op", async () => {
      const r = await apply(A, [col("listings"), col("requests")], v2({ roles: ["seller"] }));
      expect(r.ok).toBe(true);
      expect((await readSiteContract(sql, "pooled", A))?.roles).toEqual(["seller"]);
      const again = await apply(A, [col("listings"), col("requests")], v2({ roles: ["seller"] }));
      expect(again.ok && again.plan.changes).toEqual([]);
    });

    it("the contract's full v2 example round-trips through apply: every part is on the shard", async () => {
      const C = "cccccccc-1111-4000-8000-00000000000c";
      await ensureShardSite(sql, "pooled", C);
      const manifest = JSON.parse(readFileSync(join(__dirname, "sql/contract-v2-example.json"), "utf8"));
      expect(uncarriedParts(manifest)).toEqual([]);
      const desired = collectionsOf(manifest);
      const contract = siteContractOf(manifest);
      const r = await apply(C, desired, contract);
      if (!r.ok && process.env.K4_DEBUG) {
        for (const d of desired) {
          const q = (await dbs.pooled.query(
            `select zsite.valid_collection_v2($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) as ok`,
            [d.kind, JSON.stringify(d.rules), JSON.stringify(d.schema), JSON.stringify(d.fields), d.recipient ? JSON.stringify(d.recipient) : null, JSON.stringify(d.unique), d.states ? JSON.stringify(d.states) : null, JSON.stringify(d.references)],
          )).rows[0].ok;
          console.log("V2CHECK", d.name, q);
        }
      }
      expect(r.ok, r.ok ? "" : r.refusal.message).toBe(true);
      const back = await readCollectionsV2(sql, "pooled", C);
      for (const d of desired) {
        const b = back.find((x) => x.name === d.name)!;
        for (const k of ["rules", "schema", "fields", "indexes", "recipient", "unique", "states", "references"] as const) {
          expect(defValue(b, k), `${d.name}.${k}`).toEqual(defValue(d, k));
        }
      }
      expect(await readSiteContract(sql, "pooled", C)).toEqual({
        schema_version: 2, roles: ["seller", "moderator"], capabilities: [], actions: manifest.actions, aggregates: manifest.aggregates,
      });
      const again = await apply(C, desired, contract);
      expect(again.ok && again.plan.changes).toEqual([]);
    });

    it("unique: duplicates refuse with the count and leave the prior contract live; null modes per contract", async () => {
      await ins(A, "requests", { a: "x", b: "1" });
      await ins(A, "requests", { a: "x", b: "1" });
      await ins(A, "requests", { a: "y" });
      await ins(A, "requests", { a: "y" });
      const before = await snapshot(A);
      const r = await apply(A, [col("listings"), col("requests", { unique: [{ fields: ["a", "b"], nulls: "distinct" }] })], v2({ roles: ["seller"] }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refusal.code).toBe("unique_duplicates");
        expect(r.refusal.detail).toMatchObject({ groups: 1, records: 2 });
        expect(r.refusal.message).toMatch(/^2 records in "requests" share the same a \+ b/);
      }
      expect(await snapshot(A)).toEqual(before);
      await dbs.pooled.query("delete from zsite.records where site_id = $1 and collection = 'requests' and data->>'b' = '1'", [A]);
      const nd = await apply(A, [col("listings"), col("requests", { unique: [{ fields: ["a", "b"], nulls: "not_distinct" }] })], v2({ roles: ["seller"] }));
      expect(!nd.ok && nd.refusal.detail).toMatchObject({ groups: 1, records: 2 });
      const d = await apply(A, [col("listings"), col("requests", { unique: [{ fields: ["a", "b"], nulls: "distinct" }] })], v2({ roles: ["seller"] }));
      expect(d.ok).toBe(true);
      await ins(A, "listings", { n: 1 });
      await ins(A, "listings", { n: 1.0 });
      const num = await apply(A, [col("listings", { unique: [{ fields: ["n"], nulls: "distinct" }] }), col("requests", { unique: [{ fields: ["a", "b"], nulls: "distinct" }] })], v2({ roles: ["seller"] }));
      expect(num.ok).toBe(false);
      await dbs.pooled.query("delete from zsite.records where site_id = $1 and collection in ('listings', 'requests')", [A]);
    });

    it("RACE: a record write in flight holds the shard's manifest lock; the apply waits and then sees it", async () => {
      await dbs.pooled.query("delete from zsite.records where site_id = $1 and collection = 'requests'", [A]);
      await ins(A, "requests", { a: "race", b: "1" });
      const writer = await client("pooled");
      await writer.query("begin");
      await writer.query(`insert into zsite.records (site_id, collection, id, data) values ($1, 'requests', gen_random_uuid(), '{"a":"race","b":"1"}')`, [A]);
      let settled = false;
      const applying = apply(A, [col("listings"), col("requests", { unique: [{ fields: ["a", "b"], nulls: "not_distinct" }] })], v2({ roles: ["seller"] })).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await writer.query("commit");
      const r = await applying;
      expect(!r.ok && r.refusal.detail).toMatchObject({ code: "unique_duplicates", records: 2 });
      await dbs.pooled.query("delete from zsite.records where site_id = $1 and data->>'a' = 'race'", [A]);
    });

    it("states: invalid existing values refuse; absent values get the initial state", async () => {
      await ins(A, "listings", { title: "ok", status: "draft" });
      await ins(A, "listings", { title: "no status" });
      await ins(A, "listings", { title: "bad", status: "deleted" });
      const states = { field: "status", values: ["draft", "published"], initial: "draft", transitions: [{ from: "draft", to: "published", principals: ["owner"] }] };
      const before = await snapshot(A);
      const r = await apply(A, [stateful(states), col("requests")], v2({ roles: ["seller"] }));
      expect(!r.ok && r.refusal.code).toBe("invalid_states");
      expect(!r.ok && r.refusal.detail.records).toBe(1);
      expect(await snapshot(A)).toEqual(before);
      await dbs.pooled.query("delete from zsite.records where site_id = $1 and data->>'status' = 'deleted'", [A]);
      expect((await apply(A, [stateful(states), col("requests")], v2({ roles: ["seller"] }))).ok).toBe(true);
      const statuses = (await dbs.pooled.query("select data->>'status' as s from zsite.records where site_id = $1 and collection = 'listings' order by 1", [A])).rows;
      expect(statuses).toEqual([{ s: "draft" }, { s: "draft" }]);
    });

    it("references: broken targets are counted and refused, never nulled; cross-site targets count as broken", async () => {
      const [{ id: live }] = (await ins(A, "listings", { title: "t", status: "draft" }, "cccccccc-0000-4000-8000-00000000000c")).rows;
      await apply(B, [col("listings")], v2());
      const [{ id: other }] = (await ins(B, "listings", { title: "B's" })).rows;
      await ins(A, "requests", { listing_id: live });
      await ins(A, "requests", { listing_id: other });
      await ins(A, "requests", { listing_id: "not-a-uuid" });
      await ins(A, "requests", { title: "no ref" });
      const states = { field: "status", values: ["draft", "published"], initial: "draft", transitions: [] };
      const before = await snapshot(A);
      const r = await apply(A, [stateful(states), referencing({ references: { listing_id: { collection: "listings", on_delete: "restrict" } } })], v2({ roles: ["seller"] }));
      expect(!r.ok && r.refusal.code).toBe("broken_references");
      expect(!r.ok && r.refusal.detail.records).toBe(2);
      expect(await snapshot(A)).toEqual(before);
      await dbs.pooled.query("delete from zsite.records where site_id = $1 and collection = 'requests' and data->>'listing_id' is distinct from $2", [A, live]);
      const ok = await apply(
        A,
        [stateful(states), referencing({ references: { listing_id: { collection: "listings", on_delete: "restrict" } }, recipient: { reference: "listing_id" } }, ["listing_id"])],
        v2({ roles: ["seller"] }),
      );
      expect(ok.ok).toBe(true);
    });

    it("roles: a removed role leaves no member holding it (demoted to user); a moved holder set re-plans", async () => {
      const u1 = "dddddddd-0000-4000-8000-00000000000d";
      const u2 = "eeeeeeee-0000-4000-8000-00000000000e";
      for (const [u, role] of [[u1, "seller"], [u2, "admin"]]) {
        await dbs.pooled.query("insert into zsite.identities (site_id, email_norm, auth_user_id, alias) values ($1, $2, $3, $4)", [A, `${u.slice(0, 4)}@x.io`, u, `al-${u}`]);
        await dbs.pooled.query("insert into zsite.members (site_id, user_id, role) values ($1, $2, $3)", [A, u, role]);
      }
      const cols = await readCollectionsV2(sql, "pooled", A);
      const cur = await readSiteContract(sql, "pooled", A);
      const plan = planSite(cols, cols, cur!, v2({ roles: [] }));
      expect(plan.backfill.removedRoles).toEqual(["seller"]);
      await expect(sql.query("pooled", applySitePlanSql(A, plan, cols, cur, []))).rejects.toThrow(/collections_changed/);
      expect((await dbs.pooled.query("select role from zsite.members where user_id = $1", [u1])).rows[0].role).toBe("seller");
      const holders = await roleHolders(sql, "pooled", A, plan.backfill.removedRoles);
      expect(holders).toEqual([{ user_id: u1, role: "seller" }]);
      await sql.query("pooled", applySitePlanSql(A, plan, cols, cur, holders, "mh-roles"));
      expect((await dbs.pooled.query("select user_id, role from zsite.members where site_id = $1 order by user_id", [A])).rows).toEqual([
        { user_id: u1, role: "user" },
        { user_id: u2, role: "admin" },
      ]);
      expect((await dbs.pooled.query("select actor_id, action, target_id, detail from zsite_auth.member_audit where site_id = $1 and target_id = $2", [A, u1])).rows).toEqual([
        { actor_id: null, action: "set_role", target_id: u1, detail: { from: "seller", to: "user", reason: "role_removed_from_manifest", manifest_hash: "mh-roles" } },
      ]);
    });

    it("quota overrides land on THIS site's zsite.quotas only; null resets to the platform default", async () => {
      const q = async (site: string) => (await dbs.pooled.query("select max_records, max_bytes, max_writes_per_min from zsite.quotas where site_id = $1", [site])).rows[0];
      const b0 = await q(B);
      const r = await applyQuotaOverrides(sql, "pooled", A, { max_records: 25, max_bytes: null, max_writes_per_min: 5, recipient_creates_per_min: 10 });
      expect(r.applied).toBe(true);
      expect(await q(A)).toEqual({ max_records: "25", max_bytes: "52428800", max_writes_per_min: 5 });
      expect(await q(B)).toEqual(b0);
      await dbs.pooled.query("alter table zsite.quotas add column if not exists max_recipient_creates_per_min integer not null default 30");
      const withCap = await applyQuotaOverrides(sql, "pooled", A, { max_records: 25, max_bytes: null, max_writes_per_min: 5, recipient_creates_per_min: 10 });
      expect(withCap.recipient_cap).toBe(true);
      expect((await dbs.pooled.query("select max_recipient_creates_per_min as c from zsite.quotas where site_id = $1", [A])).rows[0].c).toBe(10);
      expect((await dbs.pooled.query("select max_recipient_creates_per_min as c from zsite.quotas where site_id = $1", [B])).rows[0].c).toBe(30);
      await applyQuotaOverrides(sql, "pooled", A, { max_records: null, max_bytes: null, max_writes_per_min: null, recipient_creates_per_min: null });
      expect((await dbs.pooled.query("select max_recipient_creates_per_min as c from zsite.quotas where site_id = $1", [A])).rows[0].c).toBe(30);
      expect(await q(A)).toEqual({ max_records: "10000", max_bytes: "52428800", max_writes_per_min: 600 });
    });

    it("freeze + drain: a transaction open before the freeze holds the drain until it ends", async () => {
      const other = await client("pooled");
      await other.query("begin");
      await other.query("select 1");
      const frozen = await suspendShardSite(sql, "pooled", B);
      expect(await shardSiteDrained(sql, "pooled", frozen)).toBe(false);
      await other.query("commit");
      expect(await shardSiteDrained(sql, "pooled", frozen)).toBe(true);
      await other.query("begin");
      await other.query("select 1");
      expect(await shardSiteDrained(sql, "pooled", frozen)).toBe(true);
      await other.query("commit");
      expect((await dbs.pooled.query("select status from zsite.sites where site_id = $1", [B])).rows[0].status).toBe("suspended");
      await unsuspendShardSite(sql, "pooled", B);
      expect((await dbs.pooled.query("select status from zsite.sites where site_id = $1", [B])).rows[0].status).toBe("active");
    });

    it("export -> import round trip: UUIDs, password hashes, members and records survive; checksums match; B never leaks", async () => {
      const uid = "ffffffff-0000-4000-8000-00000000000f";
      await dbs.pooled.query("insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data) values ($1, 'alias@sites.zavi', '$2a$10$abcdefghijklmnopqrstuv', now(), '{\"site\":1}')", [uid]);
      await dbs.pooled.query("insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1, $2, '{\"email\":\"Alias@Sites.Zavi\"}', 'email')", [uid, uid]);
      await dbs.pooled.query("insert into zsite.identities (site_id, email_norm, auth_user_id, alias) values ($1, 'member@example.com', $2, 'alias-f')", [A, uid]);
      await dbs.pooled.query("insert into zsite.members (site_id, user_id, role) values ($1, $2, 'user')", [A, uid]);
      const auditBefore = (await dbs.pooled.query("select count(*)::int as n from zsite_auth.member_audit where site_id = $1", [A])).rows[0].n;
      expect(auditBefore).toBeGreaterThan(0);
      for (let i = 0; i < 7; i++) await ins(A, "listings", { title: `l${i}`, status: "draft" }, uid);
      const listings = (await dbs.pooled.query("select id from zsite.records where site_id = $1 and collection = 'listings' and owner_id = $2 order by id limit 1", [A, uid])).rows;
      for (let i = 0; i < 5; i++) await ins(A, "requests", { listing_id: listings[0].id, title: `r${i}` });
      await ins(B, "listings", { title: "B-secret" });

      const src: ExportSource = { sql, project_ref: "pooled", site_id: A, listFiles: async () => [] };
      const dst: ExportSource = { ...src, project_ref: "dedicated" };
      const lines: string[] = [];
      for await (const l of exportSiteV2Lines(src)) lines.push(JSON.stringify(l));
      expect(lines.join("\n")).not.toContain("B-secret");
      const firstReq = lines.findIndex((l) => l.includes('"collection":"requests"') && l.includes('"t":"record"'));
      const lastListing = lines.map((l, i) => (l.includes('"collection":"listings"') && l.includes('"t":"record"') ? i : -1)).reduce((a, b) => Math.max(a, b));
      expect(lastListing).toBeLessThan(firstReq);

      await ensureShardSite(sql, "dedicated", A).catch(() => undefined);
      await dbs.dedicated.query("delete from zsite.sites where site_id = $1", [A]);
      const importer = createSqlSiteImporter({ sql, copyFile: null, batch: 3 });

      async function* cut() {
        let n = 0;
        for await (const chunk of exportSiteV2(src)) {
          if (n++ > lines.length / 2) return;
          yield chunk;
        }
      }
      await expect(importer.import({ tenant_id: T1, site_id: A, project_ref: "dedicated", dump: cut() })).rejects.toThrow(/did not finish/);
      const partial = (await dbs.dedicated.query("select count(*)::int as n from zsite.records where site_id = $1", [A])).rows[0].n;
      expect(partial).toBeGreaterThan(0);
      const res = await importer.import({ tenant_id: T1, site_id: A, project_ref: "dedicated", dump: exportSiteV2(src) });
      const [hs, hd] = await Promise.all([hashSite(src), hashSite(dst)]);
      expect(hd.sha256).toBe(hs.sha256);
      expect(res.sha256).toBe(hs.sha256);
      expect(hd.counts).toEqual(hs.counts);
      expect(res.records).toBe(hs.counts.records);
      const u = (await dbs.dedicated.query("select id, encrypted_password, confirmed_at is not null as c from auth.users where id = $1", [uid])).rows[0];
      expect(u).toEqual({ id: uid, encrypted_password: "$2a$10$abcdefghijklmnopqrstuv", c: true });
      expect((await dbs.dedicated.query("select count(*)::int as n from auth.identities where user_id = $1", [uid])).rows[0].n).toBe(1);
      const ids = async (db: PgClient) => (await db.query("select collection, id, owner_id from zsite.records where site_id = $1 order by 1, 2", [A])).rows;
      expect(await ids(dbs.dedicated)).toEqual(await ids(dbs.pooled));
      expect((await dbs.dedicated.query("select count(*)::int as n from zsite.records where site_id = $1", [B])).rows[0].n).toBe(0);
      expect(hs.counts.audit).toBe(auditBefore);
      expect((await dbs.dedicated.query("select count(*)::int as n from zsite_auth.member_audit where site_id = $1", [A])).rows[0].n).toBe(auditBefore);
      await expect(
        importer.import({ tenant_id: T1, site_id: B, project_ref: "dedicated", dump: exportSiteV2(src) }),
      ).rejects.toThrow(/not a v2 export of this site/);
    });
  });
});
