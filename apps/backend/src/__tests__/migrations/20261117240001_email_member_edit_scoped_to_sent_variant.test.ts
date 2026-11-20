import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  "20261117240001_email_member_edit_scoped_to_sent_variant.sql",
];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");
const sealed = (subject: string) => {
  const html = `<p>${subject}-${randomUUID()}</p>`;
  return { content: { subject }, html, text: "t", render_sha: sha(html, "t") };
};

describe.skipIf(!PGLITE_MODULES)("20261117240001 a member edit blocks Autopilot only for the version it sends (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  const card = async (over: Record<string, unknown> = {}) => {
    const audience = randomUUID();
    const id = (await one(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [T, JSON.stringify({ tool: "sendgrid", audience_id: audience, variants: [sealed("A"), sealed("B")], template_snapshot: {}, renderer_version: "email-r1", ...over })],
    )).id as string;
    return { id, key: `sendgrid:${audience}` };
  };
  const payload = async (id: string) => (await one("select exec_payload b from channel_actions where id = $1", [id])).b;
  const edit = async (id: string, user: string, variant: number) =>
    r("select edit_email_card_variant($1, 'channel_actions', $2, $3, $4, $5, $6) r",
      [T, id, variant, user, JSON.stringify(await payload(id)), JSON.stringify(sealed(`edit-${variant}`))]);
  const testedBy = (id: string, user: string) =>
    db.query(
      "insert into email_test_sends (tenant_id, rail, card_id, variant, test_sha, user_id) values ($1, 'channel_actions', $2, 1, email_card_test_sha((select exec_payload from channel_actions where id = $2), 1), $3)",
      [T, id, user],
    );
  const planned = async (cardId: string, key: string) =>
    (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, card_rail, card_id)
       values ($1, 'sendgrid', $2, $3, 'L', now() - interval '1 minute', 'UTC', 'a', 'founder', $4, 'ready', 'channel_actions', $5) returning id, schedule_gen`,
      [T, key.split(":")[1], key, randomUUID(), cardId],
    )) as { id: string; schedule_gen: number };
  const fire = async (cardId: string, key: string) => {
    const item = await planned(cardId, key);
    return r("select fire_email_planned_send($1, $2, $3, $4) r", [T, item.id, item.schedule_gen, JSON.stringify({ allow: true, count: 5 })]);
  };
  const cgo = (id: string) => r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, 5) r", [T, id, `k-${randomUUID()}`, OWNER]);
  const approvedBy = async (id: string) => (await one("select approved_by from channel_actions where id = $1", [id])).approved_by;

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')", [T, OWNER, ADMIN, MEMBER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("a member edits only version 2: Autopilot's planned send of the untouched version 1 goes out", async () => {
    const { id, key } = await card({ planned_send_id: randomUUID() });
    expect(await edit(id, MEMBER, 2)).toMatchObject({ ok: true });
    expect((await payload(id)).member_edited_by).toBe(MEMBER);
    expect(await fire(id, key)).toMatchObject({ ok: true, outcome: "queued", unattended: true });
    expect(await approvedBy(id)).toBe(OWNER);
  });

  it("a member edits only version 2: Autopilot's own approve of an unplanned card is not refused", async () => {
    const { id } = await card();
    await edit(id, MEMBER, 2);
    expect(await cgo(id)).toMatchObject({ ok: true });
    expect(await approvedBy(id)).toBe(OWNER);
  });

  it("a member edits version 1: the planned send is skipped and nothing is approved", async () => {
    const { id, key } = await card({ planned_send_id: randomUUID() });
    await edit(id, MEMBER, 1);
    expect(await fire(id, key)).toEqual({ ok: true, outcome: "skipped", reason: "member_edit_untested" });
    expect(await approvedBy(id)).toBeNull();
  });

  it("a member edits version 2, then version 1: version 1 is still blocked", async () => {
    const { id } = await card();
    await edit(id, MEMBER, 2);
    await edit(id, MEMBER, 1);
    expect((await payload(id)).member_edited_variants).toEqual([2, 1]);
    expect(await cgo(id)).toEqual({ ok: false, code: "member_edit_untested" });
  });

  it("a card flagged before this change, with no version list, stays blocked even when the member's next edit is version 2", async () => {
    const { id } = await card({ member_edited_by: MEMBER });
    expect(await cgo(id)).toEqual({ ok: false, code: "member_edit_untested" });
    await edit(id, MEMBER, 2);
    expect((await payload(id)).member_edited_variants).toEqual([1, 2]);
    expect(await cgo(id)).toEqual({ ok: false, code: "member_edit_untested" });
  });

  it("an owner or admin edit of another version does not clear the member's edit of version 1", async () => {
    const { id } = await card();
    await edit(id, MEMBER, 1);
    expect(await edit(id, ADMIN, 2)).toMatchObject({ ok: true });
    expect((await payload(id)).member_edited_variants).toEqual([1]);
    expect(await cgo(id)).toEqual({ ok: false, code: "member_edit_untested" });
  });

  it("an admin's test of version 1 after the member edited it still unblocks it", async () => {
    const { id } = await card();
    await edit(id, MEMBER, 1);
    await testedBy(id, ADMIN);
    expect(await cgo(id)).toMatchObject({ ok: true });
  });
});
