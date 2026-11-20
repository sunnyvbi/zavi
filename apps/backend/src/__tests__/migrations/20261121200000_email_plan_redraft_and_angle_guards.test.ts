import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OTHER = randomUUID();
const OWNER = randomUUID();

describe.skipIf(!PGLITE_MODULES)("20261121200000 a redraft keeps its plan and an angle change respects a live draft (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  const card = async (list: string, body: Record<string, unknown> = {}) =>
    (await one("insert into decisions (tenant_id, decision_class, body, status) values ($1, 'bulk_outbound.send', $2, 'proposed') returning id", [T, JSON.stringify({ list_id: list, ...body })])).id as string;
  const cardRow = (id: string) => one("select status, body from decisions where id = $1", [id]);
  const item = async (over: { list?: string; in?: string; status?: string; card?: string | null; attempts?: number; vetoed?: boolean } = {}) => {
    const list = over.list ?? randomUUID();
    return (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, card_rail, card_id, draft_attempts, vetoed_at, vetoed_by)
       values ($1, 'zavi_list', $2, $3, 'Patients', now() + $4::interval, 'UTC', 'Flu shots', 'founder', $5, $6, $7, $8, $9, $10, $11) returning id, list_id, schedule_gen, content_version`,
      [T, list, `zavi_list:${list}`, over.in ?? "3 days", randomUUID(), over.status ?? "ready", over.card ? "decisions" : null, over.card ?? null, over.attempts ?? 0, over.vetoed ? new Date().toISOString() : null, over.vetoed ? OWNER : null],
    )) as { id: string; list_id: string; schedule_gen: number; content_version: number };
  };
  const planned = async (status = "ready", vetoed = false) => {
    const list = randomUUID();
    const old = await card(list);
    const it = await item({ list, card: old, status, vetoed });
    const fresh = await card(list, { planned_send_id: it.id, plan_version: it.content_version });
    return { list, old, it, fresh };
  };
  const rebind = (t: string, id: string, version: number, old: string, fresh: string) =>
    r("select rebind_email_planned_card($1, $2, $3, 'decisions', $4, 'decisions', $5) r", [t, id, version, old, fresh]);
  const row = (id: string) => one("select status, status_reason, card_id, schedule_gen, content_version, draft_attempts, angle, vetoed_at from email_planned_sends where id = $1", [id]);
  const angle = (id: string, version: number, text = "New angle") => r("select change_email_planned_angle($1, $2, $3, $4, $5) r", [T, OWNER, id, text, version]);

  beforeAll(async () => {
    db = await bootEmailPipeline([
      "20261108100000_email_send_pause.sql",
      "20261117110000_email_plan_draft_spend_guards.sql",
      "20261119150000_email_plan_sent_only_when_bulk_send_done.sql",
      "20261121200000_email_plan_redraft_and_angle_guards.sql",
    ]);
    await db.exec("create table agent_runs (id uuid primary key default gen_random_uuid(), tenant_id uuid, channel_slug text, status text, payload jsonb)");
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  describe("rebind_email_planned_card", () => {
    it("control, the bug: replacing a planned card without the rebind drops the item as skipped/card_rejected", async () => {
      const p = await planned();
      expect(await r("select replace_email_card($1, 'decisions', $2, 'decisions', $3) r", [T, p.old, p.fresh])).toMatchObject({ replaced: true });
      expect(await row(p.it.id)).toMatchObject({ status: "skipped", status_reason: "card_rejected" });
    });

    it("must catch: the item stays ready on its time, points at the new card, and the old card closes as replaced", async () => {
      const p = await planned();
      expect(await rebind(T, p.it.id, 1, p.old, p.fresh)).toEqual({ ok: true });
      expect(await row(p.it.id)).toMatchObject({ status: "ready", status_reason: null, card_id: p.fresh, schedule_gen: p.it.schedule_gen, content_version: 1 });
      expect((await cardRow(p.old)).status).toBe("rejected");
      expect((await cardRow(p.fresh)).status).toBe("proposed");
    });

    it("must catch: the deadline then acts on the new card, not the closed one", async () => {
      const p = await planned();
      await rebind(T, p.it.id, 1, p.old, p.fresh);
      const state = await r("select email_plan_deadline_state($1, $2) r", [T, p.it.id]);
      expect(JSON.stringify(state)).toContain(p.fresh);
      expect(JSON.stringify(state)).not.toContain(p.old);
    });

    it("a replay of the same rebind is a no-op success and rejects nothing twice", async () => {
      const p = await planned();
      await rebind(T, p.it.id, 1, p.old, p.fresh);
      expect(await rebind(T, p.it.id, 1, p.old, p.fresh)).toEqual({ ok: true, replayed: true });
      expect(await row(p.it.id)).toMatchObject({ status: "ready", card_id: p.fresh });
    });

    it("must catch: a scheduled item refuses and both cards are left as they were", async () => {
      const p = await planned();
      await db.query("update email_planned_sends set status = 'scheduled', sched_variant = 1, sched_count = 3, sched_by = $2, sched_sha = 's', sched_version = 1, sched_card_id = card_id, sched_account = '{}', sched_at = now() where id = $1", [p.it.id, OWNER]);
      expect(await rebind(T, p.it.id, 1, p.old, p.fresh)).toEqual({ ok: false, code: "plan_changed" });
      expect((await cardRow(p.old)).status).toBe("proposed");
      expect(await row(p.it.id)).toMatchObject({ status: "scheduled", card_id: p.old });
    });

    it("a stale plan version refuses", async () => {
      const p = await planned();
      expect(await rebind(T, p.it.id, 9, p.old, p.fresh)).toEqual({ ok: false, code: "plan_changed" });
      expect((await cardRow(p.old)).status).toBe("proposed");
    });

    it("a card from another list refuses", async () => {
      const p = await planned();
      const stray = await card(randomUUID(), { planned_send_id: p.it.id, plan_version: 1 });
      expect(await rebind(T, p.it.id, 1, p.old, stray)).toEqual({ ok: false, code: "wrong_list" });
      expect(await row(p.it.id)).toMatchObject({ card_id: p.old });
    });

    it("a card not sealed to this item refuses, so the approve gate could never pass it", async () => {
      const p = await planned();
      const unbound = await card(p.list);
      expect(await rebind(T, p.it.id, 1, p.old, unbound)).toEqual({ ok: false, code: "not_this_plan" });
    });

    it("an old card that already closed refuses", async () => {
      const p = await planned();
      await db.query("update email_planned_sends set status = 'skipped', status_reason = 'no_draft' where id = $1", [p.it.id]);
      await db.query("update decisions set status = 'rejected' where id = $1", [p.old]);
      expect(await rebind(T, p.it.id, 1, p.old, p.fresh)).toEqual({ ok: false, code: "plan_changed" });
    });

    it("a Don't send veto survives the redraft", async () => {
      const p = await planned("ready", true);
      await rebind(T, p.it.id, 1, p.old, p.fresh);
      expect((await row(p.it.id)).vetoed_at).not.toBeNull();
    });

    it("another tenant cannot reach the item", async () => {
      const p = await planned();
      expect(await rebind(OTHER, p.it.id, 1, p.old, p.fresh)).toEqual({ ok: false, code: "not_found" });
      expect(await row(p.it.id)).toMatchObject({ status: "ready", card_id: p.old });
    });
  });

  describe("change_email_planned_angle", () => {
    const job = (it: { id: string }, until: string) =>
      db.query("insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at, state, lease_token, lease_until) values ($1, $2, 'draft', $3, now(), 'leased', $4, now() + $5::interval)", [T, it.id, randomUUID(), randomUUID(), until]);
    const run = (it: { id: string }, status: string) =>
      db.query("insert into agent_runs (tenant_id, channel_slug, status, payload) values ($1, 'email_marketing', $2, $3)", [T, status, JSON.stringify({ email_plan: { item_id: it.id } })]);

    it.each(["queued", "running"])("must catch: a %s draft run refuses and nothing changes, so it cannot be billed and thrown away", async (status) => {
      const it = await item({ status: "drafting", attempts: 1 });
      await run(it, status);
      expect(await angle(it.id, 1)).toEqual({ ok: false, code: "draft_running" });
      expect(await row(it.id)).toMatchObject({ status: "drafting", angle: "Flu shots", content_version: 1, draft_attempts: 1 });
    });

    it("must catch: a draft job on a live lease refuses before its run row exists", async () => {
      const it = await item({ status: "drafting", attempts: 1 });
      await job(it, "10 minutes");
      expect(await angle(it.id, 1)).toEqual({ ok: false, code: "draft_running" });
    });

    it("an expired lease and a finished run do not hold the angle hostage", async () => {
      const it = await item({ status: "drafting", attempts: 1 });
      await job(it, "-1 minute");
      await run(it, "failed");
      expect(await angle(it.id, 1)).toMatchObject({ ok: true, content_version: 2 });
    });

    it("must catch: another item's run does not block this one", async () => {
      const it = await item({ status: "planned" });
      await run(await item({ status: "drafting" }), "running");
      expect(await angle(it.id, 1)).toMatchObject({ ok: true });
    });

    it("must catch: an angle change does not hand back spent draft tries", async () => {
      const it = await item({ status: "planned", attempts: 2 });
      expect(await angle(it.id, 1)).toMatchObject({ ok: true });
      expect((await row(it.id)).draft_attempts).toBe(2);
    });

    it("must catch: with all three tries used it refuses and states that", async () => {
      const it = await item({ status: "planned", attempts: 3 });
      expect(await angle(it.id, 1)).toEqual({ ok: false, code: "draft_tries_used" });
      expect(await row(it.id)).toMatchObject({ angle: "Flu shots", draft_attempts: 3 });
    });

    it("control: a finished draft replaced by a new angle starts fresh and closes the card", async () => {
      const p = await planned();
      await db.query("update email_planned_sends set draft_attempts = 3 where id = $1", [p.it.id]);
      expect(await angle(p.it.id, 1)).toMatchObject({ ok: true });
      expect(await row(p.it.id)).toMatchObject({ status: "planned", card_id: null, draft_attempts: 0 });
      expect((await cardRow(p.old)).status).toBe("rejected");
    });

    it("must catch: inside the hour it refuses and the ready draft and its card survive", async () => {
      const list = randomUUID();
      const c = await card(list);
      const it = await item({ list, card: c, in: "30 minutes" });
      expect(await angle(it.id, 1)).toEqual({ ok: false, code: "angle_too_late" });
      expect(await row(it.id)).toMatchObject({ status: "ready", card_id: c, angle: "Flu shots" });
      expect((await cardRow(c)).status).toBe("proposed");
    });

    it("control: just over the hour still works", async () => {
      expect(await angle((await item({ status: "planned", in: "61 minutes" })).id, 1)).toMatchObject({ ok: true });
    });
  });
});
