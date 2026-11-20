import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drainQueuedSiteChange, type QueuedChangeStore } from "@/services/sites/queued-change";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119160200_site_queued_change.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const RUN = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN2 = "aaaaaaaa-0000-4000-8000-000000000002";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let seq = 0;

async function newSite(tenant: string): Promise<string> {
  seq += 1;
  const id = `bbbbbbbb-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db.query("insert into public.sites (id, tenant_id, label, hostname) values ($1, $2, $3, $4)", [id, tenant, `s${seq}`, `s${seq}.zaviagent.com`]);
  return id;
}
const queue = async (tenant: string, site: string, message: string, run = RUN) =>
  (await db.query("select public.site_queue_change($1, $2, $3, $4, null) as r", [tenant, site, run, message])).rows[0].r as string;
const claim = async (tenant: string) => (await db.query("select * from public.site_claim_queued_change($1)", [tenant])).rows;
const settle = (tenant: string, site: string, requeue: boolean) => db.query("select public.site_settle_queued_change($1, $2, $3)", [tenant, site, requeue]);
const held = async (site: string) => (await db.query("select * from public.site_queued_change where site_id = $1", [site])).rows[0];

const sqlStore: QueuedChangeStore = {
  queue: async (i) => queue(i.tenant_id, i.site_id, i.message, i.conductor_run_id) as Promise<"queued">,
  claim: async (t) => (await claim(t))[0] ?? null,
  settle: async (t, s, r) => void (await settle(t, s, r)),
  dropStopped: async () => [],
};

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null, status text default 'active');
      create table public.tenant_users (user_id uuid, tenant_id uuid, role text);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      insert into public.tenants values ('${T1}'), ('${T2}');
    `);
    await db.exec(readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8"));
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
    await db.exec(sql);
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("holds one change per site: a second one replaces the first", async () => {
    const site = await newSite(T1);
    expect(await queue(T1, site, "Add our prices: $80 a clean")).toBe("queued");
    expect(await queue(T1, site, "Add our prices: $90 a clean", RUN2)).toBe("replaced");
    const rows = (await db.query("select * from public.site_queued_change where site_id = $1", [site])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("Add our prices: $90 a clean");
    expect(rows[0].conductor_run_id).toBe(RUN2);
    expect(rows[0].status).toBe("queued");
    await db.query("delete from public.site_queued_change");
  });

  it("a change already being started is never overwritten, and a claimed change is claimed only once", async () => {
    const site = await newSite(T1);
    await queue(T1, site, "Add our hours");
    const first = await claim(T1);
    expect(first).toHaveLength(1);
    expect(first[0].message).toBe("Add our hours");
    expect(await claim(T1)).toHaveLength(0);
    expect(await queue(T1, site, "Something else")).toBe("busy");
    expect((await held(site)).message).toBe("Add our hours");
    await settle(T1, site, true);
    expect((await held(site)).status).toBe("queued");
    expect(await claim(T1)).toHaveLength(1);
    await settle(T1, site, false);
    expect(await held(site)).toBeUndefined();
  });

  it("is tenant-scoped: another workspace cannot queue onto, claim or settle a site that is not theirs", async () => {
    const site = await newSite(T1);
    await expect(queue(T2, site, "Hijack")).rejects.toThrow(/not found/);
    await queue(T1, site, "Add our area");
    expect(await claim(T2)).toHaveLength(0);
    await claim(T1);
    await settle(T2, site, false);
    expect((await held(site)).status).toBe("running");
    await settle(T1, site, false);
    expect(await held(site)).toBeUndefined();
  });

  it("claims the oldest waiting change first", async () => {
    const a = await newSite(T1);
    const b = await newSite(T1);
    await queue(T1, b, "Second site change");
    await db.query("update public.site_queued_change set queued_at = now() - interval '1 hour' where site_id = $1", [b]);
    await queue(T1, a, "First site change");
    expect((await claim(T1))[0].site_id).toBe(b);
    expect((await claim(T1))[0].site_id).toBe(a);
    await db.query("delete from public.site_queued_change");
  });

  it("a change held on a run that was stopped or failed is thrown away, never started later", async () => {
    for (const status of ["failed", "halted"]) {
      const site = await newSite(T1);
      const run = `dddddddd-0000-4000-8000-00000000000${status === "failed" ? 1 : 2}`;
      await db.query("insert into public.conductor_runs (id, tenant_id) values ($1, $2)", [run, T1]);
      await queue(T1, site, "add prices", run);
      await db.query("update public.conductor_runs set status = $2 where id = $1", [run, status]);
      expect(await claim(T1)).toEqual([]);
      expect(await held(site)).toBeUndefined();
    }
  });

  it("a change held a day ago is never started, however it got stuck", async () => {
    const site = await newSite(T1);
    await queue(T1, site, "old change");
    await db.query("update public.site_queued_change set queued_at = now() - interval '25 hours' where site_id = $1", [site]);
    expect(await claim(T1)).toEqual([]);
    expect(await held(site)).toBeUndefined();
  });

  it("a claim left behind by a crash stops blocking the site and is not retried, so it cannot charge twice", async () => {
    const site = await newSite(T1);
    await queue(T1, site, "crashed change");
    expect(await claim(T1)).toHaveLength(1);
    expect(await queue(T1, site, "while running")).toBe("busy");
    await db.query("update public.site_queued_change set claimed_at = now() - interval '16 minutes' where site_id = $1", [site]);
    expect(await claim(T1)).toEqual([]);
    expect(await held(site)).toBeUndefined();
    expect(await queue(T1, site, "after the crash")).toBe("queued");
    await db.query("delete from public.site_queued_change where site_id = $1", [site]);
  });

  it("a live claim newer than the cutoff still blocks", async () => {
    const site = await newSite(T1);
    await queue(T1, site, "recent");
    await claim(T1);
    await db.query("update public.site_queued_change set claimed_at = now() - interval '14 minutes' where site_id = $1", [site]);
    expect(await queue(T1, site, "second")).toBe("busy");
    await db.query("delete from public.site_queued_change where site_id = $1", [site]);
  });

  it("discard removes only that run's waiting change, and says whether it did", async () => {
    const a = await newSite(T1);
    const b = await newSite(T1);
    await queue(T1, a, "on run 1", RUN);
    await queue(T1, b, "on run 2", RUN2);
    const count = async (t: string, r: string) => (await db.query("select public.site_discard_queued_change($1, $2) as n", [t, r])).rows[0].n;
    expect(await count(T2, RUN)).toBe(0);
    expect(await count(T1, RUN)).toBe(1);
    expect(await count(T1, RUN)).toBe(0);
    expect(await held(a)).toBeUndefined();
    expect((await held(b)).message).toBe("on run 2");
    await db.query("delete from public.site_queued_change where site_id = $1", [b]);
  });

  it("the browser roles cannot read the queue or call the functions", async () => {
    const grants = (await db.query(`
      select r.rolname,
             has_table_privilege(r.rolname, 'public.site_queued_change', 'select') as sel,
             has_function_privilege(r.rolname, 'public.site_queue_change(uuid, uuid, uuid, text, uuid)', 'execute') as q,
             has_function_privilege(r.rolname, 'public.site_claim_queued_change(uuid)', 'execute') as c,
             has_function_privilege(r.rolname, 'public.site_settle_queued_change(uuid, uuid, boolean)', 'execute') as s
        from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by r.rolname`)).rows;
    expect(grants.find((g) => g.rolname === "anon")).toMatchObject({ sel: false, q: false, c: false, s: false });
    expect(grants.find((g) => g.rolname === "authenticated")).toMatchObject({ sel: false, q: false, c: false, s: false });
    expect(grants.find((g) => g.rolname === "service_role")).toMatchObject({ q: true, c: true, s: true });
  });

  it("two builds finishing at once start the held change once, never twice", async () => {
    const site = await newSite(T1);
    await queue(T1, site, "Add our prices: $80 a clean");
    const refine: Array<string> = [];
    const deps = {
      store: sqlStore,
      refine: async (i: { message: string }) => {
        refine.push(i.message);
        return { conductor_run_id: RUN2 };
      },
      tick: async () => undefined,
      isBusy: () => false,
      notify: async () => undefined,
    };
    const [x, y] = await Promise.all([drainQueuedSiteChange(T1, deps), drainQueuedSiteChange(T1, deps)]);
    expect(refine).toEqual(["Add our prices: $80 a clean"]);
    expect([x.kind, y.kind].sort()).toEqual(["empty", "started"]);
    expect(await held(site)).toBeUndefined();
  });
});
