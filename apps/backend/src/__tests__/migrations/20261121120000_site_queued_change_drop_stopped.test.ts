import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { QUEUED_CHANGE_DROPPED_CHAT, drainQueuedSiteChange, type QueuedChangeStore } from "@/services/sites/queued-change";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261121120000_site_queued_change_drop_stopped.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let seq = 0;

const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function newSite(tenant = T1): Promise<string> {
  const id = uuid("bbbbbbbb");
  await db.query("insert into public.sites (id, tenant_id, label, hostname) values ($1, $2, $3, $4)", [id, tenant, `s${seq}`, `s${seq}.zaviagent.com`]);
  return id;
}
async function newRun(site: string | null, status: string, tenant = T1): Promise<string> {
  const id = uuid("cccccccc");
  const graph = site ? [{ payload: { site_id: site } }] : [];
  await db.query("insert into public.conductor_runs (id, tenant_id, status, kind, goal_graph) values ($1, $2, $3, 'build_app', $4)", [id, tenant, status, JSON.stringify(graph)]);
  return id;
}
const queue = async (tenant: string, site: string, message: string, run: string) =>
  (await db.query("select public.site_queue_change($1, $2, $3, $4, null) as r", [tenant, site, run, message])).rows[0].r as string;
const held = async (site: string) => (await db.query("select * from public.site_queued_change where site_id = $1", [site])).rows[0];
const setStatus = (run: string, status: string) => db.query("update public.conductor_runs set status = $2 where id = $1", [run, status]);
const dropStopped = async (tenant: string) =>
  (await db.query("select public.site_drop_stopped_queued_changes($1) as root", [tenant])).rows.map((r) => r.root as string);

const sqlStore: QueuedChangeStore = {
  queue: async (i) => queue(i.tenant_id, i.site_id, i.message, i.conductor_run_id) as Promise<"queued">,
  claim: async (t) => (await db.query("select * from public.site_claim_queued_change($1)", [t])).rows[0] ?? null,
  settle: async (t, s, r) => void (await db.query("select public.site_settle_queued_change($1, $2, $3)", [t, s, r])),
  dropStopped,
};

