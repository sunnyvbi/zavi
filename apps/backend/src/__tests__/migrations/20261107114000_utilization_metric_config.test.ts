import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000002";
const OUTSIDER = "aaaaaaaa-0000-4000-8000-000000000003";
const SIG = "uuid,uuid,timestamptz,bigint,text,text,text[],text,jsonb,text,text,text,text,text,jsonb";

let db: Pg | null = null;

type Args = {
  tenant?: string;
  user?: string;
  expected?: string | null;
  epoch?: number;
  locations?: string[];
  activeField?: string | null;
  activeValues?: unknown;
  statusField?: string | null;
  occupying?: unknown;
  start?: string;
};
function confirm(a: Args = {}) {
  return db!.query(`select * from confirm_utilization_metric_config($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb)`, [
    a.tenant ?? T1,
    a.user ?? OWNER,
    a.expected === undefined ? null : a.expected,
    a.epoch ?? 2,
    "units",
    "id",
    a.locations ?? ["city", "region"],
    a.activeField === undefined ? "state" : a.activeField,
    a.activeValues === undefined ? JSON.stringify(["live", true, 1]) : a.activeValues,
    "stays",
    "unit_id",
    a.start ?? "starts_at",
    "ends_at",
    a.statusField === undefined ? "status" : a.statusField,
    a.occupying === undefined ? JSON.stringify(["ok"]) : a.occupying,
  ]);
}
async function revision(): Promise<string> {
  const r = await db!.query("select updated_at::text as u from utilization_metric_config where tenant_id = $1", [T1]);
  return String(r.rows[0].u);
}

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("20261107114000_utilization_metric_config.sql in Postgres", () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table tenants (id uuid primary key);
      create table tenant_users (user_id uuid, tenant_id uuid, role text);
      create table tenant_db_generation (tenant_id uuid primary key, source_epoch bigint not null default 0);
      insert into tenants values ('${T1}'), ('${T2}');
      insert into tenant_users values ('${OWNER}', '${T1}', 'owner'), ('${MEMBER}', '${T1}', 'member'), ('${OUTSIDER}', '${T2}', 'owner');
      insert into tenant_db_generation values ('${T1}', 2);
    `);
    await db!.exec(read("20261107114000_utilization_metric_config.sql"));
    await db!.exec(read("20261107114000_utilization_metric_config.sql"));
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("only an owner/admin of THAT tenant may confirm", async () => {
    await expect(confirm({ user: MEMBER })).rejects.toThrow(/not an owner or admin/);
    await expect(confirm({ user: OUTSIDER })).rejects.toThrow(/not an owner or admin/);
  });

  it("refuses bad identifiers, value lists and half-set pairs", async () => {
    await expect(confirm({ locations: ["city", "x; drop table y"] })).rejects.toThrow(/bad field or table name/);
    await expect(confirm({ locations: ["a", "b", "c", "d"] })).rejects.toThrow(/1 to 3 location fields/);
    await expect(confirm({ start: "ends_at" })).rejects.toThrow(/different fields/);
    await expect(confirm({ activeValues: null })).rejects.toThrow(/active values/);
    await expect(confirm({ activeValues: JSON.stringify([{ a: 1 }]) })).rejects.toThrow(/active values/);
    await expect(confirm({ occupying: JSON.stringify([]) })).rejects.toThrow(/occupying values/);
    await expect(confirm({ statusField: null })).rejects.toThrow(/occupying values/);
  });

  it("refuses a different database source than the one the choices were checked against", async () => {
    await expect(confirm({ epoch: 1 })).rejects.toThrow(/database source changed/);
    await expect(confirm({ tenant: T2, user: OUTSIDER, epoch: 1 })).rejects.toThrow(/database source changed/);
  });

  it("first save expects no row; a correction must name the revision it was shown", async () => {
    const r = await confirm();
    expect(r.rows[0]).toMatchObject({ tenant_id: T1, confirmed_by: OWNER, location_fields: ["city", "region"], active_values: ["live", true, 1] });
    expect(Number(r.rows[0].source_epoch)).toBe(2);
    await expect(confirm()).rejects.toThrow(/changed since it was read/);
    await expect(confirm({ expected: "2000-01-01 00:00:00+00" })).rejects.toThrow(/changed since it was read/);
    const shown = await revision();
    const fixed = await confirm({ expected: shown, activeField: null, activeValues: null, statusField: null, occupying: null });
    expect(fixed.rows[0]).toMatchObject({ active_field: null, occupancy_status_field: null });
    await expect(confirm({ expected: shown })).rejects.toThrow(/changed since it was read/);
  });

  it("is not callable by anon or authenticated", async () => {
    const r = await db!.query(
      `select has_function_privilege('authenticated', 'confirm_utilization_metric_config(${SIG})', 'execute') as a, has_function_privilege('anon', 'confirm_utilization_metric_config(${SIG})', 'execute') as b`,
    );
    expect(r.rows[0]).toEqual({ a: false, b: false });
  });
});
