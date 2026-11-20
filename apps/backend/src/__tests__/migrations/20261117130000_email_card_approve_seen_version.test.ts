import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const STRANGER = randomUUID();
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  "20261111130000_email_member_edit_consent_and_import_guards.sql",
  "20261117130000_email_card_approve_seen_version.sql",
];
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");
const sealed = (subject: string) => {
  const html = `<p>${subject}-${randomUUID()}</p>`;
  return { content: { subject }, html, text: "t", render_sha: sha(html, "t") };
};

describe.skipIf(!PGLITE_MODULES)("20261117130000 approve only the version the approver read (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;
  const card = async () =>
    (await one(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [T, JSON.stringify({ tool: "sendgrid", audience_id: randomUUID(), variants: [sealed("Read by the owner")], template_snapshot: {}, renderer_version: "email-r1" })],
    )).id as string;
  const payload = async (id: string) => (await one("select exec_payload b from channel_actions where id = $1", [id])).b;
  const variant1 = async (id: string) => (await payload(id)).variants[0];
  const tested = async (id: string, user: string) => {
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, user]);
    await r("select record_email_test_send($1, 'channel_actions', $2, 1, $3, $4) r", [T, id, user, pre.test_sha]);
  };
  const approveSeen = (id: string, user: string, seen: unknown) =>
    r("select approve_email_card_seen($1, 'channel_actions', $2, 1, $3, $4, 50, $5) r", [T, id, user, randomUUID(), seen === null ? null : JSON.stringify(seen)]);
  const state = async (id: string) => one("select exec_status, approved_by from channel_actions where id = $1", [id]);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin')", [T, OWNER, ADMIN]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("an admin edits and tests after the owner loaded the card: the owner's approve sends nothing", async () => {
    const id = await card();
    await tested(id, OWNER);
    const seenByOwner = await variant1(id);
    expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r",
      [T, id, ADMIN, JSON.stringify(await payload(id)), JSON.stringify(sealed("Changed by the admin"))])).toMatchObject({ ok: true });
    await tested(id, ADMIN);
    expect(await approveSeen(id, OWNER, seenByOwner)).toEqual({ ok: false, code: "version_changed" });
    expect(await state(id)).toEqual({ exec_status: null, approved_by: null });
    expect(await approveSeen(id, OWNER, await variant1(id))).toMatchObject({ ok: true });
    expect((await state(id)).approved_by).toBe(OWNER);
  });

  it("no expected version is refused, and refusals for a stranger or another tenant stay the original ones", async () => {
    const id = await card();
    await tested(id, OWNER);
    expect(await approveSeen(id, OWNER, null)).toEqual({ ok: false, code: "version_changed" });
    expect(await approveSeen(id, STRANGER, await variant1(id))).toEqual({ ok: false, code: "not_found" });
    expect(await r("select approve_email_card_seen($1, 'channel_actions', $2, 1, $3, 'x', 50, $4) r", [randomUUID(), id, OWNER, JSON.stringify(await variant1(id))])).toEqual({ ok: false, code: "not_found" });
    expect(await state(id)).toEqual({ exec_status: null, approved_by: null });
  });

  it("a replay of the same approval with the same version is still the original replay", async () => {
    const id = await card();
    await tested(id, OWNER);
    const seen = await variant1(id);
    const key = randomUUID();
    const first = await r("select approve_email_card_seen($1, 'channel_actions', $2, 1, $3, $4, 50, $5) r", [T, id, OWNER, key, JSON.stringify(seen)]);
    expect(first).toMatchObject({ ok: true });
    const again = await r("select approve_email_card_seen($1, 'channel_actions', $2, 1, $3, $4, 50, $5) r", [T, id, OWNER, key, JSON.stringify(seen)]);
    expect(again).toMatchObject({ ok: true, replayed: true });
  });
});
