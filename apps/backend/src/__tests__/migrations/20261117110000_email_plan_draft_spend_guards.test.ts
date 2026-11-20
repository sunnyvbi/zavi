import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();

describe.skipIf(!PGLITE_MODULES)("20261117110000 planned drafts never start a paid run that cannot become an email (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  const zaviList = async () => (await one("insert into email_lists (tenant_id, name) values ($1, $2) returning id", [T, `Patients ${randomUUID()}`])).id as string;
  const item = async (over: { route?: string; list?: string; in?: string; status?: string } = {}) => {
    const route = over.route ?? "zavi_list";
    const list = over.list ?? (route === "zavi_list" ? await zaviList() : randomUUID());
    return (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status)
       values ($1, $2, $3, $4, 'Patients', now() + $5::interval, 'UTC', 'Flu shots', 'founder', $6, $7) returning id, schedule_gen`,
      [T, route, list, `${route}:${list}`, over.in ?? "20 hours", randomUUID(), over.status ?? "planned"],
    )) as { id: string; schedule_gen: number };
  };
  const leased = async (it: { id: string; schedule_gen: number }) => {
    const token = randomUUID();
    const id = (await one(
      `insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at, state, lease_token, lease_until)
       values ($1, $2, 'draft', $3, now(), 'leased', $4, now() + interval '10 minutes')
       on conflict (tenant_id, job_key) do update set state = 'leased', lease_token = excluded.lease_token, lease_until = excluded.lease_until
       returning id`,
      [T, it.id, `draft:${it.id}:v1:g${it.schedule_gen}`, token],
    )).id as string;
    return { id, token };
  };
  const begin = async (it: { id: string; schedule_gen: number }) => {
    const j = await leased(it);
    return r("select begin_email_plan_draft($1, $2, $3, $4) r", [T, it.id, j.id, j.token]);
  };
  const row = async (id: string) => one("select status, status_reason, draft_attempts from email_planned_sends where id = $1", [id]);
  const pause = (on: boolean) => r("select set_email_pause($1, $2, $3) r", [T, OWNER, on]);

  beforeAll(async () => {
    db = await bootEmailPipeline(["20261108100000_email_send_pause.sql", "20261117110000_email_plan_draft_spend_guards.sql"]);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("control: a planned item on a live list starts attempt 1", async () => {
    const it = await item();
    expect(await begin(it)).toMatchObject({ ok: true, attempt: 1 });
    expect(await row(it.id)).toMatchObject({ status: "drafting", draft_attempts: 1 });
  });

  it("email paused: no attempt is used, the item stays planned, and it can still draft once email is back on", async () => {
    const it = await item({ route: "mailchimp" });
    await pause(true);
    expect(await begin(it)).toMatchObject({ ok: true, attempt: null, reason: "paused" });
    expect(await begin(it)).toMatchObject({ attempt: null, reason: "paused" });
    expect(await row(it.id)).toEqual({ status: "planned", status_reason: null, draft_attempts: 0 });
    await pause(false);
    expect(await begin(it)).toMatchObject({ attempt: 1 });
  });

  it("email paused within 15 minutes of the planned time: skipped as paused with no attempt, other draft jobs close, and resuming does not bring it back", async () => {
    const it = await item({ route: "klaviyo", in: "10 minutes" });
    await db.query(
      `insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at) values ($1, $2, 'draft', $3, now() + interval '5 minutes')`,
      [T, it.id, `draft:${it.id}:v1:g${it.schedule_gen}:retry`],
    );
    await pause(true);
    expect(await begin(it)).toMatchObject({ attempt: null, status: "skipped", reason: "paused_too_late" });
    await pause(false);
    expect(await row(it.id)).toEqual({ status: "skipped", status_reason: "paused", draft_attempts: 0 });
    expect(await begin(it)).toMatchObject({ attempt: null, status: "skipped" });
    expect(await row(it.id)).toEqual({ status: "skipped", status_reason: "paused", draft_attempts: 0 });
    expect(await one("select count(*)::int n from email_plan_jobs where item_id = $1 and kind = 'draft' and state = 'pending'", [it.id])).toEqual({ n: 0 });
  });

  it("an archived Zavi list: skipped as list_archived with no attempt, and every pending job closes", async () => {
    const list = await zaviList();
    const it = await item({ list: list.toUpperCase() });
    await db.query(
      `insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at) values ($1, $2, 'deadline', $3, now() + interval '20 hours')`,
      [T, it.id, `deadline:${it.id}:g${it.schedule_gen}`],
    );
    await db.query("update email_lists set archived_at = now() where id = $1", [list]);
    expect(await begin(it)).toMatchObject({ attempt: null, status: "skipped", reason: "list_archived" });
    expect(await row(it.id)).toEqual({ status: "skipped", status_reason: "list_archived", draft_attempts: 0 });
    expect(await one("select count(*)::int n from email_plan_jobs where item_id = $1 and state = 'pending'", [it.id])).toEqual({ n: 0 });
  });

  it("a Zavi list removed outright is treated the same as archived", async () => {
    const it = await item({ list: randomUUID() });
    expect(await begin(it)).toMatchObject({ attempt: null, reason: "list_archived" });
  });

  const alone = (id: string) => db.query("delete from email_planned_sends where tenant_id = $1 and id <> $2", [T, id]);
  const draftJobs = async (id: string) =>
    (await db.query<{ job_key: string; due_in: number }>(
      "select job_key, extract(epoch from due_at - now())::int due_in from email_plan_jobs where item_id = $1 and kind = 'draft' and state = 'pending'",
      [id],
    )).rows;

  it("Move while Zavi is drafting does not start a second draft right away: the new draft waits for the running one's recheck", async () => {
    const it = await item({ in: "20 hours" });
    expect(await begin(it)).toMatchObject({ attempt: 1 });
    await db.query("update email_plan_jobs set state = 'pending', lease_token = null, lease_until = null, due_at = now() + interval '30 minutes' where item_id = $1", [it.id]);
    await alone(it.id);
    const out = await r("select move_email_planned_send($1, $2, $3, now() + interval '10 hours', $4, 'UTC') r", [T, OWNER, it.id, it.schedule_gen]);
    expect(out).toMatchObject({ ok: true, schedule_gen: it.schedule_gen + 1 });
    const jobs = await draftJobs(it.id);
    expect(jobs.map((j) => j.job_key)).toEqual([`draft:${it.id}:v1:g${it.schedule_gen + 1}`]);
    expect(jobs[0].due_in).toBeGreaterThan(29 * 60);
    expect(jobs[0].due_in).toBeLessThanOrEqual(30 * 60);
  });

  it("Move while drafting, with the run still holding its job, waits 45 minutes", async () => {
    const it = await item({ in: "20 hours" });
    expect(await begin(it)).toMatchObject({ attempt: 1 });
    await alone(it.id);
    await r("select move_email_planned_send($1, $2, $3, now() + interval '6 hours', $4, 'UTC') r", [T, OWNER, it.id, it.schedule_gen]);
    const jobs = await draftJobs(it.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].due_in).toBeGreaterThan(44 * 60);
    expect(jobs[0].due_in).toBeLessThanOrEqual(45 * 60);
  });

  it("Move while drafting to a week later keeps the day-before draft time", async () => {
    const it = await item({ in: "20 hours" });
    expect(await begin(it)).toMatchObject({ attempt: 1 });
    await alone(it.id);
    await r("select move_email_planned_send($1, $2, $3, now() + interval '8 days', $4, 'UTC') r", [T, OWNER, it.id, it.schedule_gen]);
    const [j] = await draftJobs(it.id);
    expect(Math.abs(j.due_in - 7 * 86400)).toBeLessThan(5);
  });

  it("Move while drafting to a time sooner than the recheck still drafts 20 minutes before it", async () => {
    const it = await item({ in: "20 hours" });
    expect(await begin(it)).toMatchObject({ attempt: 1 });
    await alone(it.id);
    await r("select move_email_planned_send($1, $2, $3, now() + interval '61 minutes', $4, 'UTC') r", [T, OWNER, it.id, it.schedule_gen]);
    const [j] = await draftJobs(it.id);
    expect(j.due_in).toBeGreaterThan(39 * 60);
    expect(j.due_in).toBeLessThanOrEqual(41 * 60);
  });

  it("Move of an item not yet drafting keeps the day-before draft time", async () => {
    const it = await item({ in: "3 days" });
    await alone(it.id);
    await r("select move_email_planned_send($1, $2, $3, now() + interval '5 days', $4, 'UTC') r", [T, OWNER, it.id, it.schedule_gen]);
    const [j] = await draftJobs(it.id);
    expect(Math.abs(j.due_in - 4 * 86400)).toBeLessThan(5);
  });

  it("Move of a planned item to within a day drafts now", async () => {
    const it = await item({ in: "3 days" });
    await alone(it.id);
    await r("select move_email_planned_send($1, $2, $3, now() + interval '5 hours', $4, 'UTC') r", [T, OWNER, it.id, it.schedule_gen]);
    const [j] = await draftJobs(it.id);
    expect(j.due_in).toBeLessThan(5);
  });
});