async function drain(tenant = T1, store: QueuedChangeStore = sqlStore) {
  const refined: string[] = [];
  const notes: Array<{ session: string; body: string }> = [];
  const out = await drainQueuedSiteChange(tenant, {
    store,
    refine: async (i) => {
      refined.push(i.message);
      return { conductor_run_id: uuid("dddddddd") };
    },
    tick: async () => undefined,
    isBusy: () => false,
    notify: async (_t, session, body) => void notes.push({ session, body }),
  });
  return { out, refined, notes };
}

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.tenants (id uuid primary key);
      create table public.conductor_runs (id uuid primary key, tenant_id uuid not null, status text default 'active', kind text, goal_graph jsonb default '[]'::jsonb, created_at timestamptz default clock_timestamp());
      create table public.tenant_users (user_id uuid, tenant_id uuid, role text);
      create table public.tenant_resources (tenant_id uuid, resource_kind text, external_ref jsonb);
      create function public._build_graph_site_id(p_graph jsonb) returns text language sql immutable as $$ select lower(p_graph->0->'payload'->>'site_id') $$;
      insert into public.tenants values ('${T1}'), ('${T2}');
    `);
    await db.exec(readFileSync(join(MIGRATIONS, "20261008090000_sites.sql"), "utf-8"));
    await db.exec(readFileSync(join(MIGRATIONS, "20261119160200_site_queued_change.sql"), "utf-8"));
    await db.exec(readFileSync(join(MIGRATIONS, "20261119160400_site_queued_change_held_by_run.sql"), "utf-8"));
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
    await db.exec(sql);
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("an edit survives its failed chat session while another run is the real blocker, then runs once", async () => {
    const site = await newSite();
    const session = await newRun(site, "failed");
    const refine = await newRun(site, "active");
    await queue(T1, site, "edit 2", session);
    expect((await held(site)).held_by_run_id).toBe(refine);

    const during = await drain();
    expect(during.refined).toEqual([]);
    expect(during.notes).toEqual([]);
    expect((await held(site)).message).toBe("edit 2");

    await setStatus(refine, "done");
    expect((await drain()).refined).toEqual(["edit 2"]);
    expect((await drain()).refined).toEqual([]);
  });

  it.each(["failed", "halted"])("a run stopped as %s drops the edit, never charges it, and tells the owner once", async (status) => {
    const site = await newSite();
    const session = await newRun(site, "done");
    const blocker = await newRun(site, "provisioning");
    await queue(T1, site, "edit 3", session);
    await setStatus(blocker, status);

    const first = await drain();
    expect(first.out).toEqual({ kind: "empty" });
    expect(first.refined).toEqual([]);
    expect(first.notes).toEqual([{ session, body: QUEUED_CHANGE_DROPPED_CHAT }]);
    expect(await held(site)).toBeUndefined();
    expect((await drain()).notes).toEqual([]);
  });

  it("with no blocker recorded, a failed chat session still drops the edit with a note", async () => {
    const site = await newSite();
    const session = await newRun(site, "failed");
    await queue(T1, site, "edit 4", session);
    expect((await held(site)).held_by_run_id).toBeNull();
    const { refined, notes } = await drain();
    expect(refined).toEqual([]);
    expect(notes).toEqual([{ session, body: QUEUED_CHANGE_DROPPED_CHAT }]);
  });

  it("no path but the drop removes a stopped edit, so the owner cannot miss the note", async () => {
    const site = await newSite();
    const session = await newRun(site, "done");
    const blocker = await newRun(site, "active");
    await queue(T1, site, "edit 5", session);
    await setStatus(blocker, "failed");
    await db.query("select public.site_queued_change_prune($1)", [T1]);
    expect((await held(site)).message).toBe("edit 5");
    await dropStopped(T1);
  });

  it("when the drop is down, a stopped edit is still never claimed or charged", async () => {
    const site = await newSite();
    const session = await newRun(site, "done");
    const blocker = await newRun(site, "active");
    await queue(T1, site, "edit 6", session);
    await setStatus(blocker, "halted");
    const { refined, out } = await drain(T1, {
      ...sqlStore,
      dropStopped: async () => {
        throw new Error("rpc down");
      },
    });
    expect(out).toEqual({ kind: "empty" });
    expect(refined).toEqual([]);
    expect((await held(site)).status).toBe("queued");
    expect((await drain()).notes).toEqual([{ session, body: QUEUED_CHANGE_DROPPED_CHAT }]);
  });

  it("two drains racing post one note", async () => {
    const site = await newSite();
    const session = await newRun(site, "done");
    const blocker = await newRun(site, "active");
    await queue(T1, site, "edit 7", session);
    await setStatus(blocker, "failed");
    const [a, b] = await Promise.all([drain(), drain()]);
    expect([...a.notes, ...b.notes]).toEqual([{ session, body: QUEUED_CHANGE_DROPPED_CHAT }]);
  });

  it("a new edit replaces a stopped one and waits on the run live now", async () => {
    const site = await newSite();
    const session = await newRun(site, "done");
    const stopped = await newRun(site, "active");
    await queue(T1, site, "edit 8", session);
    await setStatus(stopped, "failed");
    const live = await newRun(site, "active");
    expect(await queue(T1, site, "edit 9", session)).toBe("replaced");
    expect((await held(site)).held_by_run_id).toBe(live);
    expect((await drain()).notes).toEqual([]);
    await setStatus(live, "done");
    expect((await drain()).refined).toEqual(["edit 9"]);
  });

  it("a running change and another tenant's change are left alone", async () => {
    const mine = await newSite();
    const session = await newRun(mine, "done");
    const blocker = await newRun(mine, "active");
    await queue(T1, mine, "edit 10", session);
    await setStatus(blocker, "done");
    await sqlStore.claim(T1);
    await setStatus(blocker, "failed");

    const theirs = await newSite(T2);
    const theirSession = await newRun(theirs, "done", T2);
    const theirBlocker = await newRun(theirs, "active", T2);
    await queue(T2, theirs, "edit 11", theirSession);
    await setStatus(theirBlocker, "failed");

    expect(await dropStopped(T1)).toEqual([]);
    expect((await held(mine)).status).toBe("running");
    expect((await held(theirs)).message).toBe("edit 11");
    await sqlStore.settle(T1, mine, false);
    expect(await dropStopped(T2)).toEqual([theirSession]);
  });

  it("requires a tenant", async () => {
    await expect(dropStopped(null as unknown as string)).rejects.toThrow("tenant_id is required");
  });

  it("the browser roles cannot call the drop", async () => {
    const { rows } = await db.query(`
      select r.rolname, has_function_privilege(r.rolname, 'public.site_drop_stopped_queued_changes(uuid)', 'execute') as d
        from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by r.rolname
    `);
    expect(rows).toEqual([
      { rolname: "anon", d: false },
      { rolname: "authenticated", d: false },
      { rolname: "service_role", d: true },
    ]);
  });
});
