import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, "../../../../../supabase/migrations", name), "utf8");
const MIGRATION = read("20261111230100_creator_offers_agent_run.sql");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const M1 = "aaaaaaaa-0000-4000-8000-000000000001";
const P1 = "bbbbbbbb-0000-4000-8000-000000000001";
const P2 = "bbbbbbbb-0000-4000-8000-000000000002";
const U1 = "cccccccc-0000-4000-8000-000000000001";
const RUN = "dddddddd-0000-4000-8000-000000000001";
const RUN2 = "dddddddd-0000-4000-8000-000000000002";
const M2 = "aaaaaaaa-0000-4000-8000-000000000002";

let db: PGlite;

async function booking(tenant: string, pkg: string, user: string | null, status = "checkout_pending", source = "booking") {
  await db.query(
    "insert into creator_orders (tenant_id, human_member_id, package_id, booked_by_user_id, status, source) values ($1, $2, $3, $4, $5, $6)",
    [tenant, M1, pkg, user, status, source],
  );
}

describe("20261111230100_creator_offers_agent_run.sql in Postgres", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create table tenants (id uuid primary key);
      insert into tenants values ('${T1}'), ('${T2}');
      create table agent_runs (id uuid primary key, tenant_id uuid not null, unique (id, tenant_id));
      insert into agent_runs values ('${RUN}', '${T1}'), ('${RUN2}', '${T1}');
      create table creator_offers (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants(id),
        human_member_id uuid not null,
        proposed_by text not null,
        proposed_by_user_id uuid,
        price_cents integer not null,
        status text not null default 'open'
      );
      create table creator_orders (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants(id),
        human_member_id uuid not null,
        package_id uuid,
        booked_by_user_id uuid,
        status text not null,
        source text not null
      );
      create unique index creator_orders_booking_pending_key
        on creator_orders (tenant_id, human_member_id, package_id, booked_by_user_id)
        where source = 'booking' and status = 'checkout_pending';
    `);
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("adds a nullable agent_run_id, and an offer without it still inserts", async () => {
    const col = await db.query<{ data_type: string; is_nullable: string }>(
      "select data_type, is_nullable from information_schema.columns where table_name = 'creator_offers' and column_name = 'agent_run_id'",
    );
    expect(col.rows).toEqual([{ data_type: "uuid", is_nullable: "YES" }]);
    await db.query("insert into creator_offers (tenant_id, human_member_id, proposed_by, proposed_by_user_id, price_cents) values ($1, $2, 'tenant', $3, 5000)", [T1, M1, U1]);
    await db.query("insert into creator_offers (tenant_id, human_member_id, proposed_by, agent_run_id, price_cents) values ($1, $2, 'tenant', $3, 5000)", [T1, M1, RUN]);
    const rows = await db.query<{ agent_run_id: string | null; proposed_by_user_id: string | null }>(
      "select agent_run_id, proposed_by_user_id from creator_offers order by agent_run_id nulls first",
    );
    expect(rows.rows).toEqual([
      { agent_run_id: null, proposed_by_user_id: U1 },
      { agent_run_id: RUN, proposed_by_user_id: null },
    ]);
  });

  it("refuses a second agent offer from the same run to the same creator in any status, and allows a different run, creator or a human offer", async () => {
    const offer = (run: string | null, member: string, status = "open", user: string | null = null) =>
      db.query(
        "insert into creator_offers (tenant_id, human_member_id, proposed_by, proposed_by_user_id, agent_run_id, price_cents, status) values ($1, $2, 'tenant', $3, $4, 5000, $5)",
        [T1, member, user, run, status],
      );
    await expect(offer(RUN, M1)).rejects.toMatchObject({ code: "23505" });
    await expect(offer(RUN, M1)).rejects.toThrow(/creator_offers_agent_run_member_key/);
    await db.query("update creator_offers set status = 'declined' where agent_run_id = $1 and human_member_id = $2", [RUN, M1]);
    await expect(offer(RUN, M1, "open")).rejects.toMatchObject({ code: "23505" });
    await offer(RUN2, M1);
    await offer(RUN, M2);
    await expect(offer(RUN2, M1, "expired")).rejects.toMatchObject({ code: "23505" });
    await offer(null, M1, "open", U1);
    await offer(null, M1, "open", U1);
    const n = await db.query<{ agent: number; human: number }>(
      "select count(*) filter (where agent_run_id is not null)::int as agent, count(*) filter (where agent_run_id is null)::int as human from creator_offers",
    );
    expect(n.rows[0]).toEqual({ agent: 3, human: 3 });
  });

  it("refuses a second pending agent booking for the same tenant, creator and package", async () => {
    await booking(T1, P1, null);
    await expect(booking(T1, P1, null)).rejects.toMatchObject({ code: "23505" });
    await expect(booking(T1, P1, null)).rejects.toThrow(/creator_orders_agent_booking_pending_key/);
  });

  it("still allows a founder booking next to an agent booking, and agent bookings that differ or are no longer pending", async () => {
    await booking(T1, P1, U1);
    await booking(T1, P2, null);
    await booking(T2, P1, null);
    await booking(T1, P1, null, "cancelled");
    await booking(T1, P1, null, "checkout_pending", "offer");
    const n = await db.query<{ n: number }>(
      "select count(*)::int as n from creator_orders where tenant_id = $1 and package_id = $2 and source = 'booking' and status = 'checkout_pending'",
      [T1, P1],
    );
    expect(n.rows[0].n).toBe(2);
  });

  it("over existing duplicate pending agent bookings it fails and changes nothing, so the guard is never silently missing", async () => {
    const fresh = new PGlite();
    try {
      await fresh.exec(`
        create table creator_offers (id uuid primary key, human_member_id uuid);
        create table creator_orders (tenant_id uuid, human_member_id uuid, package_id uuid, booked_by_user_id uuid, status text, source text);
        insert into creator_orders values ('${T1}', '${M1}', '${P1}', null, 'checkout_pending', 'booking'), ('${T1}', '${M1}', '${P1}', null, 'checkout_pending', 'booking');
      `);
      await expect(fresh.exec(MIGRATION)).rejects.toThrow(/duplicate pending agent bookings/);
      await fresh.exec("rollback").catch(() => undefined);
      const col = await fresh.query<{ n: number }>(
        "select count(*)::int as n from information_schema.columns where table_name = 'creator_offers' and column_name = 'agent_run_id'",
      );
      expect(col.rows[0].n).toBe(0);
      const rows = await fresh.query<{ n: number }>("select count(*)::int as n from creator_orders");
      expect(rows.rows[0].n).toBe(2);
    } finally {
      await fresh.close();
    }
  });
});
