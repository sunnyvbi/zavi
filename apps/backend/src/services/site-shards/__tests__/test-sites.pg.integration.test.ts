import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ON = process.env.SITE_SHARDS_PG === "1";
const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = Number(process.env.SITE_SHARDS_PG_PORT ?? 55447);
const REPO = resolve(__dirname, "../../../../../..");
const MIG = join(REPO, "supabase/migrations");
const T1 = "aaaaaaaa-0000-4000-8000-00000000000a";
const T2 = "bbbbbbbb-0000-4000-8000-00000000000b";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgClient = any;
const req = createRequire(__filename);
let dir = "";
let admin: PgClient;

async function client(): Promise<PgClient> {
  const { Client } = req("pg");
  const c = new Client({ host: "localhost", port: PORT, user: "postgres", database: "zavi" });
  await c.connect();
  return c;
}

async function svc(c: PgClient, sql: string, args: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  await c.query("begin; set local role service_role");
  try {
    const r = await c.query(sql, args);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  }
}
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "error");

let n = 0;
async function shard(purpose: "pool" | "validation", state: "open" | "full", over: Record<string, unknown> = {}) {
  n++;
  const ref = `ref${String(n).padStart(17, "0")}`;
  const r = await admin.query(
    `insert into public.site_shards (env, name, region, project_ref, url, state, provision_step, purpose, max_sites)
     values ('dev', $1, $2, $3, $4, $5, 'done', $6, $7) returning id`,
    [`zavi-shard-dev-${n}`, over.region ?? "us-west-1", ref, `https://${ref}.supabase.co`, state, purpose, over.max_sites ?? 2000],
  );
  return r.rows[0].id as string;
}

async function newSite(tenant: string): Promise<string> {
  const run = (await admin.query("insert into public.conductor_runs (id, tenant_id) values (gen_random_uuid(), $1) returning id", [tenant])).rows[0].id;
  const r = await admin.query("select (public.site_get_or_create_for_run($1, $2, 'Shop', null, '-dev', 'zaviagent.com')).id", [tenant, run]);
  const id = r.rows[0].id as string;
  await admin.query("select public.site_backend_init_static($1, $2)", [tenant, id]);
  return id;
}

let label = 0;
const host = () => `${String(++label).padStart(26, "a").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)])}.zavi-preview.dev`;
const create = (c: PgClient, tenant: string, site: string, ttl = 900, h = host()) =>
  svc(c, "select * from public.site_test_site_create($1, $2, 'dev', 'us-west-1', $3, 'd012345678-0a1b2c3d', $4)", [tenant, site, h, ttl]);

