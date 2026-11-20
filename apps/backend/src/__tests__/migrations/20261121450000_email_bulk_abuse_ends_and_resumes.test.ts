import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { abuseReason } from "@/services/comms/bulk-outbound/fanout";

const OWNER = randomUUID();
const STAFF = randomUUID();
const FIX = "20261121450000_email_bulk_abuse_ends_and_resumes.sql";
const MINE = ["20261112200000_email_bulk_resume_both_stops.sql", FIX];

describe.skipIf(!PGLITE_MODULES)("20261121450000 abuse limits end a finished send and survive a staff resume (pglite)", () => {
  let db: Db;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const settle = async (t: string, send: string, status: string | null, reason: string | null = null) =>
    (await one("select email_bulk_settle_send($1, $2, $3, $4, null) r", [t, send, status, reason])).r;
  const feedback = async (t: string, send: string, email: string, kind: string) =>
    (await one("select email_bulk_record_feedback($1, $2, $3, $4) r", [t, send, email, kind])).r;
  const row = (send: string) => one("select status, hold_reason, finished_at is not null as finished, complaints, hard_bounces from email_bulk_sends where id = $1", [send]);
  const openHold = async (t: string) => (await one("select count(*)::int n from email_bulk_abuse_holds where tenant_id = $1 and cleared_at is null", [t])).n;

  async function sendWith(recipients: Array<[string, string]>) {
    const t = randomUUID();
    await db.query("insert into tenants values ($1)", [t]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [t, OWNER]);
    await db.query("insert into tenant_sending_domain (tenant_id, domain, verification_status, provider_domain_id) values ($1, 'acme.test', 'verified', 'sg-1')", [t]);
    const list = (await one("insert into email_lists (tenant_id, name) values ($1, 'L') returning id", [t])).id;
    const version = (await one(
      "insert into email_list_versions (tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, 'csv', 'yes', $3, now()) returning id",
      [t, list, OWNER],
    )).id;
    const decision = (await one("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', '{}') returning id", [t])).id;
    const send = (await one(
      "insert into email_bulk_sends (tenant_id, decision_id, list_id, list_version_id, subject, body_text, from_address, total) values ($1, $2, $3, $4, 'S', 'b', 'hi@acme.test', $5) returning id",
      [t, decision, list, version, recipients.length],
    )).id as string;
    for (const [email, status] of recipients) {
      const c = (await one("insert into email_contacts (tenant_id, email_norm) values ($1, $2) returning id", [t, email])).id;
      await db.query("insert into email_bulk_send_recipients (send_id, tenant_id, contact_id, email_at_send, status) values ($1, $2, $3, $4, $5)", [send, t, c, email, status]);
    }
    return { t, send, decision };
  }
  const many = (n: number, status: string, tag = "p") => Array.from({ length: n }, (_, i): [string, string] => [`${tag}${i}@x.test`, status]);

  beforeAll(async () => {
    let added = false;
    db = await bootEmailPipeline(MINE, async (d) => {
      if (added) return;
      added = true;
      await d.exec(`
        alter table tenant_sending_domain add column if not exists provider_domain_id text;
        create table if not exists app_setting (key text primary key, value jsonb not null);
        create table if not exists staff_users (user_id uuid primary key, revoked_at timestamptz);
        alter table tenant_app_setting add column if not exists updated_by text;
      `);
    });
    await db.query("insert into staff_users (user_id) values ($1)", [STAFF]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("the limit trips with everyone emailed: the send ends, results can start, and the workspace is still held", async () => {
    const { t, send, decision } = await sendWith(many(3, "sent"));
    const c = await settle(t, send, "held", "abuse_complaints");
    expect(c).toMatchObject({ status: "done", hold_reason: null, pending: 0, sent: 3 });
    expect(await row(send)).toMatchObject({ status: "done", hold_reason: null, finished: true });
    expect(await openHold(t)).toBe(1);
    const missing = await db.query("select * from email_results_missing(now() - interval '1 hour', 100)");
    expect(JSON.stringify(missing.rows)).toContain(decision);
  });

  it("a webhook trips while the last email is on the wire: held for that moment, then ended by the recount once it settles", async () => {
    const { t, send } = await sendWith([...many(5, "sent"), ["last@x.test", "sending"]]);
    for (let i = 0; i < 5; i += 1) expect((await feedback(t, send, `p${i}@x.test`, "complaint")).tripped).toBe(i === 4);
    expect(await row(send)).toMatchObject({ status: "held", hold_reason: "abuse_complaints" });
    expect(await settle(t, send, null)).toMatchObject({ status: "held", sending: 1 });
    await db.query("update email_bulk_send_recipients set status = 'sent' where send_id = $1 and status = 'sending'", [send]);
    expect(await settle(t, send, null)).toMatchObject({ status: "done", hold_reason: null });
    expect(await openHold(t)).toBe(1);
  });

  it("a webhook trips with nobody left: the send is not held, and the workspace is", async () => {
    const { t, send } = await sendWith(many(5, "sent"));
    for (let i = 0; i < 5; i += 1) await feedback(t, send, `p${i}@x.test`, "complaint");
    expect(await row(send)).toMatchObject({ status: "sending", hold_reason: null });
    expect(await openHold(t)).toBe(1);
    expect(await settle(t, send, "done")).toMatchObject({ status: "done" });
  });

  it("a hold with people waiting stays held, and a hold that is not abuse is never ended by a recount", async () => {
    const a = await sendWith([...many(3, "sent"), ...many(2, "pending", "w")]);
    expect(await settle(a.t, a.send, "held", "abuse_bounces")).toMatchObject({ status: "held", hold_reason: "abuse_bounces", pending: 2 });
    expect(await settle(a.t, a.send, null)).toMatchObject({ status: "held", pending: 2 });
    const b = await sendWith(many(3, "sent"));
    expect(await settle(b.t, b.send, "held", "list_archived")).toMatchObject({ status: "held", hold_reason: "list_archived" });
    expect(await settle(b.t, b.send, null)).toMatchObject({ status: "held", hold_reason: "list_archived" });
  });

  it("staff clear and resume: the first chunk's check passes, the real counts are kept, and five fresh complaints hold it again", async () => {
    const { t, send } = await sendWith([...many(5, "sent"), ...many(3, "pending", "w")]);
    for (let i = 0; i < 4; i += 1) await feedback(t, send, `p${i}@x.test`, "complaint");
    await feedback(t, send, "p4@x.test", "hard_bounce");
    await db.query("update email_bulk_send_recipients set feedback = null where send_id = $1 and email_at_send = 'p4@x.test'", [send]);
    expect((await feedback(t, send, "p4@x.test", "complaint")).tripped).toBe(true);
    expect(await row(send)).toMatchObject({ status: "held", hold_reason: "abuse_complaints", complaints: 5, hard_bounces: 1 });
    expect(abuseReason(await settle(t, send, null))).toBe("abuse_complaints");

    expect((await one("select email_bulk_resume_send($1, $2) r", [t, send])).r).toEqual({ ok: false, reason: "abuse_hold" });
    expect((await one("select email_bulk_clear_abuse_hold($1, $2) r", [t, STAFF])).r).toMatchObject({ ok: true });
    expect((await one("select email_bulk_resume_send($1, $2) r", [t, send])).r).toEqual({ ok: true, pending: 3 });

    const after = await settle(t, send, null);
    expect(after).toMatchObject({ status: "sending", complaints: 0, hard_bounces: 0, sent: 5 });
    expect(abuseReason(after)).toBeNull();
    expect(await row(send)).toMatchObject({ complaints: 5, hard_bounces: 1 });

    await db.query("update email_bulk_send_recipients set status = 'sent' where send_id = $1 and email_at_send = 'w0@x.test'", [send]);
    await db.query("update email_bulk_send_recipients set feedback = null where send_id = $1", [send]);
    for (let i = 0; i < 4; i += 1) expect((await feedback(t, send, `p${i}@x.test`, "complaint")).tripped).toBe(false);
    expect((await feedback(t, send, "w0@x.test", "complaint")).tripped).toBe(true);
    expect(await row(send)).toMatchObject({ status: "held", hold_reason: "abuse_complaints", complaints: 10 });
    expect(await openHold(t)).toBe(1);
  });

  it("a provider-refused resume does not wipe complaints that count toward the limit", async () => {
    const { t, send } = await sendWith([...many(4, "sent"), ...many(1, "pending", "w")]);
    for (let i = 0; i < 4; i += 1) await feedback(t, send, `p${i}@x.test`, "complaint");
    await settle(t, send, "held", "provider_refused");
    expect((await one("select email_bulk_resume_send($1, $2) r", [t, send])).r).toEqual({ ok: true, pending: 1 });
    expect(await settle(t, send, null)).toMatchObject({ complaints: 4 });
  });
});
