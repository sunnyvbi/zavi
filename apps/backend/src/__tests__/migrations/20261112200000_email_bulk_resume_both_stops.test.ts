import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261112200000_email_bulk_resume_both_stops.sql";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table email_bulk_sends (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    list_id uuid not null, list_version_id uuid not null, from_address text not null,
    status text not null, hold_reason text, next_run_at timestamptz
  );
  create table email_bulk_send_recipients (send_id uuid not null, tenant_id uuid not null, status text not null);
  create table email_bulk_abuse_holds (tenant_id uuid primary key, cleared_at timestamptz);
  create table tenant_app_setting (tenant_id uuid, key text, value jsonb);
  create table app_setting (key text primary key, value jsonb not null);
  create table system_config (id int primary key, blob jsonb);
  create table tenant_sending_domain (tenant_id uuid primary key, domain text, verification_status text, provider_domain_id text);
  create table email_lists (id uuid primary key, tenant_id uuid not null, archived_at timestamptz);
  create table email_list_versions (id uuid primary key, list_id uuid not null, tenant_id uuid not null, consent_confirmed_at timestamptz);
`;

const modules = process.env.SITES_SQL_TEST_MODULES;

describe(`${FILE} executed in Postgres (pglite)`, () => {
  let db: Db;
  const T = randomUUID();
  const LIST = randomUUID();
  const VERSION = randomUUID();

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(readFileSync(join(MIGRATIONS, FILE), "utf-8"));
    await db.query("insert into tenant_sending_domain values ($1, 'brightloop.test', 'verified', 'sg-1')", [T]);
    await db.query("insert into email_lists values ($1, $2, null)", [LIST, T]);
    await db.query("insert into email_list_versions values ($1, $2, $3, now())", [VERSION, LIST, T]);
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec("delete from app_setting; delete from system_config;");
  });

  const heldSend = async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into email_bulk_sends (tenant_id, list_id, list_version_id, from_address, status, hold_reason) values ($1, $2, $3, 'hello@brightloop.test', 'held', 'provider_refused') returning id",
      [T, LIST, VERSION],
    );
    await db.query("insert into email_bulk_send_recipients values ($1, $2, 'pending')", [rows[0].id, T]);
    return rows[0].id;
  };
  const resume = async (id: string) =>
    (await db.query<{ r: { ok: boolean; reason?: string } }>("select email_bulk_resume_send($1, $2) r", [T, id])).rows[0].r;
  const statusOf = async (id: string) =>
    (await db.query<{ status: string }>("select status from email_bulk_sends where id = $1", [id])).rows[0].status;
  const setting = (v: string) => db.query("insert into app_setting values ('bulk_email_send_enabled', $1::jsonb)", [v]);
  const blob = (v: string) => db.query("insert into system_config values (1, $1::jsonb)", [v]);

  it("nothing stored, or both on: the send resumes", async () => {
    const a = await heldSend();
    expect(await resume(a)).toEqual({ ok: true, pending: 1 });
    expect(await statusOf(a)).toBe("sending");
    await setting("true");
    await blob('{"bulk_email_send_enabled": "TRUE"}');
    const b = await heldSend();
    expect(await resume(b)).toMatchObject({ ok: true });
  });

  it("the staff setting is off (boolean or legacy text): refused, the send stays held", async () => {
    for (const v of ["false", '"false"', '" False "']) {
      await db.exec("delete from app_setting");
      await setting(v);
      const id = await heldSend();
      expect(await resume(id)).toEqual({ ok: false, reason: "bulk_sending_paused" });
      expect(await statusOf(id)).toBe("held");
    }
  });

  it("the old system_config stop alone still refuses, including its text form", async () => {
    await setting("true");
    for (const v of ['{"bulk_email_send_enabled": false}', '{"bulk_email_send_enabled": "false"}']) {
      await db.exec("delete from system_config");
      await blob(v);
      const id = await heldSend();
      expect(await resume(id)).toEqual({ ok: false, reason: "bulk_sending_paused" });
    }
  });

  it("a value that is neither on nor off fails closed", async () => {
    for (const v of ['"off"', "0", "1", '""', '{"on": true}', '["true"]']) {
      await db.exec("delete from app_setting");
      await setting(v);
      const id = await heldSend();
      expect(await resume(id)).toEqual({ ok: false, reason: "bulk_sending_paused" });
    }
  });

  it("a JSON null in the setting is not a stop (the same as the backend's read)", async () => {
    await setting("null");
    expect(await resume(await heldSend())).toMatchObject({ ok: true });
  });

  it("a verified domain row with no provider record is not a sender: refused", async () => {
    await db.query("update tenant_sending_domain set provider_domain_id = null where tenant_id = $1", [T]);
    try {
      const id = await heldSend();
      expect(await resume(id)).toEqual({ ok: false, reason: "sending_domain_not_verified" });
      expect(await statusOf(id)).toBe("held");
    } finally {
      await db.query("update tenant_sending_domain set provider_domain_id = 'sg-1' where tenant_id = $1", [T]);
    }
  });

  it("the earlier refusals are unchanged: a send that is not held is not resumed", async () => {
    const id = await heldSend();
    await db.query("update email_bulk_sends set status = 'done' where id = $1", [id]);
    expect(await resume(id)).toEqual({ ok: false, reason: "not_held" });
  });

  it("only the service role may call either function", async () => {
    const { rows } = await db.query<{ fn: string; anon: boolean; authed: boolean; svc: boolean }>(
      `select p.proname fn,
              has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') authed,
              has_function_privilege('service_role', p.oid, 'execute') svc
         from pg_proc p where p.proname in ('email_bulk_resume_send', '_bulk_send_flag_running') order by 1`,
    );
    expect(rows).toEqual([
      { fn: "_bulk_send_flag_running", anon: false, authed: false, svc: true },
      { fn: "email_bulk_resume_send", anon: false, authed: false, svc: true },
    ]);
  });
});
