import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEQUENCE_STEPS } from "@/services/onboarding-emails/steps";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const BASE = read("20261015020000_onboarding_email_sequence.sql");
const CLAIM_FIX = read("20261015130000_onboarding_email_claim_honours_opt_out.sql");
const THIS = read("20261105090000_onboarding_email_results.sql");

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const LEGACY = [0, 1, 2, 3, 4, 6, 7, 8, 9];

describe.skipIf(!PG_URL)("20261105090000 onboarding email results, live", () => {
  let db: Client;
  const ids: Record<string, string> = {};
  type Row = {
    status: string;
    last_step: number;
    sent_steps: number[];
    skipped_steps: number[];
    channel_order: number[] | null;
    digest_until: Date | null;
    next_due_at: Date | null;
    wait_since: Date | null;
  };
  const get = async (id: string): Promise<Row> =>
    (await db.query("select * from onboarding_email_sequence where id = $1", [id])).rows[0] as Row;
  const insert = async (o: { last_step?: number; status?: string; user?: string; due?: string | null }) =>
    (
      await db.query(
        `insert into onboarding_email_sequence (tenant_id, user_id, last_step, status, next_due_at)
         values ($1, $2, $3, $4, $5) returning id`,
        [T, o.user ?? randomUUID(), o.last_step ?? 0, o.status ?? "active", o.due === undefined ? new Date(Date.now() - 60_000) : o.due],
      )
    ).rows[0].id as string;
  const fn = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].r as boolean;

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = (await db.query("select to_regclass('public.onboarding_email_sequence')::text t")).rows[0].t;
    if (exists) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create table tenants (id uuid primary key);`);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query(BASE);
    await db.query(CLAIM_FIX);
    for (const s of LEGACY) ids[`active${s}`] = await insert({ last_step: s });
    ids.completed = await insert({ last_step: 9, status: "completed", due: null });
    ids.unsub = await insert({ last_step: 3, status: "unsubscribed", due: null });
    ids.stopped = await insert({ last_step: 2, status: "stopped", due: null });
    await db.query(THIS);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("backfills sent_steps with every old email at or below last_step, for every last_step", async () => {
    const order = SEQUENCE_STEPS.map((s) => s.step);
    for (const s of LEGACY) {
      const r = await get(ids[`active${s}`]);
      expect(r.sent_steps, `last_step ${s}`).toEqual(order.filter((x) => x <= s));
      expect(r.sent_steps).not.toContain(10);
    }
  });

  it("people already enrolled get a digest window; finished ones are active again and due now", async () => {
    const a = await get(ids.active3);
    expect(a.digest_until).not.toBeNull();
    const c = await get(ids.completed);
    expect(c.status).toBe("active");
    expect(c.next_due_at).not.toBeNull();
    expect(c.digest_until).not.toBeNull();
  });

  it("unsubscribed and stopped rows are not touched", async () => {
    for (const k of ["unsub", "stopped"]) {
      const r = await get(ids[k]);
      expect(r.digest_until, k).toBeNull();
      expect(r.next_due_at, k).toBeNull();
    }
    expect((await get(ids.unsub)).status).toBe("unsubscribed");
  });

  it("a person can hold only one live sequence", async () => {
    const user = randomUUID();
    const t2 = randomUUID();
    await db.query("insert into tenants values ($1)", [t2]);
    await insert({ user });
    await db.query("savepoint dup");
    await expect(
      db.query("insert into onboarding_email_sequence (tenant_id, user_id) values ($1, $2)", [t2, user]),
    ).rejects.toMatchObject({ code: "23505" });
    await db.query("rollback to savepoint dup");
  });

  it("the OLD claim (code mid-deploy) records the step; the old release keeps it, so the new sender never re-sends", async () => {
    const id = await insert({ last_step: 3, user: randomUUID() });
    expect(await fn("select onboarding_email_claim($1, 4, now() + interval '1 day') r", [id])).toBe(true);
    expect((await get(id)).sent_steps).toEqual([4]);
    expect(await fn("select onboarding_email_release($1, 4, 3, null, 'x') r", [id])).toBe(true);
    expect((await get(id)).sent_steps).toEqual([4]);
  });

  it("the OLD claim never re-sends a step the new code already sent out of order", async () => {
    const id = await insert({ last_step: 3, user: randomUUID() });
    await db.query("update onboarding_email_sequence set sent_steps = array[1,2,3,6] where id = $1", [id]);
    expect(await fn("select onboarding_email_claim($1, 6, now() + interval '1 day') r", [id])).toBe(false);
    expect(await fn("select onboarding_email_claim($1, 4, now() + interval '1 day') r", [id])).toBe(true);
  });

  it("claim_step refuses a step already sent, records skips and the order once", async () => {
    const id = await insert({ last_step: 0, user: randomUUID() });
    await db.query("update onboarding_email_sequence set sent_steps = '{1}', last_step = 1 where id = $1", [id]);
    const claim = (step: number, skip: number[], order: number[] | null, due = "now() + interval '1 day'") =>
      fn(`select onboarding_email_claim_step($1, $2, '{}', $3, ${due}, $4) r`, [id, step, skip, order]);
    expect(await claim(1, [], null)).toBe(false);
    expect(await claim(10, [2], null)).toBe(true);
    let r = await get(id);
    expect(r.sent_steps).toEqual([1, 10]);
    expect(r.skipped_steps).toEqual([2]);
    expect(await claim(6, [], [6, 3, 4, 7])).toBe(false);
    await db.query("update onboarding_email_sequence set next_due_at = now() - interval '1 minute', wait_since = now() where id = $1", [id]);
    expect(await claim(6, [3], [6, 3, 4, 7])).toBe(true);
    r = await get(id);
    expect(r.channel_order).toEqual([6, 3, 4, 7]);
    expect(r.wait_since).toBeNull();
    await db.query("update onboarding_email_sequence set next_due_at = now() - interval '1 minute' where id = $1", [id]);
    expect(await claim(4, [], [4, 3, 6, 7])).toBe(true);
    expect((await get(id)).channel_order).toEqual([6, 3, 4, 7]);
    expect(
      await fn("select onboarding_email_release_step($1, 4, '{}', '{}', 6, now(), 'rejected') r", [id]),
    ).toBe(true);
    r = await get(id);
    expect(r.sent_steps).toEqual([1, 6, 10]);
    expect(r.skipped_steps).toEqual([2, 3]);
    expect(r.last_step).toBe(6);
    expect(await fn("select onboarding_email_release_step($1, 10, '{}', '{2}', 1, null, 'late') r", [id])).toBe(false);
  });

  it("claim_step with no next email completes the row", async () => {
    const id = await insert({ user: randomUUID() });
    expect(await fn("select onboarding_email_claim_step($1, 9, '{}', '{}', null, null) r", [id])).toBe(true);
    expect((await get(id)).status).toBe("completed");
  });

  it("an unsubscribed person is never claimed, by either claim", async () => {
    const user = randomUUID();
    const t2 = randomUUID();
    await db.query("insert into tenants values ($1)", [t2]);
    const live = await insert({ user });
    await db.query(
      "insert into onboarding_email_sequence (tenant_id, user_id, status, next_due_at) values ($1, $2, 'unsubscribed', null)",
      [t2, user],
    );
    expect(await fn("select onboarding_email_claim_step($1, 1, '{}', '{}', now() + interval '1 day', null) r", [live])).toBe(false);
    expect(await fn("select onboarding_email_claim($1, 1, now() + interval '1 day') r", [live])).toBe(false);
  });

  it("only the service role may call the new functions", async () => {
    for (const f of ["onboarding_email_claim_step", "onboarding_email_release_step"]) {
      const r = await db.query(
        `select has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u,
                has_function_privilege('service_role', p.oid, 'execute') s
           from pg_proc p where p.proname = $1`,
        [f],
      );
      expect(r.rows[0], f).toEqual({ a: false, u: false, s: true });
    }
  });
});
