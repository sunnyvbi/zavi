import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attempt, bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const sha = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number) => ({ content: { subject: `Subject ${n}` }, html: `<p>v${n}</p>`, text: `v${n}`, render_sha: sha(`<p>v${n}</p>`, `v${n}`) });
const toolBody = (audience = randomUUID()) => ({ tool: "sendgrid", audience_id: audience, variants: [v(1), v(2)], template_snapshot: { brand_color: "#2e7d32" }, renderer_version: "email-r1" });
const listBody = (list: string) => ({ list_id: list, list_version_id: randomUUID(), variants: [v(1), v(2)], template_snapshot: { brand_color: "#2e7d32" }, renderer_version: "email-r1", chosen_variant: 1, approved_count: 3 });

describe.skipIf(!PGLITE_MODULES)("20261108100100 email card takeover and released-claim redispatch (pglite)", () => {
  let db: Db;
  const r = async (sql: string, p: unknown[] = []) => (await db.query<{ r: Record<string, any> }>(sql, p)).rows[0].r;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const flag = (on: boolean) => db.query(`select set_config('zavi.email_card_approve', $1, false)`, [on ? "on" : ""]);
  const test = async (id: string, variant: number, user: string) => {
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, $3, $4) r", [T, id, variant, user]);
    await r("select record_email_test_send($1, 'channel_actions', $2, $3, $4, $5) r", [T, id, variant, user, pre.test_sha]);
  };
  const cgoHeldCard = async () => {
    const id = (await one("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [T, JSON.stringify(toolBody())])).id;
    const out = await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, 100) r", [T, id, `cgo-${id}`, OWNER]);
    expect(out.ok).toBe(true);
    await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [id]);
    await db.query("update channel_actions set exec_status = 'failed', exec_result = $2 where id = $1", [id, JSON.stringify({ error: "Autopilot did not send this on its own.", held_for_founder: true })]);
    await db.query("update email_send_reservations set state = 'released' where card_id = $1", [id]);
    return id;
  };
  const retry = (id: string, variant: number, user = ADMIN) =>
    r("select approve_email_card($1, 'channel_actions', $2, $3, $4, $5, 120) r", [T, id, variant, user, randomUUID()]);
  const released = async (list: string, approvedAgo = "1 hour", dispatchedAgo = "10 minutes") => {
    await flag(true);
    const id = (await one(
      `insert into decisions (tenant_id, decision_class, body, status, approved_by, approved_at, dispatched_at)
       values ($1, 'bulk_outbound.send', $2, 'dispatching', $3, now() - $4::interval, now() - $5::interval) returning id`,
      [T, JSON.stringify(listBody(list)), OWNER, approvedAgo, dispatchedAgo],
    )).id;
    await flag(false);
    await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, source) values ($1, $2, 'decisions', $3, null)", [T, `zavi_list:${list}`, id]);
    await db.query("update decisions set status = 'proposed', dispatch_error = 'fleet_halted' where id = $1", [id]);
    return id as string;
  };

  beforeAll(async () => {
    db = await bootEmailPipeline(["20261108100000_email_send_pause.sql", "20261108100100_email_card_takeover_and_redispatch.sql", "20261108100150_email_card_tests_atomic.sql"]);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin')", [T, OWNER, ADMIN]);
  }, 120_000);
  afterAll(async () => db?.close());

  describe("an Autopilot-held card", () => {
    it("a founder's Try again becomes the founder's own approval, so the Autopilot gates no longer apply", async () => {
      const id = await cgoHeldCard();
      await test(id, 1, ADMIN);
      expect(await retry(id, 1)).toMatchObject({ ok: true, replayed: false });
      expect(await one("select exec_status, approved_by, approved_by_source, exec_payload->'chosen_variant' cv from channel_actions where id = $1", [id])).toEqual({
        exec_status: "queued", approved_by: ADMIN, approved_by_source: null, cv: 1,
      });
      expect(await one("select state from email_send_reservations where card_id = $1", [id])).toEqual({ state: "held" });
    });

    it("the founder may pick another version they tested; without a test of it nothing changes", async () => {
      const id = await cgoHeldCard();
      expect(await retry(id, 2)).toMatchObject({ ok: false, code: "test_required" });
      expect(await one("select exec_status, approved_by_source from channel_actions where id = $1", [id])).toEqual({ exec_status: "failed", approved_by_source: "cgo" });
      await test(id, 2, ADMIN);
      expect(await retry(id, 2)).toMatchObject({ ok: true });
      expect(await one("select approved_by_source, exec_payload->'chosen_variant' cv from channel_actions where id = $1", [id])).toEqual({ approved_by_source: null, cv: 2 });
    });

    it("a founder-approved card keeps its approver and its version on Try again", async () => {
      const id = (await one("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [T, JSON.stringify(toolBody())])).id;
      await test(id, 1, OWNER);
      expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 100) r", [T, id, OWNER, randomUUID()])).toMatchObject({ ok: true });
      await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [id]);
      await db.query("update channel_actions set exec_status = 'failed', exec_result = '{\"code\":\"email_tool_not_connected\"}' where id = $1", [id]);
      expect(await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, ADMIN])).toMatchObject({ ok: true });
      await test(id, 2, ADMIN);
      expect(await retry(id, 2)).toMatchObject({ ok: false, code: "not_open" });
      expect(await retry(id, 1)).toMatchObject({ ok: true });
      expect(await one("select approved_by from channel_actions where id = $1", [id])).toEqual({ approved_by: OWNER });
    });

    it("no other door rewrites an approval, not even with both flags on", async () => {
      const id = await cgoHeldCard();
      const sql = `select set_config('zavi.email_card_approve', 'on', true), set_config('zavi.email_card_takeover', 'on', true);
                   update channel_actions set approved_by = '${ADMIN}', approved_by_source = null where id = '${id}'`;
      const err = await db.exec(`begin; ${sql}; commit;`).then(() => null, (e: Error) => e.message);
      await db.exec("rollback").catch(() => undefined);
      expect(err).toMatch(/an approval is never rewritten/);
      expect(await attempt(db, "update channel_actions set approved_by_source = 'staff' where id = $1", [id])).toMatch(/email_card_approve_required/);
    });
  });

  describe("a decisions-rail send whose claim was released", () => {
    it("Approve on the card sends it again with a fresh event key, instead of answering not_open", async () => {
      const id = await released(randomUUID());
      const out = await r("select approve_email_card($1, 'decisions', $2, 1, $3, $4, 3) r", [T, id, OWNER, randomUUID()]);
      expect(out).toMatchObject({ ok: true, status: "approved", class: "bulk_outbound.send" });
      expect(out.redispatch_key).toMatch(/^r\d+$/);
      expect(await one("select status, approved_by from decisions where id = $1", [id])).toEqual({ status: "approved", approved_by: OWNER });
      const replay = await r("select approve_email_card($1, 'decisions', $2, 1, $3, $4, 3) r", [T, id, OWNER, randomUUID()]);
      expect(replay).toMatchObject({ ok: true, changed: false, status: "approved", redispatch_key: out.redispatch_key });
    });

    it("the sweep re-dispatches released sends, expires day-old ones (freeing the list), and leaves a paused workspace alone", async () => {
      const fresh = await released(randomUUID());
      const crossing = await released(randomUUID(), "23 hours", "23 hours");
      const oldList = randomUUID();
      const stale = await released(oldList, "2 days", "2 days");
      const young = await released(randomUUID(), "1 hour", "1 minute");
      const out = (await r("select email_redispatch_released_sweep(50) r")) as unknown as Array<Record<string, string>>;
      expect(out.find((x) => x.decision_id === fresh)).toMatchObject({ action: "redispatch", decision_class: "bulk_outbound.send" });
      expect(out.find((x) => x.decision_id === crossing)).toMatchObject({ action: "redispatch" });
      expect(out.find((x) => x.decision_id === stale)).toMatchObject({ action: "expired" });
      expect(out.find((x) => x.decision_id === young)).toBeUndefined();
      expect(await one("select status from decisions where id = $1", [fresh])).toEqual({ status: "approved" });
      expect(await one("select status from decisions where id = $1", [stale])).toEqual({ status: "dispatch_failed" });
      expect(await one("select state from email_send_reservations where card_id = $1", [stale])).toEqual({ state: "released" });
      await db.query("update decisions set approved_at = now() - interval '25 hours', dispatched_at = now() - interval '25 hours' where id = $1", [crossing]);
      const replay = (await r("select email_redispatch_released_sweep(50) r")) as unknown as Array<Record<string, string>>;
      expect(replay.find((x) => x.decision_id === fresh)).toMatchObject({
        action: "redispatch",
        redispatch_key: out.find((x) => x.decision_id === fresh)?.redispatch_key,
      });
      expect(replay.find((x) => x.decision_id === crossing)).toMatchObject({ action: "expired" });
      expect(await one("select status from decisions where id = $1", [crossing])).toEqual({ status: "dispatch_failed" });

      const paused = await released(randomUUID());
      await r("select set_email_pause($1, $2, true) r", [T, OWNER]);
      const again = (await r("select email_redispatch_released_sweep(50) r")) as unknown as Array<Record<string, string>>;
      expect(again.find((x) => x.decision_id === paused)).toBeUndefined();
      expect(await one("select status from decisions where id = $1", [paused])).toEqual({ status: "proposed" });
      expect(await r("select approve_email_card($1, 'decisions', $2, 1, $3, $4, 3) r", [T, paused, OWNER, randomUUID()])).toMatchObject({ ok: false, code: "email_paused" });
      await r("select set_email_pause($1, $2, false) r", [T, OWNER]);
    });

    it("the hold state no longer claims a released claim is retried soon", async () => {
      const def = (await one("select pg_get_functiondef('public._email_hold_state(uuid,text,uuid)'::regprocedure) d")).d as string;
      expect(def).not.toMatch(/retried soon/);
    });
  });

  describe("the workspace email pause", () => {
    it("keeps a partially sent paused bulk send out of results until it resumes", async () => {
      await flag(true);
      const list = randomUUID();
      const version = randomUUID();
      await db.query("insert into email_lists (id, tenant_id, name) values ($1, $2, 'Paused list')", [list, T]);
      await db.query(
        "insert into email_list_versions (id, tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, $3, 'csv', 'yes', $4, now())",
        [version, T, list, OWNER],
      );
      const decision = (await one(
        "insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', $2, 'acted', $3) returning id",
        [T, JSON.stringify(listBody(list)), OWNER],
      )).id as string;
      await flag(false);
      const send = (await one(
        "insert into email_bulk_sends (tenant_id, decision_id, list_id, list_version_id, subject, body_text, from_address, total, sent, status, hold_reason) values ($1, $2, $3, $4, 'S', 'Body', 'hi@example.test', 3, 2, 'held', 'email_paused') returning id",
        [T, decision, list, version],
      )).id as string;
      const missing = (await db.query("select card_id from email_results_missing(now() - interval '1 day', 100)")).rows;
      expect(missing.map((x) => x.card_id)).not.toContain(decision);
      const result = await r(
        "select start_email_send_result($1, 'decisions', $2, $3) r",
        [T, decision, JSON.stringify({ route: "zavi_list", provider_ref: send, sent_count: 2, finished_at: new Date().toISOString() })],
      );
      expect(result).toMatchObject({ ok: false, code: "not_final" });
    });

    it("only an owner or admin sets it; un-pausing resumes the sends it held", async () => {
      const MEMBER = randomUUID();
      await db.query("insert into tenant_users values ($1, $2, 'member')", [T, MEMBER]);
      expect(await r("select set_email_pause($1, $2, true) r", [T, MEMBER])).toEqual({ ok: false, code: "not_authorized" });
      expect(await one("select email_send_paused($1) p", [T])).toEqual({ p: false });
      expect(await r("select set_email_pause($1, $2, true) r", [T, ADMIN])).toMatchObject({ ok: true, paused: true });
      expect(await one("select email_send_paused($1) p", [T])).toEqual({ p: true });
      expect(await one("select email_send_paused($1) p", [randomUUID()])).toEqual({ p: false });
    });
  });
});
