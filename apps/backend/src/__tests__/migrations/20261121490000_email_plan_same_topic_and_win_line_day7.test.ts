import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeWinLine } from "@/services/email-results/win-line";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();

describe.skipIf(!PGLITE_MODULES)("20261121490000 (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  beforeAll(async () => {
    db = await bootEmailPipeline([
      "20261108100000_email_send_pause.sql",
      "20261117110000_email_plan_draft_spend_guards.sql",
      "20261119150000_email_plan_sent_only_when_bulk_send_done.sql",
      "20261119110000_email_plan_draft_blocked_by_refusal.sql",
      "20261119150300_email_plan_keep_sender_block_reason.sql",
      "20261121200000_email_plan_redraft_and_angle_guards.sql",
      "20261121480000_email_plan_unblock_draft.sql",
      "20261121490000_email_plan_same_topic_and_win_line_day7.sql",
    ]);
    await db.exec("create table if not exists agent_runs (id uuid primary key default gen_random_uuid(), tenant_id uuid, channel_slug text, status text, payload jsonb)");
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  describe("Flow 36: Change topic with the same topic", () => {
    const card = async (list: string) =>
      (await one("insert into decisions (tenant_id, decision_class, body, status) values ($1, 'bulk_outbound.send', $2, 'proposed') returning id", [T, JSON.stringify({ list_id: list })])).id as string;
    const item = async (over: { status?: string; reason?: string | null; attempts?: number; in?: string; withCard?: boolean } = {}) => {
      const list = randomUUID();
      const c = over.withCard === false ? null : await card(list);
      const it = (await one(
        `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, status_reason, draft_attempts, card_rail, card_id)
         values ($1, 'zavi_list', $2, $3, 'Patients', now() + $4::interval, 'UTC', 'Flu shots', 'founder', $5, $6, $7, $8, $9, $10) returning id, schedule_gen`,
        [T, list, `zavi_list:${list}`, over.in ?? "3 days", randomUUID(), over.status ?? "ready", over.reason ?? null, over.attempts ?? 1, c ? "decisions" : null, c],
      )) as { id: string; schedule_gen: number };
      await db.query(
        "insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at) values ($1, $2, 'draft', $3, now() + interval '1 day'), ($1, $2, 'deadline', $4, now() + interval '3 days')",
        [T, it.id, `draft:${it.id}:v1:g${it.schedule_gen}`, `deadline:${it.id}:g${it.schedule_gen}`],
      );
      return { ...it, card: c };
    };
    const angle = (id: string, text: string, version = 1) => r("select change_email_planned_angle($1, $2, $3, $4, $5) r", [T, OWNER, id, text, version]);
    const state = async (i: { id: string; card: string | null }) => ({
      row: await one("select * from email_planned_sends where id = $1", [i.id]),
      jobs: (await db.query("select job_key, state, due_at from email_plan_jobs where item_id = $1 order by job_key", [i.id])).rows,
      card: i.card ? await one("select status, body from decisions where id = $1", [i.card]) : null,
    });

    it.each([["exact", "Flu shots"], ["padded", "  Flu shots  "], ["upper", "FLU SHOTS"], ["mixed", "fLu ShOtS "]])(
      "must catch %s: the draft and the approval stay, nothing is thrown away and no paid draft is queued",
      async (_label, text) => {
        const i = await item();
        await db.query("update email_planned_sends set status = 'scheduled', sched_variant = 1, sched_count = 40, sched_by = $2, sched_sha = 'sha', sched_version = 1, sched_card_id = $3, sched_account = '{}', sched_at = now() where id = $1", [i.id, OWNER, i.card]);
        const before = await state(i);
        expect(await angle(i.id, text)).toEqual({ ok: true, unchanged: true, content_version: 1, schedule_gen: i.schedule_gen });
        expect(await state(i)).toEqual(before);
        expect((await state(i)).card).toMatchObject({ status: "proposed" });
      },
    );

    it("must catch: unchanged is a no-op even where a real change would refuse (under an hour, a draft running, tries used)", async () => {
      const late = await item({ in: "20 minutes" });
      expect(await angle(late.id, "flu shots")).toMatchObject({ ok: true, unchanged: true });
      const used = await item({ status: "drafting", withCard: false, attempts: 3 });
      await db.query("insert into agent_runs (tenant_id, channel_slug, status, payload) values ($1, 'email_marketing', 'running', $2)", [T, JSON.stringify({ email_plan: { item_id: used.id } })]);
      const before = await state(used);
      expect(await angle(used.id, "FLU SHOTS")).toMatchObject({ ok: true, unchanged: true });
      expect(await state(used)).toEqual(before);
    });

    it("must catch: a blocked repeat stays blocked on the same topic, with no fresh job for the same refused draft", async () => {
      const i = await item({ status: "blocked", reason: "draft_blocked:channel_card_already_done", withCard: false });
      const before = await state(i);
      expect(await angle(i.id, " flu shots")).toMatchObject({ ok: true, unchanged: true });
      expect(await state(i)).toEqual(before);
    });

    it("control: a real change still replaces the draft and queues one new one, and inner wording counts as a change", async () => {
      const i = await item();
      expect(await angle(i.id, "Flu  shots")).toMatchObject({ ok: true, content_version: 2 });
      const after = await state(i);
      expect(after.row).toMatchObject({ angle: "Flu  shots", status: "planned", card_id: null });
      expect(after.card).toMatchObject({ status: "rejected" });
    });

    it("control: a stale form and a closed item are still refused, not treated as a no-op", async () => {
      const i = await item();
      expect(await angle(i.id, "Flu shots", 9)).toEqual({ ok: false, code: "plan_changed" });
      const sent = await item({ status: "sent" });
      expect(await angle(sent.id, "Flu shots")).toMatchObject({ ok: false, code: "not_changeable" });
    });
  });

  describe("Flow 56: the SQL win line reads only day-7 rates", () => {
    const LIST = randomUUID();
    let order = 0;
    const result = async (d7: Record<string, unknown>, list = LIST, metric = "clicks") => {
      order += 1;
      await db.query(
        `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, subject, campaign_slug, ga_timezone, sent_count, started_at, finished_at, win_line, h1, d7, d7_published_at, list_id)
         values ($1, 'decisions', $2, 'sendgrid', $3, 'S', $4, 'UTC', 100, now(), now(), $5, '{}', $6, now() - ($7 || ' hours')::interval, $8)`,
        [T, randomUUID(), randomUUID(), randomUUID(), JSON.stringify({ metric }), JSON.stringify(d7), String(1000 - order), list],
      );
    };
    const line = (list: string, metric = "clicks") => r("select _email_win_line($1, 'sendgrid', $2, $3, null) r", [T, list, metric]);
    const pastResults = (list: string) => async () =>
      (await db.query<{ win_line: unknown; d7: unknown }>("select win_line, d7 from email_send_results where list_id = $1 order by d7_published_at desc limit 20", [list])).rows;
    const real = (clicks: number) => ({ clicks, delivered: 100, provider_status: "ok" });
    const carried = (clicks: number, from: string[]) => ({ clicks, delivered: 100, provider_status: "disconnected", from_h1: from });

    it("must catch: a carried click rate or a carried delivered count is not in the median, in SQL and in code alike", async () => {
      for (const d of [real(10), real(20), real(30), carried(90, ["clicks"]), carried(95, ["delivered", "clicks"]), carried(99, ["delivered"])]) await result(d);
      const expected = { metric: "clicks", threshold: 0.2, basis: "median", n_past: 3 };
      expect(await line(LIST)).toEqual(expected);
      expect(await computeWinLine(T, { route: "sendgrid", listId: LIST, tagged: false, gaConnected: false }, { pastResults: pastResults(LIST) })).toEqual(expected);
    });

    it("must catch: carried rows do not take a slot from an older real rate", async () => {
      const list = randomUUID();
      for (const d of [real(9), real(8), real(7), real(6), real(5), carried(1, ["clicks"]), carried(1, ["clicks"])]) await result(d, list);
      expect(await line(list)).toEqual({ metric: "clicks", threshold: 0.07, basis: "median", n_past: 5 });
    });

    it("control: real day-7 rates are read as before, also with a carried count the rate does not use", async () => {
      const list = randomUUID();
      for (const d of [real(10), { ...real(20), provider_status: "could_not_read", from_h1: ["opens"] }, { ...real(30), from_h1: ["clicks"] }]) await result(d, list);
      expect(await line(list)).toEqual({ metric: "clicks", threshold: 0.2, basis: "median", n_past: 3 });
    });
  });
});
