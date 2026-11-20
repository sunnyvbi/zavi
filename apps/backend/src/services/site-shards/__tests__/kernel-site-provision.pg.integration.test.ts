import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ON = process.env.SITE_SHARDS_PG === "1";
const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = Number(process.env.SITE_SHARDS_PG_PORT ?? 55465);
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

describe.skipIf(!ON)("built kernel sites on a throwaway Postgres 17", () => {
  let z: PgClient;
  let poolShard = "";
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    await z.query("begin; set local role service_role");
    try {
      const r = await z.query(
        `select to_jsonb(x) as j from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) x`,
        keys.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])),
      );
      await z.query("commit");
      return r.rows.map((x: { j: unknown }) => x.j) as Array<Record<string, unknown>>;
    } catch (e) {
      await z.query("rollback").catch(() => undefined);
      throw e;
    }
  };
  const newSite = async (tenant = T1) => {
    const run = (await z.query("insert into public.conductor_runs (id, tenant_id) values (gen_random_uuid(), $1) returning id", [tenant])).rows[0].id;
    const id = (await z.query("select (public.site_get_or_create_for_run($1, $2, 'Shop', null, '-dev', 'zaviagent.com')).id", [tenant, run])).rows[0].id as string;
    await z.query("select public.site_backend_init_static($1, $2)", [tenant, id]);
    return id;
  };
  const NIL = "00000000-0000-4000-8000-000000000000";
  const leases = new Map<string, string>();
  const claim = async (site: string, tenant = T1, lease = 60) => {
    const r = await rpc("site_kernel_provision_claim", { p_tenant_id: tenant, p_site_id: site, p_reason: "isolation", p_lease_seconds: lease });
    if (typeof r[0]?.lease_id === "string") leases.set(site, r[0].lease_id as string);
    return r;
  };
  const advance = (site: string, from: string, to: string, patch: Record<string, unknown> = {}, release = false, tenant = T1, lease = leases.get(site) ?? NIL) =>
    rpc("site_kernel_provision_advance", {
      p_tenant_id: tenant, p_site_id: site, p_lease_id: lease, p_from: from, p_to: to, p_patch: patch, p_release: release, p_lease_seconds: 60,
    });
  const attach = (site: string, tenant = T1, lease: string | null = leases.get(site) ?? null) =>
    rpc("site_kernel_attach", { p_tenant_id: tenant, p_site_id: site, p_lease_id: lease });
  const provider = async (site: string) =>
    (await z.query("select state, ref from public.site_providers where site_id = $1 and kind = 'pooled_backend'", [site])).rows[0] ?? null;
  const kernelFor = async (site: string, ref: string, tenant = T1, done = true) => {
    await z.query("update public.sites set supabase_project_ref = $2 where id = $1", [site, ref]);
    const k = (await rpc("site_kernel_register", { p_tenant_id: tenant, p_site_id: site, p_env: "dev", p_region: "us-west-1" }))[0];
    if (done) {
      await rpc("site_shard_update", { p_id: k.id, p_patch: { provision_step: "done" } });
      await rpc("site_kernel_ready", { p_tenant_id: tenant, p_site_id: site });
    }
    return k.id as string;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kernel-site-pg-"));
    execFileSync(join(PGBIN, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust"], { stdio: "ignore" });
    execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${PORT} -c listen_addresses=localhost`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
    const root = await client("postgres");
    await root.query("create database zavi");
    z = await client("zavi");
    await z.query(readFileSync(join(__dirname, "sql/zavi-db-stubs.sql"), "utf8"));
    for (const f of ["20261008090000_sites.sql", "20261010090000_site_shards.sql", "20261010120000_site_graduation.sql", "20261012020000_site_kernel_provisions.sql", "20261012020000_site_kernel_provisions.sql"]) {
      await z.query(readFileSync(join(MIG, f), "utf8"));
    }
    await z.query("insert into public.tenants values ($1), ($2)", [T1, T2]);
    const r = await rpc("site_shard_register", { p_env: "dev", p_name: "zavi-shard-dev-1", p_region: "us-west-1", p_is_canary: false });
    poolShard = r[0].id as string;
    await rpc("site_shard_update", { p_id: poolShard, p_patch: { project_ref: "shardref0001", url: "https://shardref0001.supabase.co", provision_step: "done", state: "open" } });
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

  it("the happy path: claim -> project_ready -> kernel_ready -> attach; the site becomes dedicated on ITS kernel", async () => {
    const site = await newSite();
    const c = await claim(site);
    expect(c[0]).toMatchObject({ state: "requested", attempts: 1, reason: "isolation" });
    expect((await advance(site, "requested", "project_ready", { project_ref: "ownref00000001" }))[0]).toMatchObject({ state: "project_ready", project_ref: "ownref00000001" });
    const k = await kernelFor(site, "ownref00000001");
    expect((await advance(site, "project_ready", "kernel_ready", { kernel_shard_id: k }))[0].state).toBe("kernel_ready");
    const s = (await attach(site))[0];
    expect(s).toMatchObject({ backend_mode: "dedicated", kernel_shard_id: k, shard_id: null, gateway_binding: null });
    const led = (await z.query("select state, lease_until, attached_at from public.site_kernel_provisions where site_id = $1", [site])).rows[0];
    expect(led.state).toBe("attached");
    expect(led.lease_until).toBeNull();
    expect(led.attached_at).not.toBeNull();
    expect((await attach(site))[0].kernel_shard_id).toBe(k);
    expect((await claim(site))[0]).toMatchObject({ state: "attached" });
  });

  it("one runner at a time: a second claim inside the lease gets nothing; a released lease is claimable at once", async () => {
    const site = await newSite();
    expect(await claim(site)).toHaveLength(1);
    expect(await claim(site)).toHaveLength(0);
    await advance(site, "requested", "requested", { last_error: "boom" }, true);
    const again = await claim(site);
    expect(again[0]).toMatchObject({ attempts: 2, last_error: "boom" });
  });

  it("tenant checks: another tenant can neither claim, advance nor attach this site", async () => {
    const site = await newSite();
    await expect(claim(site, T2)).rejects.toThrow(/not found/);
    await claim(site);
    await expect(advance(site, "requested", "project_ready", {}, false, T2)).rejects.toThrow(/not found/);
    await expect(attach(site, T2)).rejects.toThrow(/not found/);
  });

  it("the lease is OWNED: a stale token can neither advance, release, nor attach; the holder's lease survives", async () => {
    const site = await newSite();
    const first = (await claim(site, T1, 10))[0].lease_id as string;
    await z.query("update public.site_kernel_provisions set lease_until = now() - interval '1 second' where site_id = $1", [site]);
    const second = (await claim(site))[0].lease_id as string;
    expect(second).not.toBe(first);
    expect(await advance(site, "requested", "project_ready", { project_ref: "staleref000001" }, false, T1, first)).toHaveLength(0);
    expect(await advance(site, "requested", "requested", { last_error: "A failed" }, true, T1, first)).toHaveLength(0);
    const row = (await z.query("select lease_id, last_error, state from public.site_kernel_provisions where site_id = $1", [site])).rows[0];
    expect(row).toMatchObject({ lease_id: second, last_error: null, state: "requested" });
    expect((await advance(site, "requested", "project_ready", { project_ref: "liveref0000001" }, false, T1, second))[0].state).toBe("project_ready");
    const k = await kernelFor(site, "liveref0000001");
    await advance(site, "project_ready", "kernel_ready", { kernel_shard_id: k }, false, T1, second);
    await expect(attach(site, T1, first)).rejects.toThrow(/lease/);
    expect((await attach(site, T1, second))[0].kernel_shard_id).toBe(k);
  });

  it("teardown sees the kernel from the first step on: a kernel-marked pooled_backend provider claim, carrying the kernel once attached", async () => {
    const site = await newSite();
    await claim(site);
    expect(await provider(site)).toBeNull();
    await advance(site, "requested", "project_ready", { project_ref: "tref0000000001" });
    expect(await provider(site)).toMatchObject({ state: "created", ref: { kernel_site: true } });
    const k = await kernelFor(site, "tref0000000001");
    await advance(site, "project_ready", "kernel_ready", { kernel_shard_id: k });
    await advance(site, "kernel_ready", "kernel_ready", {}, true);
    await claim(site);
    await attach(site);
    expect(await provider(site)).toMatchObject({ state: "created", ref: { kernel_site: true, kernel_shard_id: k } });
  });

  it("a deleting / failed site is refused everywhere, even once attached; recording a failure still works", async () => {
    const site = await newSite();
    await claim(site);
    await advance(site, "requested", "project_ready", { project_ref: "xref0000000001" });
    await z.query("update public.sites set status = 'failed' where id = $1", [site]);
    await expect(advance(site, "project_ready", "project_ready")).rejects.toThrow(/is failed/);
    expect((await advance(site, "project_ready", "project_ready", { last_error: "gone" }, true))[0].lease_id).toBeNull();

    const done = await newSite();
    await claim(done);
    await advance(done, "requested", "project_ready", { project_ref: "yref0000000001" });
    const k = await kernelFor(done, "yref0000000001");
    await advance(done, "project_ready", "kernel_ready", { kernel_shard_id: k });
    await attach(done);
    await z.query("update public.sites set status = 'deleting' where id = $1", [done]);
    await expect(claim(done)).rejects.toThrow(/is deleting/);
    await expect(attach(done, T1, null)).rejects.toThrow(/is deleting/);
  });

  it("refuses a pooled site, a legacy dedicated site and a deleting site", async () => {
    const pooled = await newSite();
    await z.query("select * from public.site_backend_place($1, $2, 'dev')", [T1, pooled]);
    await expect(claim(pooled)).rejects.toThrow(/must graduate/);

    const legacy = await newSite();
    await z.query("update public.sites set backend_mode = 'dedicated', supabase_project_ref = 'legacyref00001' where id = $1", [legacy]);
    await expect(claim(legacy)).rejects.toThrow(/legacy dedicated site/);

    const gone = await newSite();
    await z.query("update public.sites set status = 'deleting' where id = $1", [gone]);
    await expect(claim(gone)).rejects.toThrow(/is deleting/);
  });

  it("advance: no skipping steps, no finishing without the attach, patch keys allowlisted", async () => {
    const site = await newSite();
    await claim(site);
    await expect(advance(site, "requested", "kernel_ready")).rejects.toThrow(/not a step/);
    await expect(advance(site, "kernel_ready", "attached")).rejects.toThrow(/not a step/);
    await expect(advance(site, "requested", "requested", { state: "attached" })).rejects.toThrow(/allowlist/);
    expect(await advance(site, "project_ready", "kernel_ready")).toHaveLength(0);
  });

  it("attach refuses before the kernel is serving, and never takes another site's kernel", async () => {
    const a = await newSite();
    await claim(a);
    await advance(a, "requested", "project_ready", { project_ref: "aref0000000001" });
    await expect(attach(a)).rejects.toThrow(/not ready/);
    const ka = await kernelFor(a, "aref0000000001", T1, false);
    await advance(a, "project_ready", "kernel_ready", { kernel_shard_id: ka });
    await expect(attach(a)).rejects.toThrow(/not serving/);

    const b = await newSite();
    await claim(b);
    await advance(b, "requested", "project_ready", { project_ref: "bref0000000001" });
    await z.query("update public.sites set supabase_project_ref = 'bref0000000001' where id = $1", [b]);
    await advance(b, "project_ready", "kernel_ready", { kernel_shard_id: ka });
    await expect(attach(b)).rejects.toThrow(/not serving/);
    const bRow = (await z.query("select backend_mode, kernel_shard_id from public.sites where id = $1", [b])).rows[0];
    expect(bRow).toEqual({ backend_mode: "static", kernel_shard_id: null });
  });

  it("attach refuses a site that became pooled meanwhile (nothing changes)", async () => {
    const site = await newSite();
    await claim(site);
    await advance(site, "requested", "project_ready", { project_ref: "pref0000000001" });
    const k = await kernelFor(site, "pref0000000001");
    await advance(site, "project_ready", "kernel_ready", { kernel_shard_id: k });
    await expect(z.query("select * from public.site_backend_place($1, $2, 'dev')", [T1, site])).rejects.toThrow(/own database/);
    await z.query("update public.sites set shard_id = $2, backend_mode = 'pooled' where id = $1", [site, poolShard]);
    await expect(attach(site)).rejects.toThrow(/must graduate/);
    expect((await z.query("select kernel_shard_id from public.sites where id = $1", [site])).rows[0].kernel_shard_id).toBeNull();
  });

  it("a deleted site's kernel retires through the existing graduation RPC", async () => {
    const site = await newSite();
    await claim(site);
    await advance(site, "requested", "project_ready", { project_ref: "dref0000000001" });
    const k = await kernelFor(site, "dref0000000001");
    await advance(site, "project_ready", "kernel_ready", { kernel_shard_id: k });
    await attach(site);
    await z.query("update public.sites set status = 'deleting' where id = $1", [site]);
    const out = await rpc("site_kernel_retire", { p_tenant_id: T1, p_site_id: site });
    expect(out[0]).toBe("dref0000000001");
    expect((await z.query("select kernel_shard_id from public.sites where id = $1", [site])).rows[0].kernel_shard_id).toBeNull();
  });

  it("kernel provisioning and pooled placement are mutually exclusive (from the first claim on)", async () => {
    const site = await newSite();
    await claim(site);
    await expect(z.query("select * from public.site_backend_place($1, $2, 'dev')", [T1, site])).rejects.toThrow(/being set up on its own database/);
    const plain = await newSite();
    expect((await z.query("select * from public.site_backend_place($1, $2, 'dev')", [T1, plain])).rows[0].placed).toBe(true);
  });

  it("the legacy per-site path and a kernel build never share a site: whichever reserves first wins", async () => {
    const legacy = await newSite();
    await rpc("site_backend_dedicate_static_reserve", { p_tenant_id: T1, p_site_id: legacy });
    await rpc("site_backend_dedicate_static_reserve", { p_tenant_id: T1, p_site_id: legacy });
    expect((await z.query("select state, ref from public.site_providers where site_id = $1 and kind = 'supabase_project'", [legacy])).rows[0])
      .toMatchObject({ state: "claimed", ref: { legacy_dedicated: true } });
    await expect(claim(legacy)).rejects.toThrow(/legacy dedicated site/);

    const kernel = await newSite();
    await claim(kernel);
    await expect(rpc("site_backend_dedicate_static_reserve", { p_tenant_id: T1, p_site_id: kernel })).rejects.toThrow(/being set up on its own database/);
    await expect(rpc("site_backend_dedicate_static_reserve", { p_tenant_id: T2, p_site_id: kernel })).rejects.toThrow(/not found/);
  });

  it("only the service role can call the RPCs", async () => {
    expect(poolShard).toMatch(/^[0-9a-f-]{36}$/);
    const site = await newSite();
    for (const role of ["authenticated", "anon"]) {
      await z.query(`begin; set local role ${role}`);
      await expect(z.query("select * from public.site_kernel_provision_claim($1, $2, 'isolation', 60)", [T1, site])).rejects.toThrow(/permission denied/);
      await z.query("rollback");
    }
  });
});
