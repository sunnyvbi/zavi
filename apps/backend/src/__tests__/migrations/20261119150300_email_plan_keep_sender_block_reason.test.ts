import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plannedReason } from "@/services/email-cards/cards";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const CODE = "sending_domain_not_verified";

describe.skipIf(!PGLITE_MODULES)("20261119150300 a sender block before the first draft reaches the founder (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;

  const item = async () => {
    const it = (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status)
       values ($1, 'mailchimp', 'L1', 'mailchimp:L1', 'New signups', now() + interval '20 hours', 'UTC', 'Welcome', 'founder', $2, 'planned') returning id, schedule_gen`,
      [T, randomUUID()],
    )) as { id: string; schedule_gen: number };
    const token = randomUUID();
    const job = (await one(
      `insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at, state, lease_token, lease_until)
       values ($1, $2, 'draft', $3, now() - interval '1 minute', 'leased', $4, now() + interval '10 minutes') returning id`,
      [T, it.id, `draft:${it.id}:v1:g${it.schedule_gen}`, token],
    )).id as string;
    return { ...it, job, token };
  };
  type Item = Awaited<ReturnType<typeof item>>;
  const block = (i: Item) => r("select block_email_plan_draft($1, $2, $3, $4, 1, $5) r", [T, i.id, i.job, i.token, CODE]);
  const begin = (i: Item) => r("select begin_email_plan_draft($1, $2, $3, $4) r", [T, i.id, i.job, i.token]);
  const row = (id: string) => one("select status, status_reason, draft_attempts from email_planned_sends where id = $1", [id]);
  const deadline = async (i: Item) => {
    await db.query("update email_plan_jobs set state = 'done', lease_token = null, lease_until = null where item_id = $1", [i.id]);
    await db.query("update email_planned_sends set planned_at = now() - interval '1 minute' where id = $1", [i.id]);
    return r("select fire_email_planned_send($1, $2, $3, '{}') r", [T, i.id, i.schedule_gen]);
  };

  beforeAll(async () => {
    db = await bootEmailPipeline([
      "20261108100000_email_send_pause.sql",
      "20261117110000_email_plan_draft_spend_guards.sql",
      "20261117230000_email_plan_skip_reason_from_gate.sql",
      "20261119110000_email_plan_draft_blocked_by_refusal.sql",
      "20261119150300_email_plan_keep_sender_block_reason.sql",
    ]);
    await db.query("insert into tenants values ($1)", [T]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("the wait keeps the item open, spends no attempt, and names the block", async () => {
    const i = await item();
    expect(await block(i)).toEqual({ ok: true, blocked: false, status: "planned" });
    expect(await row(i.id)).toEqual({ status: "planned", status_reason: `draft_blocked:${CODE}`, draft_attempts: 0 });
  });

  it("must catch: a block that lasts to the deadline is skipped with its own reason, not no_draft", async () => {
    const i = await item();
    await block(i);
    await deadline(i);
    const got = await row(i.id);
    expect(got).toMatchObject({ status: "skipped", status_reason: `draft_blocked:${CODE}` });
    expect(plannedReason(got.status_reason as string, "zavi_list")).toContain("sending domain is not verified");
  });

  it("a sender fixed before the first run clears the reason, and a later miss reads no_draft", async () => {
    const i = await item();
    await block(i);
    expect(await begin(i)).toMatchObject({ attempt: 1 });
    expect(await row(i.id)).toMatchObject({ status: "drafting", status_reason: null });
    await deadline(i);
    expect(await row(i.id)).toMatchObject({ status: "skipped", status_reason: "no_draft" });
  });

  it("control: an item never held still skips as no_draft", async () => {
    const i = await item();
    await deadline(i);
    expect(await row(i.id)).toMatchObject({ status: "skipped", status_reason: "no_draft" });
  });

  it("an item already drafted once is still blocked for good, not held", async () => {
    const i = await item();
    await begin(i);
    expect(await block(i)).toMatchObject({ blocked: true, status: "blocked" });
  });
});
