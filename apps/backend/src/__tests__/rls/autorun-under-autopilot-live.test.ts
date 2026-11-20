import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChannelAutorun, type AutorunRow } from "@/services/growth/channel-autorun";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FOUNDER_IN_PLAN = read("20260911203038_founder_channel_in_plan.sql");
const MIGRATION = read("20261101090000_autorun_under_autopilot.sql");

const PG_URL = process.env.ZAVI_TEST_PG_URL;
const host = (() => {
  try {
    return PG_URL ? new URL(PG_URL).hostname : null;
  } catch {
    return null;
  }
})();
const LOCAL = host === "127.0.0.1" || host === "localhost" || host === "::1";
const SHOULD_RUN = !!PG_URL && LOCAL;
if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(`[autorun-under-autopilot-live] REQUIRE_RLS_MATRIX=1 but the suite would skip (url=${!!PG_URL}, local=${LOCAL}).`);
}

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenants (id uuid primary key);
  create table tenant_users (tenant_id uuid not null references tenants(id) on delete cascade, user_id uuid not null, role text not null, primary key (tenant_id, user_id));
  create table tenant_app_setting (
    tenant_id uuid not null references tenants(id) on delete cascade,
    key text not null,
    value jsonb,
    updated_at timestamptz default now(),
    updated_by text,
    primary key (tenant_id, key)
  );
  create table tenant_channels (
    tenant_id uuid not null references tenants(id) on delete cascade,
    channel_slug text not null,
    plan_selected boolean default false,
    plan_sort_order integer,
    autorun boolean default false,
    autorun_set_by text check (autorun_set_by is null or autorun_set_by in ('plan', 'founder')),
    chatgpt_autopilot_consent_at timestamptz,
    primary key (tenant_id, channel_slug)
  );
  create table growth_plan (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, status text not null, updated_at timestamptz);
  create table growth_plan_bets (id uuid primary key default gen_random_uuid(), plan_id uuid not null, status text not null, updated_at timestamptz);
