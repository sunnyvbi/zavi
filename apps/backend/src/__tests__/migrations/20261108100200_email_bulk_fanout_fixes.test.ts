import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const MEMBER = randomUUID();
const MINE = ["20261108100000_email_send_pause.sql", "20261108100100_email_card_takeover_and_redispatch.sql", "20261108100150_email_card_tests_atomic.sql", "20261108100200_email_bulk_fanout_fixes.sql"];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");

describe.skipIf(!PGLITE_MODULES)("20261108100200 bulk fan-out: warm-up counter, allowance refunds, stall recovery, stop (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const r = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r;
  const claim = (send: string) => r("select email_bulk_claim_next($1, $2, 0) r", [T, send]);
  const counter = () => one("select coalesce(sum(sent_count), 0)::int sent, coalesce(sum(bulk_sent_count), 0)::int bulk from email_send_counters where tenant_id = $1 and day = (now() at time zone 'utc')::date", [T]);

  async function send(people: number, domain = `d${randomUUID().slice(0, 8)}.test`): Promise<{ send: string; decision: string; emails: string[] }> {
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, $2) returning id", [T, `L ${randomUUID()}`])).id;
    const version = (await one(
      "insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id",
      [T, list, OWNER],
    )).id;
    await db.query("update email_lists set active_version_id = $2 where id = $1", [list, version]);
    const emails: string[] = [];
    for (let i = 0; i < people; i++) {
      const e = `p${i}-${randomUUID().slice(0, 6)}@x.test`;
      emails.push(e);
      const c = (await one("insert into email_contacts (tenant_id, email_norm) values ($1, $2) returning id", [T, e])).id;
      await db.query("insert into email_list_version_contacts (tenant_id, version_id, contact_id) values ($1, $2, $3)", [T, version, c]);
    }
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one(
      "insert into decisions (tenant_id, decision_class, body, status, approved_by, approved_at) values ($1, 'bulk_outbound.send', $2, 'approved', $3, now()) returning id",
      [T, JSON.stringify({ list_id: list, list_version_id: version }), OWNER],
    )).id;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    const html = "<p>x {{zavi_unsubscribe_url}}</p>";
    const text = "x {{zavi_unsubscribe_url}}";
    const f = await r("select email_bulk_freeze_send($1, $2, $3, $4, 'S', $5, $6, null, 1000, $7, $8) r", [T, decision, list, version, text, `hi@${domain}`, html, sha(html, text)]);
    expect(f.ok).toBe(true);
    return { send: f.send_id, decision, emails };
  }

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [T, OWNER, MEMBER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("1:1 email sent earlier today does not eat a new domain's bulk warm-up allowance", async () => {
    await db.query("insert into email_send_counters (tenant_id, day, sent_count) values ($1, (now() at time zone 'utc')::date, 50) on conflict (tenant_id, day) do update set sent_count = 50, bulk_sent_count = 0", [T]);
    const s = await send(60);
    const outcomes: string[] = [];
    for (let i = 0; i < 60; i++) outcomes.push((await claim(s.send)).outcome);
    expect(outcomes.filter((o) => o === "claimed")).toHaveLength(50);
    expect(outcomes.slice(50).every((o) => o === "allowance_exhausted")).toBe(true);
    expect(await counter()).toEqual({ sent: 100, bulk: 50 });
  });

  it("a claimed person who is skipped at the last check, or put back to waiting, gives the allowance back", async () => {
    await db.query("delete from email_send_counters where tenant_id = $1", [T]);
    const s = await send(3);
    const a = await claim(s.send);
    expect(a.outcome).toBe("claimed");
    expect(await counter()).toEqual({ sent: 1, bulk: 1 });
    await db.query("insert into email_suppression (tenant_id, email, reason) values ($1, $2, 'unsubscribe')", [T, a.email]);
    expect(await r("select email_bulk_skip_if_blocked($1, $2, $3) r", [T, s.send, a.contact_id])).toBe("unsubscribed");
    expect(await counter()).toEqual({ sent: 0, bulk: 0 });
    const b = await claim(s.send);
    expect(await counter()).toEqual({ sent: 1, bulk: 1 });
    expect(await r("select email_bulk_requeue_claimed($1, $2, $3) r", [T, s.send, b.contact_id])).toBe(true);
    expect(await counter()).toEqual({ sent: 0, bulk: 0 });
    expect(await r("select email_bulk_requeue_claimed($1, $2, $3) r", [T, s.send, b.contact_id])).toBe(false);
    expect(await counter()).toEqual({ sent: 0, bulk: 0 });
  });

  it("a send with no worker and no progress is re-fired a bounded number of times, then held so the approver can be told", async () => {
    const s = await send(4);
    const fresh = await send(2);
    const age = (id: string) => db.query("update email_bulk_sends set created_at = now() - interval '3 hours', fanout_recovered_at = case when fanout_recovered_at is null then null else now() - interval '3 hours' end where id = $1", [id]);
    await age(s.send);
    const sweep = async () => ((await r("select email_bulk_stalled_sends(50, 45, 2) r")) as Array<Record<string, any>>).filter((x) => x.send_id === s.send || x.send_id === fresh.send);
    expect(await sweep()).toEqual([{ action: "refire", send_id: s.send, tenant_id: T, decision_id: s.decision, attempt: 1 }]);
    expect(await sweep()).toEqual([]);
    await age(s.send);
    expect((await sweep())[0]).toMatchObject({ action: "refire", attempt: 2 });
    await age(s.send);
    expect(await sweep()).toEqual([{ action: "give_up", send_id: s.send, tenant_id: T, decision_id: s.decision, sent: 0, total: 4 }]);
    expect(await one("select status, hold_reason from email_bulk_sends where id = $1", [s.send])).toEqual({ status: "held", hold_reason: "fanout_stalled" });
    expect(await sweep()).toEqual([]);
  });

  it("a send waiting for tomorrow is left alone until its time has long passed", async () => {
    const s = await send(2);
    await db.query("update email_bulk_sends set status = 'waiting_for_tomorrow', next_run_at = now() + interval '5 hours', created_at = now() - interval '1 day' where id = $1", [s.send]);
    const found = async () => ((await r("select email_bulk_stalled_sends(50, 45, 2) r")) as Array<Record<string, any>>).some((x) => x.send_id === s.send);
    expect(await found()).toBe(false);
    await db.query("update email_bulk_sends set next_run_at = now() - interval '2 hours' where id = $1", [s.send]);
    expect(await found()).toBe(true);
    expect(await one("select status from email_bulk_sends where id = $1", [s.send])).toEqual({ status: "sending" });
  });

  it("stop: owner or admin only; the people still waiting are never claimed; a finished send is not stoppable", async () => {
    await db.query("delete from email_send_counters where tenant_id = $1", [T]);
    const s = await send(5);
    const a = await claim(s.send);
    await r("select email_bulk_settle_recipient($1, $2, $3, 'sent') r", [T, s.send, a.contact_id]);
    const inFlight = await claim(s.send);
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, MEMBER, s.decision])).toEqual({ ok: false, code: "not_authorized" });
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, s.decision])).toEqual({ ok: true, stopped: 3, already_sent: 1 });
    expect(await claim(s.send)).toEqual({ outcome: "held" });
    expect(await one("select status, hold_reason from email_bulk_sends where id = $1", [s.send])).toEqual({ status: "held", hold_reason: "stopped" });
    expect(await one("select count(*)::int n from email_bulk_send_recipients where send_id = $1 and status = 'pending'", [s.send])).toEqual({ n: 0 });
    expect(await r("select email_bulk_settle_recipient($1, $2, $3, 'sent') r", [T, s.send, inFlight.contact_id])).toBe(true);
    await db.query("update email_bulk_sends set status = 'sending' where id = $1", [s.send]);
    expect(await claim(s.send)).toEqual({ outcome: "none_pending" });
    const done = await send(1);
    await db.query("update email_bulk_sends set status = 'done' where id = $1", [done.send]);
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, done.decision])).toMatchObject({ ok: false, code: "not_stoppable" });
    expect(await r("select email_bulk_stop_send($1, $2, $3) r", [T, OWNER, randomUUID()])).toMatchObject({ ok: false, code: "not_stoppable" });
  });
});

