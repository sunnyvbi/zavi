import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const BUG = "draft_blocked:email_campaign_body_invalid";
const REPEAT = "draft_blocked:channel_card_already_done";

describe.skipIf(!PGLITE_MODULES)("20261121480000 a blocked draft has a way forward (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  const item = async (over: { list?: string; status?: string; reason?: string | null; attempts?: number; in?: string; card?: string | null } = {}) => {
    const list = over.list ?? randomUUID();
    return (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, status_reason, draft_attempts, card_rail, card_id)
       values ($1, 'zavi_list', $2, $3, 'Patients', now() + $4::interval, 'UTC', 'Flu shots', 'founder', $5, $6, $7, $8, $9, $10) returning id, content_version, schedule_gen`,
      [T, list, `zavi_list:${list}`, over.in ?? "3 days", randomUUID(), over.status ?? "blocked", over.reason === undefined ? BUG : over.reason, over.attempts ?? 1, over.card ? "decisions" : null, over.card ?? null],
    )) as { id: string; content_version: number; schedule_gen: number };
  };
  const row = (id: string) => one("select status, status_reason, draft_attempts, angle, content_version, card_id from email_planned_sends where id = $1", [id]);
  const jobs = async (id: string) => (await db.query("select job_key, state from email_plan_jobs where item_id = $1 and kind = 'draft' order by job_key", [id])).rows;
  const now = (id: string) => r("select draft_email_planned_now($1, $2, $3) r", [T, OWNER, id]);
  const angle = (id: string, version: number) => r("select change_email_planned_angle($1, $2, $3, 'Winter hours', $4) r", [T, OWNER, id, version]);

  beforeAll(async () => {
    db = await bootEmailPipeline([
      "20261108100000_email_send_pause.sql",
      "20261117110000_email_plan_draft_spend_guards.sql",
      "20261119150000_email_plan_sent_only_when_bulk_send_done.sql",
      "20261119110000_email_plan_draft_blocked_by_refusal.sql",
      "20261119150300_email_plan_keep_sender_block_reason.sql",
      "20261121200000_email_plan_redraft_and_angle_guards.sql",
      "20261121480000_email_plan_unblock_draft.sql",
    ]);
    await db.exec("create table agent_runs (id uuid primary key default gen_random_uuid(), tenant_id uuid, channel_slug text, status text, payload jsonb)");
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  describe("Draft now", () => {
    it("must catch: a Zavi bug block goes back to planned, its reason gone, a draft job due, the tries it used still counted", async () => {
      const i = await item();
      expect(await now(i.id)).toEqual({ ok: true });
      expect(await row(i.id)).toMatchObject({ status: "planned", status_reason: null, draft_attempts: 1 });
      expect(await jobs(i.id)).toEqual([{ job_key: `draft:${i.id}:v1:g1:now`, state: "pending" }]);
    });

    it("must catch the spend cap: 3 tries used means no fourth paid run, and the item stays blocked", async () => {
      const i = await item({ attempts: 3 });
      expect(await now(i.id)).toEqual({ ok: false, code: "draft_tries_used" });
      expect(await row(i.id)).toMatchObject({ status: "blocked", status_reason: BUG });
      expect(await jobs(i.id)).toEqual([]);
    });

    it.each([REPEAT, "draft_blocked:email_audience_missing", "test_list", null])("a block of another kind (%s) cannot be redrafted", async (reason) => {
      const i = await item({ reason });
      expect(await now(i.id)).toMatchObject({ ok: false, code: "not_draftable" });
      expect(await row(i.id)).toMatchObject({ status: "blocked" });
    });

    it("a time already past stays blocked", async () => {
      const i = await item({ in: "-1 hour" });
      expect(await now(i.id)).toMatchObject({ ok: false, code: "not_draftable" });
    });

    it("must catch a second email on the list: another live item took the 7 day slot while this one was blocked", async () => {
      const list = randomUUID();
      await item({ list, status: "planned", reason: null, in: "4 days" });
      const i = await item({ list });
      expect(await now(i.id)).toEqual({ ok: false, code: "list_spacing" });
      expect(await row(i.id)).toMatchObject({ status: "blocked" });
    });

    it("a planned item still drafts as before", async () => {
      const i = await item({ status: "planned", reason: null });
      expect(await now(i.id)).toEqual({ ok: true });
      expect(await row(i.id)).toMatchObject({ status: "planned" });
    });
  });

  describe("Change topic", () => {
    it("must catch: a repeat block takes a new topic, a new draft job, and the old job key is left behind", async () => {
      const i = await item({ reason: REPEAT });
      expect(await angle(i.id, i.content_version)).toMatchObject({ ok: true, content_version: 2 });
      expect(await row(i.id)).toMatchObject({ status: "planned", status_reason: null, angle: "Winter hours", draft_attempts: 1 });
      expect(await jobs(i.id)).toEqual([{ job_key: `draft:${i.id}:v2:g2`, state: "pending" }]);
    });

    it("must catch the spend cap: 3 tries used refuses a new topic", async () => {
      const i = await item({ reason: REPEAT, attempts: 3 });
      expect(await angle(i.id, i.content_version)).toEqual({ ok: false, code: "draft_tries_used" });
    });

    it("a block of another kind takes no new topic", async () => {
      const i = await item({ reason: BUG });
      expect(await angle(i.id, i.content_version)).toMatchObject({ ok: false, code: "not_changeable" });
      expect(await row(i.id)).toMatchObject({ status: "blocked", angle: "Flu shots" });
    });

    it("a repeat block with another email taking the slot stays blocked", async () => {
      const list = randomUUID();
      await item({ list, status: "planned", reason: null, in: "4 days" });
      const i = await item({ list, reason: REPEAT });
      expect(await angle(i.id, i.content_version)).toEqual({ ok: false, code: "list_spacing" });
    });
  });
});
