import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SQL = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261107113000_approval_envelope_column.sql"), "utf8");
const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenants (id uuid primary key);
  create table channel_actions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    status text not null default 'pending', exec_status text, exec_result jsonb);
  create table decisions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, status text not null default 'proposed');
  create table ad_object_changes (tenant_id uuid, action_table text, action_id uuid);
`;

describe.skipIf(!PG_URL)("approval envelope migration, live", () => {
  let admin: Client;
  let db: Client;
  const dbName = `zavi_env_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const A = randomUUID();
  const B = randomUUID();
  const one = async <R = Record<string, unknown>>(q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0] as R;
  const env = (tenant: string, extra: Record<string, unknown> = {}) => ({
    v: 1, envelope_id: `ask:${randomUUID()}`, tenant_id: tenant, actor_user_id: randomUUID(), actor_role: "owner", surface: "chat",
    channel: "chatgpt_ads", max_total_usd: 58, max_daily_usd: null, starts_on: "2026-10-15", ends_on: "2026-10-17", ...extra,
  });
  const card = async (tenant = A, status = "pending") => (await one<{ id: string }>("insert into channel_actions (tenant_id, status) values ($1, $2) returning id", [tenant, status])).id;
  const set = async (tenant: string, table: string, id: string, e: unknown) => (await one<{ r: Record<string, unknown> }>("select set_approval_envelope($1, $2, $3, $4) r", [tenant, table, id, JSON.stringify(e)])).r;
  const claim = async (tenant: string, envId: string, action: string, takeover: string | null = null) =>
    (await one<{ r: Record<string, unknown> }>("select claim_approval_envelope($1, $2, $3, $4) r", [tenant, envId, action, takeover])).r;

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(PG_URL!);
    url.pathname = `/${dbName}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(BOOTSTRAP);
    await db.query("insert into tenants values ($1), ($2)", [A, B]);
    await db.query(SQL);
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  });

  it("writes once, tenant-qualified; a replay of the same envelope is ok", async () => {
    const id = await card();
    const e = env(A);
    expect(await set(A, "channel_actions", id, e)).toEqual({ ok: true });
    expect(await set(A, "channel_actions", id, e)).toMatchObject({ ok: true, replayed: true });
    expect(await set(A, "channel_actions", id, env(A))).toEqual({ ok: false, code: "already_set" });
  });

  it("cross-tenant: an envelope naming tenant A on tenant B's row, or B asking for A's row, is refused", async () => {
    const idB = await card(B);
    expect(await set(B, "channel_actions", idB, env(A))).toEqual({ ok: false, code: "wrong_tenant" });
    const idA = await card(A);
    expect(await set(B, "channel_actions", idA, env(B))).toEqual({ ok: false, code: "not_found" });
  });

  it("refuses an approved or executed row and a malformed envelope", async () => {
    expect(await set(A, "channel_actions", await card(A, "acted"), env(A))).toEqual({ ok: false, code: "not_pending" });
    const queued = await card(A);
    await db.query("update channel_actions set exec_status = 'queued' where id = $1", [queued]);
    expect(await set(A, "channel_actions", queued, env(A))).toEqual({ ok: false, code: "not_pending" });
    for (const bad of [env(A, { actor_role: "member" }), env(A, { max_total_usd: 0 }), env(A, { ends_on: "2026-10-15" }), env(A, { v: 2 })])
      expect(await set(A, "channel_actions", await card(), bad)).toEqual({ ok: false, code: "invalid_envelope" });
  });

  it("decisions: only a proposed card", async () => {
    const d = (await one<{ id: string }>("insert into decisions (tenant_id) values ($1) returning id", [A])).id;
    expect(await set(A, "decisions", d, env(A))).toEqual({ ok: true });
    const done = (await one<{ id: string }>("insert into decisions (tenant_id, status) values ($1, 'acted') returning id", [A])).id;
    expect(await set(A, "decisions", done, env(A))).toEqual({ ok: false, code: "not_pending" });
  });

  it("no other write can set or change the column", async () => {
    const id = await card();
    await expect(db.query("update channel_actions set approval_envelope = $2 where id = $1", [id, JSON.stringify(env(A))])).rejects.toThrow(/written only by set_approval_envelope/);
    await expect(db.query("insert into channel_actions (tenant_id, approval_envelope) values ($1, $2)", [A, JSON.stringify(env(A))])).rejects.toThrow(/written only by set_approval_envelope/);
    await db.query("update channel_actions set status = 'rejected' where id = $1", [id]);
  });

  it("the functions are service-role only", async () => {
    const r = await one<{ anon: boolean; svc: boolean }>("select has_function_privilege('anon', 'public.set_approval_envelope(uuid,text,uuid,jsonb)', 'execute') anon, has_function_privilege('service_role', 'public.set_approval_envelope(uuid,text,uuid,jsonb)', 'execute') svc");
    expect(r).toEqual({ anon: false, svc: true });
    const c = await one<{ auth: boolean }>("select has_function_privilege('authenticated', 'public.claim_approval_envelope(uuid,text,uuid,uuid)', 'execute') auth");
    expect(c.auth).toBe(false);
  });

  it("single use: the first action holds it, a second is refused; the same action replays", async () => {
    const [x, y] = [await card(), await card()];
    expect(await claim(A, "ask:r1", x)).toMatchObject({ ok: true });
    expect(await claim(A, "ask:r1", x)).toMatchObject({ ok: true, replayed: true });
    expect(await claim(A, "ask:r1", y)).toMatchObject({ ok: false, code: "claimed" });
    expect(await claim(A, "ask:r1", y, x)).toMatchObject({ ok: false, code: "holder_live" });
  });

  it("takeover only from a holder that failed and made nothing, exactly once", async () => {
    const [x, y, z] = [await card(), await card(), await card()];
    await claim(A, "ask:r2", x);
    await db.query("update channel_actions set exec_status = 'failed', exec_result = '{\"code\":\"chatgpt_ads_conflict\"}' where id = $1", [x]);
    expect(await claim(A, "ask:r2", y, x)).toMatchObject({ ok: true, took_over_from: x });
    expect(await claim(A, "ask:r2", z, x)).toMatchObject({ ok: false, code: "claimed" });
    expect((await one<{ n: string }>("select count(*) n from approval_envelope_claim_history where envelope_id = 'ask:r2'")).n).toBe("1");
    const [p, q] = [await card(), await card()];
    await claim(A, "ask:r3", p);
    await db.query("update channel_actions set exec_status = 'failed', exec_result = '{\"code\":\"exec_outcome_unknown\"}' where id = $1", [p]);
    expect(await claim(A, "ask:r3", q, p)).toMatchObject({ ok: false, code: "holder_live" });
    const [m, n] = [await card(), await card()];
    await claim(A, "ask:r4", m);
    await db.query("update channel_actions set exec_status = 'failed' where id = $1", [m]);
    await db.query("insert into ad_object_changes (tenant_id, action_table, action_id) values ($1, 'channel_actions', $2)", [A, m]);
    expect(await claim(A, "ask:r4", n, m)).toMatchObject({ ok: false, code: "holder_live" });
  });

  it("cross-tenant claim: another tenant's action is not found", async () => {
    expect(await claim(B, "ask:r5", await card(A))).toMatchObject({ ok: false, code: "not_found" });
  });
});
