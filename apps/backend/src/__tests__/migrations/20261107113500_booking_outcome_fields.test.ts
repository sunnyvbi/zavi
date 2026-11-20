import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { outcomeBasis } from "@/services/growth/booking-metrics/outcomes";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000002";
const OUTSIDER = "aaaaaaaa-0000-4000-8000-000000000003";

let db: Pg | null = null;

async function confirm(tenant: string, user: string, revision: string, statuses = ["completed"]) {
  return db!.query("select * from confirm_booking_outcome_fields($1, $2, $3, $4, $5, $6)", [
    tenant,
    "finished_at",
    "customer_id",
    statuses,
    user,
    revision,
  ]);
}
async function revision(tenant: string): Promise<string> {
  const r = await db!.query("select updated_at::text as u from booking_metric_config where tenant_id = $1", [tenant]);
  return String(r.rows[0].u);
}

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("20261107113500_booking_outcome_fields.sql in Postgres", () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table tenants (id uuid primary key);
      create table tenant_users (user_id uuid, tenant_id uuid, role text);
      insert into tenants values ('${T1}'), ('${T2}');
      insert into tenant_users values ('${OWNER}', '${T1}', 'owner'), ('${MEMBER}', '${T1}', 'member'), ('${OUTSIDER}', '${T2}', 'owner');
    `);
    await db!.exec(read("20260704000043_perfmkt_booking_metric_config_and_rollup.sql"));
    await db!.exec(read("20260704085241_perfmkt_booking_metric_config_amount_unit.sql"));
    await db!.exec(read("20261107113500_booking_outcome_fields.sql"));
    await db!.exec(read("20261107113500_booking_outcome_fields.sql"));
    await db!.exec(`
      insert into booking_metric_config (tenant_id, engine, booking_source, date_field, status_field, state, confirmed_by, confirmed_at)
      values ('${T1}', 'postgres', 'orders', 'created_at', 'status', 'confirmed', '${MEMBER}', now() - interval '1 day'),
             ('${T2}', 'postgres', 'orders', 'created_at', null, 'confirmed', '${OUTSIDER}', now());
    `);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("only an owner/admin of THAT tenant may confirm", async () => {
    const rev = await revision(T1);
    await expect(confirm(T1, MEMBER, rev)).rejects.toThrow(/not an owner or admin/);
    await expect(confirm(T1, OUTSIDER, rev)).rejects.toThrow(/not an owner or admin/);
  });

  it("refuses a mapping that changed since it was shown (stale revision), and one with no status field", async () => {
    await expect(confirm(T1, OWNER, "2000-01-01 00:00:00+00")).rejects.toThrow(/changed since it was read/);
    await expect(confirm(T2, OUTSIDER, await revision(T2))).rejects.toThrow(/no status field|changed since/);
  });

  it("saves the fields, stores the basis the read path computes, and makes the founder the base confirmer without moving confirmed_at", async () => {
    const shown = await revision(T1);
    const res = await confirm(T1, OWNER, shown, ["completed", "paid_out"]);
    const row = res.rows[0];
    expect(row.completed_at_field).toBe("finished_at");
    expect(row.customer_ref_field).toBe("customer_id");
    expect(row.terminal_statuses).toEqual(["completed", "paid_out"]);
    expect(row.outcome_basis).toBe(outcomeBasis(row));
    expect(row.outcome_confirmed_by).toBe(OWNER);
    expect(row.confirmed_by).toBe(OWNER);
    expect(new Date(String(row.confirmed_at)).getTime()).toBeLessThan(Date.now() - 3_600_000);
    await expect(confirm(T1, OWNER, shown)).rejects.toThrow(/changed since/);
  });

  it("the booking mapping RPC leaves the outcome fields alone on a re-save", async () => {
    await db!.exec(`update booking_metric_config set revenue_field = 'amount' where tenant_id = '${T1}'`);
    const r = await db!.query("select completed_at_field, terminal_statuses from booking_metric_config where tenant_id = $1", [T1]);
    expect(r.rows[0]).toEqual({ completed_at_field: "finished_at", terminal_statuses: ["completed", "paid_out"] });
  });

  it("is not callable by anon or authenticated", async () => {
    const r = await db!.query(
      "select has_function_privilege('authenticated', 'confirm_booking_outcome_fields(uuid,text,text,text[],uuid,timestamptz)', 'execute') as a, has_function_privilege('anon', 'confirm_booking_outcome_fields(uuid,text,text,text[],uuid,timestamptz)', 'execute') as b",
    );
    expect(r.rows[0]).toEqual({ a: false, b: false });
  });
});
