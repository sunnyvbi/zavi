import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_CARD_CAP_PER_RUN, EMAIL_CARD_CAP_PER_TENANT_24H } from "@/services/tools/email/propose_campaign";

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const SQL = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261101174400_email_card_reservations.sql"), "utf-8");

describe.skipIf(!PG_URL)("20261101174400 email card reservations, live and concurrent", () => {
  let admin: Client;
  let createdTenants = false;
  let createdRuns = false;

  const reserveInOwnConnection = async (tenant: string, run: string | null): Promise<Record<string, unknown>> => {
    const c = new Client({ connectionString: PG_URL });
    await c.connect();
    try {
      const { rows } = await c.query("select reserve_email_card($1, $2, $3, $4) r", [tenant, run, EMAIL_CARD_CAP_PER_RUN, EMAIL_CARD_CAP_PER_TENANT_24H]);
      return rows[0].r as Record<string, unknown>;
    } finally {
      await c.end();
    }
  };
  const tenant = async (): Promise<string> => {
    const id = randomUUID();
    await admin.query("insert into tenants (id) values ($1)", [id]);
    return id;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    const exists = (await admin.query("select to_regclass('public.email_card_reservations')::text t")).rows[0].t;
    if (exists) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database (email_card_reservations already exists)");
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$;`);
    if (!(await admin.query("select to_regclass('public.tenants')::text t")).rows[0].t) {
      await admin.query("create table public.tenants (id uuid primary key)");
      createdTenants = true;
    }
    if (!(await admin.query("select to_regclass('public.agent_runs')::text t")).rows[0].t) {
      await admin.query("create table public.agent_runs (id uuid primary key, tenant_id uuid not null, status text)");
      createdRuns = true;
    }
    await admin.query(SQL);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query("drop function if exists public.reserve_email_card(uuid, uuid, int, int)");
    await admin.query("drop function if exists public.release_email_card_reservation(uuid, uuid)");
    await admin.query("drop function if exists public.settle_email_card_reservation(uuid, uuid, uuid)");
    await admin.query("drop table if exists public.email_card_reservations");
    if (createdRuns) await admin.query("drop table if exists public.agent_runs");
    if (createdTenants) await admin.query("drop table if exists public.tenants");
    await admin.end();
  });

  it("12 concurrent proposes in one run: exactly 3 get a card", async () => {
    const t = await tenant();
    const run = randomUUID();
    const out = await Promise.all(Array.from({ length: 12 }, () => reserveInOwnConnection(t, run)));
    expect(out.filter((r) => r.ok === true)).toHaveLength(EMAIL_CARD_CAP_PER_RUN);
    expect(out.filter((r) => r.ok === false).every((r) => r.code === "run_cap")).toBe(true);
    expect(Number((await admin.query("select count(*) n from email_card_reservations where tenant_id = $1", [t])).rows[0].n)).toBe(3);
  });

  it("40 concurrent proposes from 40 runs on one tenant: exactly 20 get a card", async () => {
    const t = await tenant();
    const out = await Promise.all(Array.from({ length: 40 }, () => reserveInOwnConnection(t, randomUUID())));
    expect(out.filter((r) => r.ok === true)).toHaveLength(EMAIL_CARD_CAP_PER_TENANT_24H);
    expect(out.filter((r) => r.ok === false).every((r) => r.code === "tenant_cap")).toBe(true);
  });

  it("a release gives one slot back; a reservation older than 24h no longer counts; another tenant is untouched", async () => {
    const t = await tenant();
    const run = randomUUID();
    const first = await reserveInOwnConnection(t, run);
    await reserveInOwnConnection(t, run);
    await reserveInOwnConnection(t, run);
    expect((await reserveInOwnConnection(t, run)).code).toBe("run_cap");
    await admin.query("select release_email_card_reservation($1, $2)", [t, first.id]);
    expect((await reserveInOwnConnection(t, run)).ok).toBe(true);

    const old = await tenant();
    await admin.query(
      "insert into email_card_reservations (tenant_id, run_id, created_at) select $1, gen_random_uuid(), now() - interval '25 hours' from generate_series(1, 20)",
      [old],
    );
    expect((await reserveInOwnConnection(old, randomUUID())).ok).toBe(true);

    const other = await tenant();
    expect((await reserveInOwnConnection(other, run)).ok).toBe(true);
  });

  const settleInOwnConnection = async (tenant: string, id: unknown, card: string): Promise<Record<string, unknown>> => {
    const c = new Client({ connectionString: PG_URL });
    await c.connect();
    try {
      return (await c.query("select settle_email_card_reservation($1, $2, $3) r", [tenant, id, card])).rows[0].r as Record<string, unknown>;
    } finally {
      await c.end();
    }
  };
  const held = async (tenant: string): Promise<number> =>
    Number((await admin.query("select count(*) n from email_card_reservations where tenant_id = $1", [tenant])).rows[0].n);

  it("replays of one card hold one slot: 6 concurrent proposes that all return the same card leave 1 reservation", async () => {
    const t = await tenant();
    const run = randomUUID();
    const card = randomUUID();
    const out = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const r = await reserveInOwnConnection(t, run);
        return r.ok === true ? settleInOwnConnection(t, r.id, card) : r;
      }),
    );
    expect(await held(t)).toBe(1);
    expect(out.filter((r) => r.released === true).length + out.filter((r) => r.code === "run_cap").length).toBe(5);
    for (let i = 0; i < 2; i++) {
      const r = await reserveInOwnConnection(t, run);
      expect(r.ok).toBe(true);
      await settleInOwnConnection(t, r.id, randomUUID());
    }
    expect((await reserveInOwnConnection(t, run)).code).toBe("run_cap");
  });

  it("a reserve prunes this tenant's rows older than 25 hours, and only this tenant's", async () => {
    const t = await tenant();
    const other = await tenant();
    for (const id of [t, other]) {
      await admin.query(
        "insert into email_card_reservations (tenant_id, run_id, created_at) select $1, gen_random_uuid(), now() - interval '30 hours' from generate_series(1, 5)",
        [id],
      );
    }
    expect((await reserveInOwnConnection(t, randomUUID())).ok).toBe(true);
    expect(await held(t)).toBe(1);
    expect(await held(other)).toBe(5);
  });

  const runRow = async (t: string, status: string): Promise<string> => {
    const id = randomUUID();
    await admin.query("insert into agent_runs (id, tenant_id, status) values ($1, $2, $3)", [id, t, status]);
    return id;
  };
  const oldCards = async (t: string, run: string | null, n = 3): Promise<void> => {
    await admin.query(
      "insert into email_card_reservations (tenant_id, run_id, created_at) select $1, $2, now() - interval '30 hours' from generate_series(1, $3)",
      [t, run, n],
    );
  };
  const heldBy = async (t: string, run: string): Promise<number> =>
    Number((await admin.query("select count(*) n from email_card_reservations where tenant_id = $1 and run_id = $2", [t, run])).rows[0].n);

  it("a run still going keeps its old cards when another run or a run-less caller reserves; its 4th is refused", async () => {
    const t = await tenant();
    const a = await runRow(t, "running");
    await oldCards(t, a);
    expect((await reserveInOwnConnection(t, await runRow(t, "running"))).ok).toBe(true);
    expect((await reserveInOwnConnection(t, null)).ok).toBe(true);
    expect(await heldBy(t, a)).toBe(3);
    expect((await reserveInOwnConnection(t, a)).code).toBe("run_cap");
  });

  it("a paused run (not finished) keeps its old cards too", async () => {
    const t = await tenant();
    const a = await runRow(t, "paused_awaiting_approval");
    await oldCards(t, a);
    await reserveInOwnConnection(t, null);
    expect(await heldBy(t, a)).toBe(3);
  });

  it("once the run has finished, another run's reserve prunes its old rows (and still spares a live run's)", async () => {
    const t = await tenant();
    const a = await runRow(t, "running");
    const live = await runRow(t, "running");
    await oldCards(t, a);
    await oldCards(t, live);
    await reserveInOwnConnection(t, await runRow(t, "running"));
    expect(await heldBy(t, a)).toBe(3);
    await admin.query("update agent_runs set status = 'success' where id = $1", [a]);
    expect((await reserveInOwnConnection(t, await runRow(t, "running"))).ok).toBe(true);
    expect(await heldBy(t, a)).toBe(0);
    expect(await heldBy(t, live)).toBe(3);
  });

  it("run-less old rows are pruned, while a live run's old rows stay", async () => {
    const t = await tenant();
    const live = await runRow(t, "running");
    await oldCards(t, null, 4);
    await oldCards(t, live);
    await reserveInOwnConnection(t, null);
    expect(Number((await admin.query("select count(*) n from email_card_reservations where tenant_id = $1 and run_id is null and created_at < now() - interval '25 hours'", [t])).rows[0].n)).toBe(0);
    expect(await heldBy(t, live)).toBe(3);
  });

  it("a run older than 25 hours keeps its own cards: its 4th card is refused, and they are not pruned", async () => {
    const t = await tenant();
    const run = await runRow(t, "running");
    await admin.query(
      "insert into email_card_reservations (tenant_id, run_id, created_at) select $1, $2, now() - interval '30 hours' from generate_series(1, 3)",
      [t, run],
    );
    expect((await reserveInOwnConnection(t, run)).code).toBe("run_cap");
    expect(await held(t)).toBe(3);
  });

  it("a release names its tenant: another tenant's id releases nothing", async () => {
    const t = await tenant();
    const r = await reserveInOwnConnection(t, randomUUID());
    const { rows } = await admin.query("select release_email_card_reservation($1, $2) r", [randomUUID(), r.id]);
    expect(rows[0].r).toEqual({ ok: true, released: false });
  });
});
