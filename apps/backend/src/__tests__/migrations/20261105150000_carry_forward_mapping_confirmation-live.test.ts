import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const SQL = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261105150000_carry_forward_mapping_confirmation.sql"), "utf8");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenant_db_catalog (tenant_id uuid primary key, catalog jsonb not null, catalog_hash text, discovery_error text);
  create table mapping_confirmed (
    tenant_id uuid not null, catalog_hash text not null, confirmed_map jsonb not null, confirmed_by uuid,
    confirmed_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    primary key (tenant_id, catalog_hash));
  create table tenant_db_config (tenant_id uuid primary key, mode text not null default 'direct', connection_secret_key text not null);
  create table secrets (tenant_id uuid not null, key text not null, vault_secret_id uuid, created_at timestamptz not null default now(), primary key (tenant_id, key));
`;

const TABLES = [
  { name: "trips", columns: [{ name: "createdAt", type: "Date" }, { name: "carId", type: "ObjectId" }] },
  { name: "cars", columns: [{ name: "_id", type: "ObjectId" }, { name: "listedAt", type: "Date|Null" }] },
];
const CONFIRMED_AT = "2026-10-09T16:37:19.000Z";
const MAP = {
  bookings: { table: "trips", created_at_field: "createdAt", listing_ref_field: "carId" },
  listings: { table: "cars", id_field: "_id", listed_at_field: "listedAt" },
  supply_demand: { version: 2, confirmed: true },
};

describe.skipIf(!URL)("carry_forward_mapping_confirmation (live)", () => {
  const c = new Client({ connectionString: URL });
  const T = randomUUID();
  const FOUNDER = randomUUID();

  beforeAll(async () => {
    await c.connect();
    const exists = await c.query("select to_regclass('public.mapping_confirmed') is not null as e");
    if (exists.rows[0].e) throw new Error("refusing: mapping_confirmed exists (not a vanilla database)");
    await c.query("begin");
    await c.query(BOOTSTRAP);
    await c.query(SQL);
  });
  afterAll(async () => {
    await c.query("rollback").catch(() => undefined);
    await c.end();
  });
  beforeEach(async () => {
    await c.query("delete from mapping_confirmed; delete from tenant_db_catalog; delete from tenant_db_config; delete from secrets;");
    await c.query("insert into tenant_db_catalog values ($1, $2, 'new', null)", [T, JSON.stringify({ tables: TABLES })]);
    await c.query("insert into tenant_db_config values ($1, 'direct', 'operator_db.connection_string')", [T]);
    await c.query("insert into secrets values ($1, 'operator_db.connection_string', null, '2026-08-31T03:00:00Z')", [T]);
    await c.query("insert into mapping_confirmed (tenant_id, catalog_hash, confirmed_map, confirmed_by, confirmed_at) values ($1, 'old', $2, $3, $4)", [T, JSON.stringify(MAP), FOUNDER, CONFIRMED_AT]);
  });
  const call = async (hash = "new") =>
    (await c.query("select carry_forward_mapping_confirmation($1, $2) as ok", [T, hash])).rows[0].ok as boolean;
  const row = async (hash: string) =>
    (await c.query("select confirmed_map, confirmed_by, confirmed_at from mapping_confirmed where tenant_id = $1 and catalog_hash = $2", [T, hash])).rows[0];

  it("copies the founder's map to the current hash, stamped, with the same confirmer and time", async () => {
    expect(await call()).toBe(true);
    const r = await row("new");
    expect(r.confirmed_by).toBe(FOUNDER);
    expect(new Date(r.confirmed_at).toISOString()).toBe(CONFIRMED_AT);
    expect(r.confirmed_map.bookings).toEqual({ ...MAP.bookings, carried_from: "old" });
    expect(r.confirmed_map.supply_demand).toEqual(MAP.supply_demand);
  });

  it("refuses a hash that is not the current one (stale caller / source changed)", async () => {
    expect(await call("stale")).toBe(false);
    expect(await row("stale")).toBeUndefined();
  });

  it("refuses when the current catalog has a discovery error", async () => {
    await c.query("update tenant_db_catalog set discovery_error = 'boom' where tenant_id = $1", [T]);
    expect(await call()).toBe(false);
  });

  it("never overwrites a confirmation already on the current hash", async () => {
    await c.query("insert into mapping_confirmed (tenant_id, catalog_hash, confirmed_map) values ($1, 'new', '{\"x\":{\"table\":\"cars\"}}')", [T]);
    expect(await call()).toBe(false);
    expect((await row("new")).confirmed_map).toEqual({ x: { table: "cars" } });
  });

  it("refuses when a table or a column is gone, or a table is ambiguous", async () => {
    for (const tables of [[TABLES[0]], [TABLES[0], { name: "cars", columns: [{ name: "_id", type: "ObjectId" }] }], [...TABLES, TABLES[1]]]) {
      await c.query("update tenant_db_catalog set catalog = $2 where tenant_id = $1", [T, JSON.stringify({ tables })]);
      expect(await call()).toBe(false);
      expect(await row("new")).toBeUndefined();
    }
  });

  it("never carries a Zavi-made row (no founder), and picks the latest founder row", async () => {
    await c.query("update mapping_confirmed set confirmed_by = null where tenant_id = $1", [T]);
    expect(await call()).toBe(false);
    await c.query("update mapping_confirmed set confirmed_by = $2 where tenant_id = $1", [T, FOUNDER]);
    await c.query("insert into mapping_confirmed (tenant_id, catalog_hash, confirmed_map, confirmed_by, confirmed_at) values ($1, 'older', '{\"users\":{\"table\":\"gone\"}}', $2, '2026-07-04')", [T, FOUNDER]);
    expect(await call()).toBe(true);
    expect((await row("new")).confirmed_map.bookings.carried_from).toBe("old");
  });

  it("refuses when the database credential changed after the confirmation (a reconnect)", async () => {
    await c.query("update secrets set created_at = '2026-10-14' where tenant_id = $1", [T]);
    expect(await call()).toBe(false);
  });

  it("refuses connector mode, and a missing credential", async () => {
    await c.query("update tenant_db_config set mode = 'connector' where tenant_id = $1", [T]);
    expect(await call()).toBe(false);
    await c.query("update tenant_db_config set mode = 'direct' where tenant_id = $1", [T]);
    await c.query("delete from secrets where tenant_id = $1", [T]);
    expect(await call()).toBe(false);
  });

  it("refuses a date column that is mixed-typed or lost its type", async () => {
    for (const type of ["Date|String", "String", ""]) {
      const tables = [{ name: "trips", columns: [{ name: "createdAt", type }, { name: "carId", type: "ObjectId" }] }, TABLES[1]];
      await c.query("update tenant_db_catalog set catalog = $2 where tenant_id = $1", [T, JSON.stringify({ tables })]);
      expect(await call()).toBe(false);
    }
    const tables = [{ name: "trips", columns: [{ name: "createdAt", type: "timestamp with time zone" }, { name: "carId", type: "bigint" }] }, TABLES[1]];
    await c.query("update tenant_db_catalog set catalog = $2 where tenant_id = $1", [T, JSON.stringify({ tables })]);
    expect(await call()).toBe(true);
  });

  it("is not callable by authenticated users", async () => {
    const r = await c.query("select has_function_privilege('authenticated', 'carry_forward_mapping_confirmation(uuid,text)', 'execute') as can");
    expect(r.rows[0].can).toBe(false);
  });
});
