import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const MINE = ["20261108110000_email_result_rate_limit_gives_up.sql", "20261108110000_email_result_rate_limit_gives_up.sql"];

type Task = { id: string; lease: string; result: string };

describe.skipIf(!PGLITE_MODULES)("20261108110000 a provider that keeps answering 429 still lets day 7 go out (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];

  const seed = async (giveUpIn: string, due = "-1 minute"): Promise<Task> => {
    const result = (await one(
      `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, sent_count, started_at, finished_at, win_line, h1)
       values ($1, 'channel_actions', $2, 'sendgrid', 'sg-1', 100, now() - interval '8 days', now() - interval '8 days',
               '{"metric":"opens","threshold":0.2,"basis":"median","n_past":5}',
               '{"recipients":100,"delivered":90,"opens":30,"unsubscribes":1,"provider_status":"ok"}')
       returning id`,
      [T, randomUUID()],
    )).id as string;
    const lease = randomUUID();
    const id = (await one(
      `insert into email_result_tasks (tenant_id, result_id, source, stage, state, due_at, give_up_at, attempts, group_key, lease_token, lease_until, last_error)
       values ($1, $2, 'provider', 'd7', 'pending', now() + $3::interval, now() + $4::interval, 2, 'sendgrid:aaaa', $5, now() + interval '10 minutes', 'earlier 500')
       returning id`,
      [T, result, due, giveUpIn, lease],
    )).id as string;
    return { id, lease, result };
  };

  const complete = (t: Task, nextDue: string | null, error: string | null = "SendGrid returned 429") =>
    one("select complete_email_result_task($1, $2, $3, 'rate_limited', '{}', $4, $5, null, null) r", [T, t.id, t.lease, nextDue, error]).then((x) => x.r);
  const task = (t: Task) => one("select state, attempts, due_at, last_error, lease_token from email_result_tasks where id = $1", [t.id]);
  const result = (t: Task) => one("select d7, d7_published_at, verdict, d7_version from email_send_results where id = $1", [t.result]);
  const pastIso = (sql: string) => one(`select (now() + interval '${sql}') as at`).then((x) => (x.at as Date).toISOString());

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a 429 past give_up_at gives the check up and day 7 is published with the 1-hour numbers and a verdict", async () => {
    const t = await seed("-1 hour");
    const next = await pastIso("1 minute");
    expect(await complete(t, next)).toEqual({ ok: true, state: "gave_up" });
    expect(await task(t)).toMatchObject({ state: "gave_up", attempts: 2, last_error: "SendGrid returned 429", lease_token: null });
    const r = await result(t);
    expect(r.d7_published_at).not.toBeNull();
    expect(r.d7_version).toBe(1);
    expect(r.d7).toMatchObject({ provider_status: "could_not_read", delivered: 90, opens: 30, recipients: 100, unsubscribes: 1 });
    expect(r.d7.from_h1).toEqual(expect.arrayContaining(["delivered", "opens", "recipients", "unsubscribes"]));
    expect(r.verdict).toBe("beat");
    expect((await db.query("select claim_email_result_tasks(50, 600) j")).rows.map((x) => x.j.task_id)).not.toContain(t.id);
  });

  it("the worker's out-of-time hand-back (no next due, no error) past give_up_at also ends it, keeping the last error", async () => {
    const t = await seed("-5 minutes");
    expect(await complete(t, null, null)).toEqual({ ok: true, state: "gave_up" });
    expect(await task(t)).toMatchObject({ state: "gave_up", last_error: "earlier 500" });
    expect((await result(t)).d7_published_at).not.toBeNull();
  });

  it("a 429 whose wait would end at or after give_up_at gives up now, the same rule as a retry", async () => {
    const t = await seed("+30 minutes");
    expect(await complete(t, await pastIso("30 minutes"))).toEqual({ ok: true, state: "gave_up" });
    expect((await result(t)).d7_published_at).not.toBeNull();
  });

  it("a 429 before give_up_at stays pending, spends no attempt, is due at the wait, and day 7 is not published", async () => {
    const t = await seed("+1 day");
    const next = await pastIso("90 seconds");
    expect(await complete(t, next)).toEqual({ ok: true, state: "pending" });
    const row = await task(t);
    expect(row).toMatchObject({ state: "pending", attempts: 2, last_error: "earlier 500", lease_token: null });
    expect((row.due_at as Date).toISOString()).toBe(next);
    const r = await result(t);
    expect(r.d7_published_at).toBeNull();
    expect(r.d7).toEqual({});
    expect(r.d7_version).toBe(0);
  });
});