describe.skipIf(!ON)("validation shards + test sites on a throwaway Postgres 17", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "test-sites-pg-"));
    execFileSync(join(PGBIN, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust"], { stdio: "ignore" });
    execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${PORT} -c listen_addresses=localhost -c max_connections=80`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
    const { Client } = req("pg");
    const root = new Client({ host: "localhost", port: PORT, user: "postgres", database: "postgres" });
    await root.connect();
    await root.query("create database zavi");
    await root.end();
    admin = await client();
    await admin.query(readFileSync(join(__dirname, "sql/zavi-db-stubs.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261008090000_sites.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010090000_site_shards.sql"), "utf8"));
    await admin.query("alter table public.site_shards add column if not exists dedicated_site_id uuid");
    await admin.query("alter table public.site_shards drop constraint if exists site_shards_name_check");
    await admin.query("alter table public.sites add column if not exists kernel_shard_id uuid");
    await admin.query(readFileSync(join(MIG, "20261010130000_site_auth_directory_rpc.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010160000_site_shard_autoprovision.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261012050000_site_validation_shards_test_sites.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261012050000_site_validation_shards_test_sites.sql"), "utf8"));
    await admin.query("insert into public.tenants values ($1), ($2)", [T1, T2]);
  }, 60_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    if (dir) {
      try {
        execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
      } catch {
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("anon / authenticated can call none of the new functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [
        `select public.site_shard_validation_ready(gen_random_uuid())`,
        `select * from public.site_test_site_due('dev', 10)`,
        `select public.site_test_site_stats('dev')`,
        `select public.site_is_validation(gen_random_uuid())`,
        `select * from public.site_auth_directory(gen_random_uuid())`,
        `select public.site_shard_autoprov_claim('dev', 'auto', 10, false, null, 'us-west-1', 0, 'validation')`,
      ]) {
        await admin.query(`begin; set local role ${role}`);
        const c = await code(admin.query(sql));
        await admin.query("rollback");
        expect(c, `${role}: ${sql}`).toBe("42501");
      }
    }
  });

  it("a validation shard can never be opened, and customer placement never picks it", async () => {
    const v = await shard("validation", "full");
    expect(await code(admin.query("update public.site_shards set state = 'open' where id = $1", [v]))).toBe("23514");
    expect(await code(svc(admin, "select public.site_shard_update($1, '{\"state\":\"open\"}'::jsonb)", [v]))).not.toBe("ok");
    const site = await newSite(T1);
    expect(await code(svc(admin, "select * from public.site_backend_place($1, $2, 'dev')", [T1, site]))).toBe("53400");
    await svc(admin, "select public.site_shard_record_metrics($1, '{\"records\":0}'::jsonb)", [v]);
    expect((await admin.query("select state from public.site_shards where id = $1", [v])).rows[0].state).toBe("full");
    const p = await shard("pool", "open");
    const placed = await svc(admin, "select * from public.site_backend_place($1, $2, 'dev')", [T1, site]);
    expect(placed[0].shard_id).toBe(p);
    const s2 = await newSite(T1);
    await admin.query("update public.sites set shard_id = $2, backend_mode = 'pooled' where id = $1", [s2, v]);
    expect(await code(svc(admin, "select * from public.site_backend_place($1, $2, 'dev')", [T1, s2]))).toBe("42501");
    await admin.query("update public.site_shards set state = 'retired', site_count = 0 where id = $1", [p]);
  });

  it("validation_ready: provisioning -> full only when fully provisioned; never for a pool shard", async () => {
    const r = await admin.query("insert into public.site_shards (env, name, region, purpose) values ('dev', 'zavi-shard-dev-900', 'us-west-1', 'validation') returning id");
    const id = r.rows[0].id;
    expect(await code(svc(admin, "select public.site_shard_validation_ready($1)", [id]))).toBe("55000");
    await admin.query("update public.site_shards set project_ref = 'refvalidation0000900', url = 'https://refvalidation0000900.supabase.co', provision_step = 'done' where id = $1", [id]);
    expect((await svc(admin, "select (public.site_shard_validation_ready($1)).state", [id]))[0].state).toBe("full");
    expect((await svc(admin, "select (public.site_shard_validation_ready($1)).state", [id]))[0].state).toBe("full");
    const pool = await shard("pool", "open");
    expect(await code(svc(admin, "select public.site_shard_validation_ready($1)", [pool]))).toBe("42501");
    await admin.query("update public.site_shards set state = 'retired' where id = $1", [pool]);
  });

  it("autoprov claim: a validation create is never a canary; the 7-argument call still works", async () => {
    await admin.query("update public.site_shards set state = 'retired', site_count = 0 where state = 'provisioning'");
    const v = (await svc(admin, "select public.site_shard_autoprov_claim('dev', 'auto', 10, false, null, 'us-east-1', 0, 'validation') as j"))[0].j as Record<string, unknown>;
    expect(v).toMatchObject({ action: "create", purpose: "validation", canary: false, region: "us-east-1" });
    const row = (await admin.query("select purpose, is_canary from public.site_shards where name = $1", [v.shard_name])).rows[0];
    expect(row).toEqual({ purpose: "validation", is_canary: false });
    const again = (await svc(admin, "select public.site_shard_autoprov_claim(p_env => 'dev', p_source => 'staff', p_max_per_day => 10, p_override => false, p_actor => 'x', p_region => 'us-west-1', p_min_retry_seconds => 0) as j"))[0].j;
    expect(again).toMatchObject({ action: "resume", shard_name: v.shard_name, purpose: "validation" });
    await admin.query("update public.site_shards set state = 'retired' where name = $1", [v.shard_name]);
  });

  describe("test sites", () => {
    let vshard = "";
    let live = "";
    beforeAll(async () => {
      await admin.query("update public.site_shards set state = 'retired', site_count = 0 where purpose = 'validation' and state <> 'retired' and project_ref is null");
      await admin.query("update public.site_shards set state = 'draining' where purpose = 'validation' and state = 'full'");
      vshard = await shard("validation", "full", { max_sites: 20 });
      live = await newSite(T1);
    });

    it("no validation capacity is 53400; a foreign or missing live site is P0002", async () => {
      await admin.query("update public.site_shards set state = 'draining' where id = $1", [vshard]);
      expect(await code(create(admin, T1, live))).toBe("53400");
      await admin.query("update public.site_shards set state = 'full' where id = $1", [vshard]);
      expect(await code(create(admin, T2, live))).toBe("P0002");
    });

    it("create takes a slot on the validation shard; directory resolves it as a test site; destroy frees the slot once", async () => {
      const h = host();
      const before = Number((await admin.query("select site_count from public.site_shards where id = $1", [vshard])).rows[0].site_count);
      const [t] = await create(admin, T1, live, 900, h);
      expect(t.shard_id).toBe(vshard);
      expect(t.id).not.toBe(live);
      expect(Number((await admin.query("select site_count from public.site_shards where id = $1", [vshard])).rows[0].site_count)).toBe(before + 1);
      const dir = await svc(admin, "select * from public.site_auth_directory($1)", [t.id]);
      expect(dir[0]).toMatchObject({ id: t.id, hostname: h, status: "provisioning", backend_mode: "pooled", shard_id: vshard, is_test: true });
      expect((await svc(admin, "select * from public.site_auth_directory($1)", [live]))[0]).toMatchObject({ id: live, is_test: false });
      expect((await svc(admin, "select public.site_is_validation($1) as v", [t.id]))[0].v).toBe(true);
      expect((await svc(admin, "select public.site_is_validation($1) as v", [live]))[0].v).toBe(false);
      expect(await code(svc(admin, "select public.site_test_site_activate($1, $2, 'h')", [T2, t.id]))).toBe("55000");
      expect(await svc(admin, "select * from public.site_test_site_get($1, $2)", [T2, t.id])).toEqual([]);
      expect(await svc(admin, "select * from public.site_test_site_destroy_begin($1, $2, 'x')", [T2, t.id])).toEqual([]);
      expect((await svc(admin, "select public.site_test_site_activate($1, $2, 'h') as ok", [T1, t.id]))[0].ok).toBe(true);
      expect((await svc(admin, "select * from public.site_auth_directory($1)", [t.id]))[0].status).toBe("live");
      const d = await svc(admin, "select * from public.site_test_site_destroy_begin($1, $2, 'gate_done')", [T1, t.id]);
      expect(d[0]).toMatchObject({ state: "destroying", project_ref: expect.any(String) });
      expect(await svc(admin, "select * from public.site_auth_directory($1)", [t.id])).toEqual([]);
      expect((await svc(admin, "select public.site_test_site_destroyed($1, $2) as ok", [T1, t.id]))[0].ok).toBe(true);
      expect((await svc(admin, "select public.site_test_site_destroyed($1, $2) as ok", [T1, t.id]))[0].ok).toBe(false);
      expect(Number((await admin.query("select site_count from public.site_shards where id = $1", [vshard])).rows[0].site_count)).toBe(before);
      expect((await svc(admin, "select * from public.site_test_site_destroy_begin($1, $2, 'again')", [T1, t.id]))[0].state).toBe("destroyed");
    });

    it("an expired test site is not resolvable and cannot be activated", async () => {
      const [t] = await create(admin, T1, live, 60);
      await admin.query("update public.site_test_sites set expires_at = now() - interval '1 second' where id = $1", [t.id]);
      expect(await svc(admin, "select * from public.site_auth_directory($1)", [t.id])).toEqual([]);
      expect(await code(svc(admin, "select public.site_test_site_activate($1, $2, 'h')", [T1, t.id]))).toBe("55000");
    });

    it("the per-live-site cap of 8 holds under 12 concurrent creates", async () => {
      const site = await newSite(T1);
      const clients = await Promise.all(Array.from({ length: 12 }, () => client()));
      try {
        const results = await Promise.all(clients.map((c) => code(create(c, T1, site))));
        expect(results.filter((r) => r === "ok")).toHaveLength(8);
        expect(results.filter((r) => r === "54000")).toHaveLength(4);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it("due: expired ACTIVE rows, creates abandoned 30 min, stale destroys; never a fresh creating row; leaked counts each row once", async () => {
      await admin.query("update public.site_test_sites set state = 'destroyed'");
      const site = await newSite(T1);
      const [a] = await create(admin, T1, site);
      await svc(admin, "select public.site_test_site_activate($1, $2, 'h')", [T1, a.id]);
      await admin.query("update public.site_test_sites set expires_at = now() - interval '1 minute' where id = $1", [a.id]);
      const [b] = await create(admin, T1, site, 60);
      await admin.query("update public.site_test_sites set expires_at = now() - interval '1 minute' where id = $1", [b.id]);
      const [c] = await create(admin, T1, site);
      await admin.query("update public.site_test_sites set created_at = now() - interval '31 minutes' where id = $1", [c.id]);
      const [d] = await create(admin, T1, site);
      await svc(admin, "select public.site_test_site_activate($1, $2, 'h')", [T1, d.id]);
      await admin.query("update public.site_test_sites set expires_at = now() - interval '1 hour', attempts = 3 where id = $1", [d.id]);
      const due = (await svc(admin, "select id from public.site_test_site_due('dev', 50)")).map((r) => r.id);
      expect(new Set(due)).toEqual(new Set([a.id, c.id, d.id]));
      const stats = (await svc(admin, "select public.site_test_site_stats('dev') as s"))[0].s as Record<string, number>;
      expect(stats).toMatchObject({ overdue: 1, stuck: 1, leaked: 1 });
      const states = await svc(admin, "select * from public.site_test_site_states($1::uuid[])", [[a.id, "cccccccc-0000-4000-8000-00000000000c"]]);
      expect(states).toEqual([{ id: a.id, tenant_id: T1, state: "active" }]);
    });
  });
});
