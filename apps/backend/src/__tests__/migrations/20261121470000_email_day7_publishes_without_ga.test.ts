import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";
import { runEmailResultsPass, type CheckDeps, type ClaimedTask } from "@/services/email-results/check";
import { day7NoteLines, markDay7Told, type Day7NoteDeps } from "@/services/email-results/note";
import { rowFromResult } from "@/services/email-results/view";

const MIGRATION = "20261121470000_email_day7_publishes_without_ga.sql";
const MINE = ["20261101193700_email_learnings.sql", "20261108110000_email_result_rate_limit_gives_up.sql", MIGRATION, MIGRATION];

const VISITORS = { metric: "visitors", threshold: 0.02, basis: "median", n_past: 5 };
const OPENS = { metric: "opens", threshold: 0.2, basis: "median", n_past: 5 };
const PROVIDER = { delivered: 90, opens: 30, machine_opens: 1, unsubscribes: 1, recipients: 100, clicks: null, clicks_off: true, bounces: 0 };

describe.skipIf(!PGLITE_MODULES)("20261121470000 day 7 publishes without waiting for Google Analytics (pglite)", () => {
  let db: Db;
  let T: string;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const all = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

  let ga: { connected: boolean; visitors: number | null; reads: number };
  let bulkReads: number;

  const complete: CheckDeps["complete"] = async (t, c) => {
    const out = (await one("select complete_email_result_task($1, $2, $3, $4, $5, $6, $7, $8, $9) r", [
      t.tenant_id, t.task_id, t.lease_token, c.outcome, JSON.stringify(c.result ?? {}), c.next_due?.toISOString() ?? null, c.error ?? null, c.ga ? JSON.stringify(c.ga) : null, c.note ?? null,
    ])).r as { ok?: boolean; code?: string };
    if (!out.ok && out.code !== "not_owner") throw new Error(out.code);
  };

  const deps = (): CheckDeps => ({
    claim: async (limit, lease) => (await all("select claim_email_result_tasks($1, $2) t", [limit, lease])).map((x) => x.t as ClaimedTask),
    complete,
    providerAccess: async () => ({ kind: "none" }),
    bulkCounts: async () => (bulkReads++, { sent: 100, delivered: 90, opens: 30, machine_opens: 1, unsubscribes: 1, hard_bounces: 0, delivered_seen_at: "2026-10-01T00:00:00Z" }),
    gaCreds: async () => (ga.connected ? ({ property_id: "123" } as never) : null),
    gaReport: async () => {
      ga.reads++;
      if (ga.visitors === null) throw new Error("GA returned 500");
      return { rows: [{ metricValues: [{ value: String(ga.visitors) }] }] } as never;
    },
    missing: async () => [],
    start: async () => ({ started: false }) as never,
    holdRepair: async () => undefined,
    backlog: async () => ({ due: 0, oldest_due_at: null, newly_stuck: [] }),
    purgeEventIds: async () => 0,
    alertStuck: async () => undefined,
    log: async () => undefined,
    now: () => new Date(),
  });

  const noteDeps = (): Day7NoteDeps => ({
    untold: async (tenant, limit) =>
      (await all(
        `select id, d7_version, route, subject, list_name, win_line, d7, verdict, note from email_send_results
          where tenant_id = $1 and d7_published_at is not null and d7_told_at is null order by d7_published_at limit $2`,
        [tenant, limit],
      )) as never,
    markTold: async (tenant, marks) => {
      await one("select mark_email_results_told($1, $2) r", [tenant, JSON.stringify(marks)]);
    },
  });

  type Seed = { win?: unknown; gaDue?: string; gaGiveUp?: string; slug?: string };
  const seed = async ({ win = VISITORS, gaDue = "12 hours", gaGiveUp = "3 days", slug = "launch" }: Seed = {}) => {
    const id = (await one(
      `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, subject, campaign_slug, ga_timezone, sent_count, started_at, finished_at, win_line, h1)
       values ($1, 'decisions', $2, 'zavi_list', $3, 'Launch', $4, 'UTC', 100, now() - interval '7 days 1 hour', now() - interval '7 days', $5,
               '{"recipients":100,"delivered":80,"opens":10,"provider_status":"ok"}') returning id`,
      [T, randomUUID(), randomUUID(), `${slug}-${randomUUID()}`, JSON.stringify(win)],
    )).id as string;
    await db.query(
      `insert into email_result_tasks (tenant_id, result_id, source, stage, due_at, give_up_at, group_key) values
       ($1, $2, 'provider', 'd7', now() - interval '1 minute', now() + interval '3 days', 'zavi'),
       ($1, $2, 'ga', 'd7', now() + $3::interval, now() + $4::interval, 'ga:x')`,
      [T, id, gaDue, gaGiveUp],
    );
    return id;
  };

  const row = (id: string) => one("select * from email_send_results where id = $1", [id]);
  const gaTask = (id: string) => one("select * from email_result_tasks where result_id = $1 and source = 'ga'", [id]);
  const gaDue = (id: string, giveUp?: string) =>
    db.query(`update email_result_tasks set due_at = now() - interval '1 second'${giveUp ? `, give_up_at = now() + '${giveUp}'::interval` : ""} where result_id = $1 and source = 'ga'`, [id]);
  const providerOf = (d7: Record<string, unknown>) => {
    const { visitors: _v, ga_status: _s, ga_as_of: _a, ...rest } = d7;
    return rest;
  };
  const learnKeys = async (id: string) => (await all("select dedupe_key k from email_learn_work where dedupe_key like $1 order by k", [`result:${id}:%`])).map((x) => (x.k as string).slice(`result:${id}:`.length));
  const lines = async () => (await day7NoteLines(T, noteDeps())).lines;
  const tellNote = async () => {
    const n = await day7NoteLines(T, noteDeps());
    await markDay7Told(T, n.marks, noteDeps());
    return n.lines;
  };
  const view = async (id: string) => rowFromResult((await row(id)) as never);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
  }, 120_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    T = randomUUID();
    await db.query("insert into tenants (id) values ($1)", [T]);
    ga = { connected: true, visitors: 5, reads: 0 };
    bulkReads = 0;
  });

  it("GA waiting at the provider read: day 7 is out with no verdict guess, nothing tells it yet, and the table says it waits", async () => {
    const id = await seed();
    await runEmailResultsPass(deps());
    const r = await row(id);
    expect(r.d7_published_at).not.toBeNull();
    expect(r.d7).toMatchObject({ delivered: 90, opens: 30, provider_status: "ok" });
    expect(r.d7.visitors).toBeUndefined();
    expect(r.verdict).toBeNull();
    expect(r.d7_version).toBe(1);
    expect(ga.reads).toBe(0);
    expect((await gaTask(id)).state).toBe("pending");
    expect(await lines()).toEqual([]);
    expect(await learnKeys(id)).toEqual(["1"]);
    const v = await view(id);
    expect(v).toMatchObject({ as_of: "d7", stage: "d7", delivered: { value: 90 }, verdict: null, verdict_text: "Waiting for Google Analytics", visitors: { value: null } });
    expect(v.visitors.why).toMatch(/^Due /);
  });

  it("GA arrives after publish: visitors fill in, provider numbers and published time stay, the verdict lands and is told exactly once", async () => {
    const id = await seed();
    await runEmailResultsPass(deps());
    const before = await row(id);
    await gaDue(id);
    await runEmailResultsPass(deps());
    const after = await row(id);
    expect(after.d7.visitors).toBe(5);
    expect(after.d7.ga_status).toBe("ok");
    expect(providerOf(after.d7)).toEqual(providerOf(before.d7));
    expect(after.d7_published_at).toEqual(before.d7_published_at);
    expect(after.verdict).toBe("beat");
    expect(after.d7_version).toBe(2);
    expect(await learnKeys(id)).toEqual(["1", "2"]);
    const told = await tellNote();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/visited your site.*Beat it/);
    expect(await lines()).toEqual([]);
    expect(await view(id)).toMatchObject({ verdict_text: "Beat the win line", visitors: { value: 5 } });
  });

  it("a win line GA cannot move: told at publish, the late visitors are kept and learned from, nothing is told twice", async () => {
    const id = await seed({ win: OPENS });
    await runEmailResultsPass(deps());
    const before = await row(id);
    expect(before.verdict).toBe("beat");
    expect(await tellNote()).toHaveLength(1);
    const told = (await row(id)).d7_told_at;
    expect(told).not.toBeNull();
    await gaDue(id);
    await runEmailResultsPass(deps());
    const after = await row(id);
    expect(after.d7.visitors).toBe(5);
    expect(after.verdict).toBe("beat");
    expect(after.d7_version).toBe(1);
    expect(after.d7_told_at).toEqual(told);
    expect(after.d7_published_at).toEqual(before.d7_published_at);
    expect(await lines()).toEqual([]);
    expect(await learnKeys(id)).toEqual(["1", "1:ga:ok"]);
  });

  it("a note saved while GA lands in between still marks its line told", async () => {
    const id = await seed({ win: OPENS });
    await runEmailResultsPass(deps());
    const read = await day7NoteLines(T, noteDeps());
    expect(read.lines).toHaveLength(1);
    await gaDue(id);
    await runEmailResultsPass(deps());
    await markDay7Told(T, read.marks, noteDeps());
    expect(await lines()).toEqual([]);
  });

  it("GA gives up at day 10.5: the row settles on 'could not tell', keeps its published time, and is told once", async () => {
    const id = await seed();
    await runEmailResultsPass(deps());
    const before = await row(id);
    ga.visitors = null;
    await gaDue(id, "1 minute");
    await runEmailResultsPass(deps());
    const after = await row(id);
    expect((await gaTask(id)).state).toBe("gave_up");
    expect(after.d7.ga_status).toBe("could_not_read");
    expect(after.verdict).toBe("unknown");
    expect(after.d7_version).toBe(2);
    expect(after.d7_published_at).toEqual(before.d7_published_at);
    expect(providerOf(after.d7)).toEqual(providerOf(before.d7));
    expect(await tellNote()).toHaveLength(1);
    expect(await lines()).toEqual([]);
    expect((await view(id)).visitors.why).toBe("Google Analytics could not be read");
  });

  it("GA never connected: the last wait changes no number but the verdict still settles", async () => {
    const id = await seed();
    await runEmailResultsPass(deps());
    ga.connected = false;
    await gaDue(id);
    await runEmailResultsPass(deps());
    expect(await row(id)).toMatchObject({ verdict: null, d7_version: 1 });
    expect(await lines()).toEqual([]);
    expect((await view(id)).visitors).toMatchObject({ why: "Connect Google Analytics", action: "connect_ga" });
    const d7 = (await row(id)).d7;
    await gaDue(id, "1 hour");
    await runEmailResultsPass(deps());
    const after = await row(id);
    expect((await gaTask(id)).state).toBe("gave_up");
    expect(after.d7).toEqual(d7);
    expect(after).toMatchObject({ verdict: "unknown", d7_version: 2 });
    expect(await tellNote()).toHaveLength(1);
  });

  it("the same pass again changes nothing, and a stale lease replay is refused", async () => {
    const id = await seed();
    const claimed: ClaimedTask[] = [];
    const d = deps();
    const spy: CheckDeps = { ...d, claim: async (a, b) => { const c = await d.claim(a, b); claimed.push(...c); return c; } };
    await runEmailResultsPass(spy);
    await gaDue(id);
    await runEmailResultsPass(spy);
    const settled = await row(id);
    const keys = await learnKeys(id);
    expect(claimed).toHaveLength(2);

    const report = await runEmailResultsPass(deps());
    expect(report.claimed).toBe(0);
    for (const t of claimed) await complete(t, { outcome: "done", result: { visitors: 999, delivered: 1 } });

    expect(await row(id)).toEqual(settled);
    expect(await learnKeys(id)).toEqual(keys);
    expect(bulkReads).toBe(1);
    expect(ga.reads).toBe(1);
    expect(await tellNote()).toHaveLength(1);
    expect(await lines()).toEqual([]);
  });

  it("GA answers while the provider is still failing: no publish until the provider's read, then one publish with the verdict", async () => {
    const id = await seed({ gaDue: "-1 minute" });
    const d = deps();
    await runEmailResultsPass({ ...d, bulkCounts: async () => { throw new Error("db down"); } });
    const mid = await row(id);
    expect(mid.d7_published_at).toBeNull();
    expect(mid.d7.visitors).toBe(5);
    await db.query("update email_result_tasks set due_at = now() - interval '1 second' where result_id = $1 and source = 'provider'", [id]);
    await runEmailResultsPass(d);
    const r = await row(id);
    expect(r).toMatchObject({ verdict: "beat", d7_version: 1 });
    expect(r.d7_published_at).not.toBeNull();
    expect(await tellNote()).toHaveLength(1);
    expect(await lines()).toEqual([]);
  });

  it("a tag shared after publish still re-tells a result told at the old win line, even with the same verdict", async () => {
    const id = await seed({ win: OPENS });
    await runEmailResultsPass(deps());
    await tellNote();
    const old = (await row(id)).d7;
    await db.query(`update email_send_results set shared_tag = true, d7 = d7 || '{"visitors":null,"ga_status":"shared_tag"}' where id = $1`, [id]);
    await db.query("update email_result_tasks set state = 'gave_up' where result_id = $1 and source = 'ga'", [id]);
    await db.query("select _email_result_finalize($1, $2)", [id, JSON.stringify(old)]);
    expect(await row(id)).toMatchObject({ d7_version: 2, d7_told_at: null });
  });

  it("a held row whose tag becomes shared stops waiting: the win line moves off visitors and it is told once", async () => {
    const id = await seed();
    await runEmailResultsPass(deps());
    const old = (await row(id)).d7;
    await db.query(`update email_send_results set shared_tag = true, win_line = $2, d7 = d7 || '{"visitors":null,"ga_status":"shared_tag"}' where id = $1`, [id, JSON.stringify(OPENS)]);
    await db.query("update email_result_tasks set state = 'gave_up' where result_id = $1 and source = 'ga'", [id]);
    await db.query("select _email_result_finalize($1, $2)", [id, JSON.stringify(old)]);
    expect((await row(id)).verdict).toBe("beat");
    expect(await tellNote()).toHaveLength(1);
    expect(await lines()).toEqual([]);
  });

  it("no tag at all: published and told straight away", async () => {
    const id = (await one(
      `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, subject, sent_count, started_at, finished_at, win_line)
       values ($1, 'decisions', $2, 'zavi_list', $3, 'x', 100, now() - interval '8 days', now() - interval '7 days', $4) returning id`,
      [T, randomUUID(), randomUUID(), JSON.stringify(OPENS)],
    )).id as string;
    await db.query(`insert into email_result_tasks (tenant_id, result_id, source, stage, due_at, give_up_at, group_key) values ($1, $2, 'provider', 'd7', now() - interval '1 minute', now() + interval '3 days', 'zavi')`, [T, id]);
    await runEmailResultsPass(deps());
    expect(await row(id)).toMatchObject({ verdict: "beat", d7_version: 1, d7_told_at: null });
    expect(await lines()).toHaveLength(1);
  });

  it("the provider numbers fixture matches what the pass stores", async () => {
    const id = await seed();
    await runEmailResultsPass(deps());
    expect((await row(id)).d7).toMatchObject({ ...PROVIDER, clicks: null });
  });
});