describe.skipIf(!PGLITE_MODULES)("20261108100200 bulk counter deployment backfill (pglite)", () => {
  it("backfills only today's bulk attempts, not earlier one-to-one sends", async () => {
    const tenant = randomUUID();
    const owner = randomUUID();
    const db = await bootEmailPipeline(MINE, async (live, file) => {
      if (file !== "20261108100200_email_bulk_fanout_fixes.sql") return;
      await live.query("insert into tenants values ($1)", [tenant]);
      await live.query("insert into tenant_users values ($1, $2, 'owner')", [tenant, owner]);
      const list = (await live.query<{ id: string }>("insert into email_lists (tenant_id, name) values ($1, 'Backfill') returning id", [tenant])).rows[0].id;
      const version = (await live.query<{ id: string }>("insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id", [tenant, list, owner])).rows[0].id;
      const decision = (await live.query<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', '{}') returning id", [tenant])).rows[0].id;
      const sendId = (await live.query<{ id: string }>("insert into email_bulk_sends (tenant_id, decision_id, list_id, list_version_id, subject, body_text, from_address) values ($1, $2, $3, $4, 'S', 'B', 'hi@example.test') returning id", [tenant, decision, list, version])).rows[0].id;
      for (const status of ["sent", "failed"]) {
        const contact = (await live.query<{ id: string }>("insert into email_contacts (tenant_id, email_norm) values ($1, $2) returning id", [tenant, `${status}@example.test`])).rows[0].id;
        await live.query("insert into email_bulk_send_recipients (send_id, tenant_id, contact_id, email_at_send, status, stamped_at) values ($1, $2, $3, $4, $5, now())", [sendId, tenant, contact, `${status}@example.test`, status]);
      }
      await live.query("insert into email_send_counters (tenant_id, day, sent_count) values ($1, (now() at time zone 'utc')::date, 37)", [tenant]);
    });
    try {
      expect((await db.query("select sent_count, bulk_sent_count from email_send_counters where tenant_id = $1", [tenant])).rows[0]).toEqual({ sent_count: 37, bulk_sent_count: 2 });
    } finally {
      await db.close();
    }
  }, 120_000);
});