`;

const BAKERY = randomUUID();
const GYM = randomUUID();
const OWNER = randomUUID();
const MEMBER = randomUUID();

type J = Record<string, unknown>;

describe.skipIf(!SHOULD_RUN)("autorun under Autopilot, live", () => {
  let admin: Client;
  let pool: Pool;
  let dbName = "";
  let tearingDown = false;
  let migratedAt = 0;

  const q = async <R = J>(sql: string, params: unknown[] = []): Promise<R[]> => (await pool.query(sql, params)).rows as R[];
  const one = async <R = J>(sql: string, params: unknown[] = []): Promise<R> => (await q<R>(sql, params))[0];
  const onAt = async (t: string) => (await one<{ on_at: Date | null } | undefined>("select on_at from cgo_autopilot_state where tenant_id = $1", [t]))?.on_at ?? null;
  const setAutopilot = (t: string, enabled: boolean, actor = OWNER) =>
    one<{ r: J }>("select set_cgo_autopilot($1, $2, $3) r", [t, enabled, actor]).then((x) => x.r);
  const founderSwitch = (t: string, slug: string, on: boolean) => one<{ r: boolean }>("select set_channel_autorun($1, $2, $3) r", [t, slug, on]).then((x) => x.r);
  const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const effective = async (t: string): Promise<Record<string, boolean>> => {
    const setting = await one<{ value: unknown } | undefined>("select value from tenant_app_setting where tenant_id = $1 and key = 'cgo_autopilot_enabled'", [t]);
    const state = await one<{ on_at: string | null } | undefined>(`select ${iso("on_at")} on_at from cgo_autopilot_state where tenant_id = $1`, [t]);
    const ap = { enabled: setting?.value === true, on_at: state?.on_at ?? null };
    const rows = await q<AutorunRow>(
      `select channel_slug, autorun, autorun_set_by, ${iso("autorun_set_at")} autorun_set_at, ${iso("chatgpt_autopilot_consent_at")} chatgpt_autopilot_consent_at
         from tenant_channels where tenant_id = $1 order by channel_slug`,
      [t],
    );
    return Object.fromEntries(rows.map((r) => [r.channel_slug, resolveChannelAutorun(ap, r.channel_slug, r).effective]));
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    dbName = `zavi_autorun_${randomBytes(6).toString("hex")}`;
    await admin.query(`create database ${dbName}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString(), max: 6 });
    pool.on("error", (err: Error & { code?: string }) => {
      if (!(tearingDown && err.code === "57P01")) throw err;
    });
    await pool.query(BOOTSTRAP);
    await pool.query(FOUNDER_IN_PLAN);
    for (const t of [BAKERY, GYM]) {
      await pool.query("insert into tenants values ($1)", [t]);
      await pool.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [t, OWNER, MEMBER]);
    }
    await pool.query("insert into tenant_app_setting (tenant_id, key, value, updated_by) values ($1, 'cgo_autopilot_enabled', 'true', 'user:x'), ($2, 'cgo_autopilot_enabled', 'false', 'user:x')", [BAKERY, GYM]);
    await pool.query(
      `insert into tenant_channels (tenant_id, channel_slug, plan_selected, autorun, autorun_set_by) values
         ($1, 'seo', true, false, 'plan'), ($1, 'meta_ads', true, false, 'founder'), ($1, 'email_marketing', false, false, null),
         ($1, 'chatgpt_ads', false, false, null), ($2, 'seo', true, false, 'plan')`,
      [BAKERY, GYM],
    );
    migratedAt = Date.now();
    await pool.query(MIGRATION);
  });

  afterAll(async () => {
    tearingDown = true;
    await pool?.end().catch(() => {});
    if (admin) {
      if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
      await admin.end();
    }
  });

  it("backfill: today's Autopilot tenant is stamped now and audited; every channel it has resolves on, the founder's old off too", async () => {
    const on = await onAt(BAKERY);
    expect(on).not.toBeNull();
    expect(Math.abs(on!.getTime() - migratedAt)).toBeLessThan(60_000);
    expect(await onAt(GYM)).toBeNull();
    expect(await q("select enabled, prior_enabled, actor from cgo_autopilot_audit where tenant_id = $1", [BAKERY])).toEqual([
      { enabled: true, prior_enabled: true, actor: "migration:20261101090000" },
    ]);
    expect(await effective(BAKERY)).toEqual({ chatgpt_ads: false, email_marketing: true, meta_ads: true, seo: true });
    expect(await effective(GYM)).toEqual({ seo: false });
  });

  it("set_cgo_autopilot: a member is refused and nothing changes", async () => {
    expect(await setAutopilot(GYM, true, MEMBER)).toEqual({ ok: false, code: "not_owner_or_admin" });
    expect(await onAt(GYM)).toBeNull();
    expect((await one<{ value: unknown }>("select value from tenant_app_setting where tenant_id = $1 and key = 'cgo_autopilot_enabled'", [GYM])).value).toBe(false);
  });

  it("set_cgo_autopilot: the owner turns it on, the ON instant and the audit row land with it, every channel resolves on", async () => {
    const r = await setAutopilot(GYM, true);
    expect(r).toMatchObject({ ok: true, enabled: true, prior: false });
    expect(r.on_at).toBeTruthy();
    expect(await effective(GYM)).toEqual({ seo: true });
    expect(await q("select enabled, prior_enabled, actor from cgo_autopilot_audit where tenant_id = $1 order by id", [GYM])).toEqual([
      { enabled: true, prior_enabled: false, actor: `user:${OWNER}` },
    ]);
  });

  it("the founder's ask-first after the ON is off; Autopilot off then on again resets it", async () => {
    expect(await founderSwitch(BAKERY, "email_marketing", false)).toBe(true);
    const row = await one<{ autorun_set_by: string; autorun_set_at: Date }>("select autorun_set_by, autorun_set_at from tenant_channels where tenant_id = $1 and channel_slug = 'email_marketing'", [BAKERY]);
    expect(row.autorun_set_by).toBe("founder");
    expect(row.autorun_set_at.getTime()).toBeGreaterThan((await onAt(BAKERY))!.getTime());
    expect((await effective(BAKERY)).email_marketing).toBe(false);

    const before = (await onAt(BAKERY))!.getTime();
    expect(await setAutopilot(BAKERY, false)).toMatchObject({ ok: true, enabled: false, prior: true });
    expect((await onAt(BAKERY))!.getTime()).toBe(before);
    expect(Object.values(await effective(BAKERY)).every((v) => v === false)).toBe(true);

    expect(await setAutopilot(BAKERY, true)).toMatchObject({ ok: true, enabled: true, prior: false });
    expect((await onAt(BAKERY))!.getTime()).toBeGreaterThan(before);
    expect(await effective(BAKERY)).toEqual({ chatgpt_ads: false, email_marketing: true, meta_ads: true, seo: true });
  });

  it("a repeated ON re-stamps the instant (it resets ask-first choices)", async () => {
    await founderSwitch(BAKERY, "seo", false);
    expect((await effective(BAKERY)).seo).toBe(false);
    const before = (await onAt(BAKERY))!.getTime();
    expect(await setAutopilot(BAKERY, true)).toMatchObject({ ok: true, prior: true });
    expect((await onAt(BAKERY))!.getTime()).toBeGreaterThan(before);
    expect((await effective(BAKERY)).seo).toBe(true);
  });

  it("any writer of the setting stamps it: the staff editor's plain upsert too", async () => {
    await pool.query("update tenant_app_setting set value = 'false' where tenant_id = $1 and key = 'cgo_autopilot_enabled'", [GYM]);
    const before = (await onAt(GYM))!.getTime();
    await pool.query(
      "insert into tenant_app_setting (tenant_id, key, value, updated_by) values ($1, 'cgo_autopilot_enabled', 'true', 'staff:s1') on conflict (tenant_id, key) do update set value = excluded.value, updated_by = excluded.updated_by",
      [GYM],
    );
    expect((await onAt(GYM))!.getTime()).toBeGreaterThan(before);
    expect((await q<{ actor: string }>("select actor from cgo_autopilot_audit where tenant_id = $1 order by id desc limit 1", [GYM]))[0].actor).toBe("staff:s1");
    const audits = (await q("select 1 from cgo_autopilot_audit where tenant_id = $1", [GYM])).length;
    await pool.query("insert into tenant_app_setting (tenant_id, key, value) values ($1, 'welcome_setup_enabled', 'true')", [GYM]);
    expect((await q("select 1 from cgo_autopilot_audit where tenant_id = $1", [GYM])).length).toBe(audits);
  });

  it("retire_growth_plan under Autopilot turns no channel off; the founder's ask-first survives it", async () => {
    await founderSwitch(BAKERY, "meta_ads", false);
    await pool.query("update tenant_channels set autorun = true, autorun_set_by = 'plan' where tenant_id = $1 and channel_slug = 'seo'", [BAKERY]);
    await pool.query("insert into growth_plan (tenant_id, status) values ($1, 'live')", [BAKERY]);
    await pool.query("select retire_growth_plan($1)", [BAKERY]);
    const seo = await one<J>("select autorun, autorun_set_by from tenant_channels where tenant_id = $1 and channel_slug = 'seo'", [BAKERY]);
    expect(seo).toEqual({ autorun: false, autorun_set_by: null });
    const e = await effective(BAKERY);
    expect(e.seo).toBe(true);
    expect(e.meta_ads).toBe(false);
  });

  it("a founder OFF racing an Autopilot ON resolves by their stamps, the same on every read", async () => {
    const c1 = await pool.connect();
    try {
      await c1.query("begin");
      await c1.query("select set_channel_autorun($1, 'email_marketing', false)", [BAKERY]);
      await new Promise((r) => setTimeout(r, 20));
      expect(await setAutopilot(BAKERY, true)).toMatchObject({ ok: true });
      await c1.query("commit");
    } finally {
      c1.release();
    }
    const reads = await Promise.all([effective(BAKERY), effective(BAKERY), effective(BAKERY)]);
    for (const r of reads) expect(r.email_marketing).toBe(true);

    await setAutopilot(BAKERY, true);
    await founderSwitch(BAKERY, "email_marketing", false);
    expect((await effective(BAKERY)).email_marketing).toBe(false);
  });

  it("the tables are service-role only, and deleting a tenant still cascades", async () => {
    const acl = await q<{ grantee: string }>(
      "select distinct grantee from information_schema.role_table_grants where table_name in ('cgo_autopilot_state', 'cgo_autopilot_audit') and grantee in ('anon', 'authenticated')",
    );
    expect(acl).toEqual([]);
    await pool.query("delete from tenants where id = $1", [GYM]);
    expect(await q("select 1 from cgo_autopilot_state where tenant_id = $1", [GYM])).toEqual([]);
    expect(await q("select 1 from tenant_app_setting where tenant_id = $1", [GYM])).toEqual([]);
  });
});
