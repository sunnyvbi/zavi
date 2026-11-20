import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SKIP_REASONS } from "@/services/email-plan/messages";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const FILE = "20261117230000_email_plan_skip_reason_from_gate.sql";
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  FILE,
];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");
const sealed = (subject: string) => {
  const html = `<p>${subject}-${randomUUID()}</p>`;
  return { content: { subject }, html, text: "t", render_sha: sha(html, "t") };
};

describe.skipIf(!PGLITE_MODULES)("20261117230000 the Coming up reason says why Auto send held the planned email (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];

  const fireFresh = async (unattended: Record<string, unknown>) => {
    const audience = randomUUID();
    const key = `sendgrid:${audience}`;
    const cardId = (await one(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [T, JSON.stringify({ tool: "sendgrid", audience_id: audience, variants: [sealed("S1")], template_snapshot: {}, renderer_version: "email-r1" })],
    )).id as string;
    const item = (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, card_rail, card_id)
       values ($1, 'sendgrid', $2, $3, 'L', now() - interval '1 minute', 'UTC', 'a', 'founder', $4, 'ready', 'channel_actions', $5) returning id, schedule_gen`,
      [T, audience, key, randomUUID(), cardId],
    )) as { id: string; schedule_gen: number };
    const out = (await one("select fire_email_planned_send($1, $2, $3, $4) r", [T, item.id, item.schedule_gen, JSON.stringify(unattended)])).r;
    const row = await one("select status, status_reason from email_planned_sends where id = $1", [item.id]);
    const card = await one("select exec_status, approved_by from channel_actions where id = $1", [cardId]);
    return { out, row, card };
  };

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("Auto send refused because the list is over 1,000 people: the row says so, nothing is approved", async () => {
    const f = await fireFresh({ allow: false, count: 1500, reasons: ["audience_over_limit"] });
    expect(f.out).toMatchObject({ ok: true, outcome: "skipped", reason: "audience_over_limit" });
    expect(f.row).toEqual({ status: "skipped", status_reason: "audience_over_limit" });
    expect(f.card).toEqual({ exec_status: null, approved_by: null });
    expect(SKIP_REASONS[f.row.status_reason]).toMatch(/over 1,000 people/);
  });

  it("the over-limit reason wins even when other reasons came with it", async () => {
    const f = await fireFresh({ allow: false, count: 1500, reasons: ["channel_autorun_off", "audience_over_limit"] });
    expect(f.row).toEqual({ status: "skipped", status_reason: "audience_over_limit" });
  });

  it("an empty list with Auto send allowed is not called over 1,000 people", async () => {
    const f = await fireFresh({ allow: true, count: 0, reasons: [] });
    expect(f.row).toEqual({ status: "skipped", status_reason: "audience_empty" });
    expect(f.card).toEqual({ exec_status: null, approved_by: null });
    expect(SKIP_REASONS[f.row.status_reason]).toBe("Not approved by the planned time, and the list had nobody on it, so Autopilot did not send it. The draft is still there.");
  });

  it("a list Zavi could not count is not called empty, and nothing is approved", async () => {
    for (const unattended of [{ allow: true, count: null, reasons: [] }, { allow: true, reasons: [] }]) {
      const f = await fireFresh(unattended);
      expect(f.out).toMatchObject({ ok: true, outcome: "skipped", reason: "not_approved_in_time" });
      expect(f.row).toEqual({ status: "skipped", status_reason: "not_approved_in_time" });
      expect(f.card).toEqual({ exec_status: null, approved_by: null });
      expect(SKIP_REASONS[f.row.status_reason]).not.toMatch(/nobody/);
    }
  });

  it("controls: Autopilot off, or no reasons at all, is still 'not approved in time'", async () => {
    expect((await fireFresh({ allow: false, count: 5, reasons: ["autopilot_off"] })).row).toEqual({ status: "skipped", status_reason: "not_approved_in_time" });
    expect((await fireFresh({ allow: false, count: null, reasons: [] })).row).toEqual({ status: "skipped", status_reason: "not_approved_in_time" });
    expect((await fireFresh({ allow: false, count: 5 })).row).toEqual({ status: "skipped", status_reason: "not_approved_in_time" });
  });

  it("control: an allowed list over 1,000 is still held as over the limit", async () => {
    expect((await fireFresh({ allow: true, count: 1001, reasons: [] })).row).toEqual({ status: "skipped", status_reason: "audience_over_limit" });
  });

  it("control: an allowed list in range is still approved and queued", async () => {
    const f = await fireFresh({ allow: true, count: 5, reasons: [] });
    expect(f.out).toMatchObject({ ok: true, outcome: "queued" });
    expect(f.card.approved_by).toBe(OWNER);
  });

  it("is re-runnable", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await db.exec(readFileSync(join(__dirname, "../../../../../supabase/migrations", FILE), "utf8").replace(/^(begin|commit);$/gm, ""));
    expect((await fireFresh({ allow: false, count: 1500, reasons: ["audience_over_limit"] })).row.status_reason).toBe("audience_over_limit");
  });
});
