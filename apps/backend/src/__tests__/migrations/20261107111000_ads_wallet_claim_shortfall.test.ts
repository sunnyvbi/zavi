import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SQL = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261107111000_ads_wallet_claim_shortfall.sql"), "utf8");
const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table ads_wallets (tenant_id uuid primary key, auto_refill_enabled boolean not null default false, payment_method_id text, stripe_customer_id text);
  create table ads_wallet_orders (id uuid primary key, tenant_id uuid not null, kind text not null check (kind in ('topup','refill','setup')),
    amount_cents integer not null check (amount_cents between 100 and 500000), status text not null default 'pending', refill_day date, payment_intent_id text,
    created_at timestamptz not null default now());
`;

describe.skipIf(!PG_URL)("ads_wallet_claim_shortfall, live", () => {
  let admin: Client;
  let db: Client;
  const dbName = `zavi_wallet_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const T = randomUUID();
  const claim = async (order: string, cents: number, tenant = T) => (await db.query("select ads_wallet_claim_shortfall($1, $2, $3) r", [tenant, order, cents])).rows[0].r;
  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(PG_URL!);
    url.pathname = `/${dbName}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(BOOTSTRAP);
    await db.query(SQL);
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  });

  it("no consented card -> no order", async () => {
    await db.query("insert into ads_wallets (tenant_id, auto_refill_enabled, payment_method_id, stripe_customer_id) values ($1, false, 'pm_1', 'cus_1')", [T]);
    expect(await claim(randomUUID(), 5800)).toEqual({ status: "no_consented_card" });
    expect((await db.query("select count(*)::int n from ads_wallet_orders")).rows[0].n).toBe(0);
  });
  it("a consented card -> one exact order; a replay returns it; another amount on the same id conflicts", async () => {
    await db.query("update ads_wallets set auto_refill_enabled = true where tenant_id = $1", [T]);
    const id = randomUUID();
    expect(await claim(id, 5800)).toMatchObject({ status: "claimed", order_id: id, order_status: "pending" });
    expect(await claim(id, 5800)).toMatchObject({ status: "claimed", replayed: true, payment_intent_id: null });
    await db.query("update ads_wallet_orders set payment_intent_id = 'pi_1' where id = $1", [id]);
    expect(await claim(id, 5800)).toMatchObject({ status: "claimed", replayed: true, order_status: "pending", payment_intent_id: "pi_1" });
    expect(await claim(id, 5900)).toEqual({ status: "conflict" });
    expect((await db.query("select kind, amount_cents, refill_day is not null as day from ads_wallet_orders where id = $1", [id])).rows[0]).toEqual({ kind: "refill", amount_cents: 5800, day: true });
    expect(await claim(id, 5800, randomUUID())).toEqual({ status: "no_wallet" });
  });
  it("the $1,000 a day cap is shared with refills", async () => {
    await db.query("insert into ads_wallet_orders (id, tenant_id, kind, amount_cents, refill_day) values ($1, $2, 'refill', 90000, (now() at time zone 'UTC')::date)", [randomUUID(), T]);
    expect(await claim(randomUUID(), 5000)).toEqual({ status: "daily_cap" });
    expect(await claim(randomUUID(), 4200)).toMatchObject({ status: "claimed" });
  });
  it("only $1 to $1,000", async () => {
    await expect(claim(randomUUID(), 50)).rejects.toThrow(/amount/);
    await expect(claim(randomUUID(), 100_001)).rejects.toThrow(/amount/);
  });
});
