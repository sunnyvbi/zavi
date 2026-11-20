import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261108140000_ad_guard_rules.sql"), "utf8")
  .replace(/^begin;$/m, "")
  .replace(/^commit;$/m, "");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenants (id uuid primary key);
  create table tenant_users (tenant_id uuid, user_id uuid, role text);
  create table tenant_rule_settings (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    suggestions_paused boolean not null default false,
    updated_by uuid,
    updated_at timestamptz not null default now()
  );
  create function _rules_assert_manager(p_tenant_id uuid, p_actor uuid) returns void language plpgsql as $$
  begin
    if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor and role in ('owner', 'admin')) then
      raise exception 'rules: only an owner or admin can do that' using errcode = '42501';
    end if;
  end $$;
`;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const OWNER = randomUUID();
const MEMBER = randomUUID();
const place = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Place ${id}`, kind: "City", platform: "meta", ...over });

describe.skipIf(!PG_URL)("ad_guard_rules migration, live", () => {
  let db: Client;
  const save = async (actor: string, guard: unknown) => (await db.query("select rule_set_ad_guard($1, $2, $3::jsonb) as r", [T, actor, JSON.stringify(guard)])).rows[0].r;

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const existing = await db.query("select 1 from information_schema.tables where table_name = 'tenant_rule_settings'");
    if (existing.rowCount) throw new Error("not a vanilla database");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query(MIGRATION);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [T, OWNER, MEMBER]);
  });
  afterAll(async () => {
    await db?.query("rollback").catch(() => undefined);
    await db?.end();
  });

  it("an owner saves the set, cleaned (phrases trimmed and de-duplicated, extra keys dropped)", async () => {
    const r = await save(OWNER, { allowed_places: [place("1", { extra: "x" })], blocked_places: [], banned_phrases: [" cheapest ", "cheapest", "guaranteed"] });
    expect(r.status).toBe("ok");
    expect(r.ad_guard.allowed_places).toEqual([place("1")]);
    expect(r.ad_guard.banned_phrases).toEqual(["cheapest", "guaranteed"]);
    const row = (await db.query("select ad_guard from tenant_rule_settings where tenant_id = $1", [T])).rows[0];
    expect(row.ad_guard).toEqual(r.ad_guard);
  });

  it("a member cannot save", async () => {
    await db.query("savepoint m");
    await expect(save(MEMBER, { allowed_places: [], blocked_places: [], banned_phrases: ["x"] })).rejects.toThrow(/only an owner or admin/);
    await db.query("rollback to savepoint m");
  });

  it("refuses more than 50, a place it cannot read, and a phrase out of bounds", async () => {
    await db.query("savepoint s");
    await expect(save(OWNER, { allowed_places: Array.from({ length: 51 }, (_, k) => place(String(k))), blocked_places: [], banned_phrases: [] })).rejects.toThrow(/up to 50/);
    await db.query("rollback to savepoint s");
    await expect(save(OWNER, { allowed_places: [], blocked_places: [place("9", { platform: "tiktok" })], banned_phrases: [] })).rejects.toThrow(/could not be read/);
    await db.query("rollback to savepoint s");
    await expect(save(OWNER, { allowed_places: [], blocked_places: [], banned_phrases: ["x".repeat(81)] })).rejects.toThrow(/1 to 80/);
    await db.query("rollback to savepoint s");
    await expect(save(OWNER, { allowed_places: [{ id: "1", kind: "City", platform: "meta" }], blocked_places: [], banned_phrases: [] })).rejects.toThrow(/could not be read/);
    await db.query("rollback to savepoint s");
  });
});
