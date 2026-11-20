import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const VIEWER = randomUUID();
const STRANGER = randomUUID();
const FILE = "20261111130000_email_member_edit_consent_and_import_guards.sql";
const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261108100300_email_card_send_state_and_doors.sql",
  "20261108100400_email_send_double_send_guards.sql",
  FILE,
];
const dir = join(__dirname, "../../../../../supabase/migrations");
const rawSql = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
const sha = (h: string, t: string) => createHash("sha256").update("email-r1").update("\0").update(h).update("\0").update(t).digest("hex");
const sealed = (subject: string, extra: Record<string, unknown> = {}) => {
  const html = `<p>${subject.length}-${randomUUID()}</p>`;
  return { content: { subject, ...extra }, html, text: "t", render_sha: sha(html, "t") };
};

describe.skipIf(!PGLITE_MODULES)("20261111130000 member edits, list consent and imported addresses (pglite)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  const card = async (over: Record<string, unknown> = {}) => {
    const audience = randomUUID();
    const id = (await one(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [T, JSON.stringify({ tool: "sendgrid", audience_id: audience, variants: [sealed("S1")], template_snapshot: {}, renderer_version: "email-r1", ...over })],
    )).id as string;
    return { id, key: `sendgrid:${audience}` };
  };
  const payload = async (id: string) => (await one("select exec_payload b from channel_actions where id = $1", [id])).b;
  const edit = async (id: string, user: string, s: unknown, rail = "channel_actions") => {
    const body = rail === "channel_actions" ? await payload(id) : (await one("select body b from decisions where id = $1", [id])).b;
    return r("select edit_email_card_variant($1, $2, $3, 1, $4, $5, $6) r", [T, rail, id, user, JSON.stringify(body), JSON.stringify(s)]);
  };
  const testedBy = async (id: string, user: string, rail = "channel_actions") => {
    const body = rail === "channel_actions" ? "(select exec_payload from channel_actions where id = $3)" : "(select body from decisions where id = $3)";
    await db.query(
      `insert into email_test_sends (tenant_id, rail, card_id, variant, test_sha, user_id) values ($1, $2, $3, 1, email_card_test_sha(${body}, 1), $4)`,
      [T, rail, id, user],
    );
  };
  const planned = async (rail: string, cardId: string, key: string) =>
    (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status, card_rail, card_id)
       values ($1, 'sendgrid', $2, $3, 'L', now() - interval '1 minute', 'UTC', 'a', 'founder', $4, 'ready', $5, $6) returning id, schedule_gen`,
      [T, key.split(":")[1], key, randomUUID(), rail, cardId],
    )) as { id: string; schedule_gen: number };
  const fire = async (item: { id: string; schedule_gen: number }) =>
    r("select fire_email_planned_send($1, $2, $3, $4) r", [T, item.id, item.schedule_gen, JSON.stringify({ allow: true, count: 5 })]);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'viewer')", [T, OWNER, ADMIN, MEMBER, VIEWER]);
  }, 120_000);
  afterAll(async () => db?.close());

  describe("a subject or preview text with a line break is refused by the SQL edit too", () => {
    it.each([
      ["subject", "Hello\r\nBcc: victim@example.com", {}],
      ["subject", "Hello\nWorld", {}],
      ["subject", "Hello\tWorld", {}],
      ["subject", "Hello\u0085World", {}],
      ["subject", "Hello\u2028World", {}],
      ["preview", "Fine subject", { preview_text: "first\r\nsecond" }],
    ])("%s %j is refused and the card is unchanged", async (_f, subject, extra) => {
      const { id } = await card();
      const before = await payload(id);
      expect(await edit(id, OWNER, sealed(subject, extra))).toEqual({
        ok: false,
        code: "bad_content",
        message: "The subject and the preview text must each be on one line: remove the line break or hidden character.",
      });
      expect(await payload(id)).toEqual(before);
    });

    it("control: a one-line subject with unicode is stored", async () => {
      const { id } = await card();
      expect(await edit(id, OWNER, sealed("Spring — 10% off 🌸", { preview_text: "this week" }))).toMatchObject({ ok: true });
      expect((await payload(id)).variants[0].content.subject).toBe("Spring — 10% off 🌸");
    });
  });

  describe("a member's edit stops Autopilot from sending the planned draft until an owner or admin tests it", () => {
    it("the QA case: a member edits a ready planned draft, Auto send is on, nobody tests it: it is skipped and never approved", async () => {
      const { id, key } = await card({ planned_send_id: randomUUID() });
      expect(await edit(id, MEMBER, sealed("Member wording"))).toMatchObject({ ok: true });
      expect((await payload(id)).member_edited_by).toBe(MEMBER);
      const item = await planned("channel_actions", id, key);
      expect(await fire(item)).toEqual({ ok: true, outcome: "skipped", reason: "member_edit_untested" });
      expect(await one("select status, status_reason from email_planned_sends where id = $1", [item.id])).toEqual({ status: "skipped", status_reason: "member_edit_untested" });
      expect(await one("select approved_by, exec_status from channel_actions where id = $1", [id])).toEqual({ approved_by: null, exec_status: null });
      expect((await one("select count(*)::int n from email_plan_outbox where item_id = $1", [item.id])).n).toBe(0);
    });

    it("the member testing their own edit does not count", async () => {
      const { id, key } = await card({ planned_send_id: randomUUID() });
      await edit(id, MEMBER, sealed("Member wording"));
      await testedBy(id, MEMBER);
      expect(await fire(await planned("channel_actions", id, key))).toMatchObject({ outcome: "skipped", reason: "member_edit_untested" });
    });

    it("an owner's test from BEFORE the member's edit does not count: the test must match the bytes that would go out", async () => {
      const { id, key } = await card({ planned_send_id: randomUUID() });
      await testedBy(id, OWNER);
      await edit(id, MEMBER, sealed("Member wording"));
      expect(await fire(await planned("channel_actions", id, key))).toMatchObject({ outcome: "skipped", reason: "member_edit_untested" });
    });

    it("a later owner edit does not wash the member's edit out", async () => {
      const { id, key } = await card({ planned_send_id: randomUUID() });
      await edit(id, MEMBER, sealed("Member wording"));
      expect(await edit(id, OWNER, sealed("Owner wording"))).toMatchObject({ ok: true });
      expect((await payload(id)).member_edited_by).toBe(MEMBER);
      expect(await fire(await planned("channel_actions", id, key))).toMatchObject({ outcome: "skipped", reason: "member_edit_untested" });
    });

    it("an admin's test of version 1 after the member's edit lets Autopilot send it", async () => {
      const { id, key } = await card({ planned_send_id: randomUUID() });
      await edit(id, MEMBER, sealed("Member wording"));
      await testedBy(id, ADMIN);
      expect(await fire(await planned("channel_actions", id, key))).toMatchObject({ ok: true, outcome: "queued", unattended: true });
      expect(await one("select approved_by from channel_actions where id = $1", [id])).toEqual({ approved_by: OWNER });
    });

    it("control: an owner's own edit needs no extra test, as before", async () => {
      const { id, key } = await card({ planned_send_id: randomUUID() });
      await edit(id, OWNER, sealed("Owner wording"));
      expect((await payload(id)).member_edited_by).toBeUndefined();
      expect(await fire(await planned("channel_actions", id, key))).toMatchObject({ ok: true, outcome: "queued" });
    });

    it("the Zavi-list rail: a member-edited planned decision is skipped too", async () => {
      const list = randomUUID();
      const d = (await one(
        "insert into decisions (tenant_id, decision_class, body, status) values ($1, 'bulk_outbound.send', $2, 'proposed') returning id",
        [T, JSON.stringify({ list_id: list, variants: [sealed("S1")], template_snapshot: {}, renderer_version: "email-r1", member_edited_by: MEMBER })],
      )).id as string;
      const item = await planned("decisions", d, `zavi_list:${list}`);
      expect(await fire(item)).toMatchObject({ outcome: "skipped", reason: "member_edit_untested" });
      expect(await one("select status, approved_by from decisions where id = $1", [d])).toEqual({ status: "proposed", approved_by: null });
    });

    it("Autopilot's own approve of an unplanned card refuses a member edit until an owner or admin tests it", async () => {
      const { id } = await card();
      await edit(id, MEMBER, sealed("Member wording"));
      expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, 5) r", [T, id, `k-${randomUUID()}`, OWNER])).toEqual({ ok: false, code: "member_edit_untested" });
      expect(await one("select approved_by from channel_actions where id = $1", [id])).toEqual({ approved_by: null });
      await testedBy(id, OWNER);
      expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, 5) r", [T, id, `k-${randomUUID()}`, OWNER])).toMatchObject({ ok: true });
    });
  });

  describe("only an owner or admin confirms a list's consent", () => {
    const imported = async () => {
      const out = await r("select email_list_import_version($1, null, $2, 'csv', '{}', $3, $4) r", [T, `List ${randomUUID()}`, ["a@example.com"], MEMBER]);
      expect(out).toMatchObject({ ok: true });
      return out as { list_id: string; version_id: string };
    };
    const consent = (v: { list_id: string; version_id: string }, user: string) =>
      r("select email_list_record_consent($1, $2, $3, $4, 'They agreed.') r", [T, v.list_id, v.version_id, user]);
    const state = async (v: { list_id: string; version_id: string }) =>
      one("select v.consent_confirmed_at is not null done, l.active_version_id active from email_list_versions v join email_lists l on l.id = v.list_id where v.id = $1", [v.version_id]);

    it.each([["member", MEMBER], ["viewer", VIEWER]])("a %s is refused and nothing is recorded", async (_n, user) => {
      const v = await imported();
      expect(await consent(v, user)).toEqual({ ok: false, reason: "not_authorized" });
      expect(await state(v)).toEqual({ done: false, active: null });
    });

    it("a stranger is still not a member", async () => {
      const v = await imported();
      expect(await consent(v, STRANGER)).toEqual({ ok: false, reason: "not_a_member" });
    });

    it.each([["owner", OWNER], ["admin", ADMIN]])("an %s confirms it", async (_n, user) => {
      const v = await imported();
      expect(await consent(v, user)).toEqual({ ok: true, active_version_id: v.version_id });
      expect(await state(v)).toEqual({ done: true, active: v.version_id });
    });
  });

  describe("the import refuses a value that is not a plain address, whichever path sent it", () => {
    it.each([
      "<script>alert(1)</script>@yopmail.com",
      "a<b@example.com",
      "a>b@example.com",
      "a;b@example.com",
      "a,b@example.com",
      "\"q\"@example.com",
      "a b@example.com",
      "a\r\nb@example.com",
      "no-at-sign.example.com",
      "x@nodot",
    ])("%j: the whole import is refused and nothing is stored", async (bad) => {
      const name = `List ${randomUUID()}`;
      const contactsBefore = (await one("select count(*)::int n from email_contacts where tenant_id = $1", [T])).n;
      for (const kind of ["csv", "database"]) {
        expect(await r("select email_list_import_version($1, null, $2, $3, '{}', $4, $5) r", [T, name, kind, ["ok@example.com", bad], OWNER])).toEqual({
          ok: false,
          reason: "invalid_address",
        });
      }
      expect((await one("select count(*)::int n from email_lists where tenant_id = $1 and name = $2", [T, name])).n).toBe(0);
      expect((await one("select count(*)::int n from email_contacts where tenant_id = $1", [T])).n).toBe(contactsBefore);
    });

    it("control: real addresses, any case and padding, import as before", async () => {
      expect(await r("select email_list_import_version($1, null, $2, 'database', '{}', $3, $4) r", [T, `List ${randomUUID()}`, [" Real@Example.com ", "o'brien+tag@sub.example.co.uk"], OWNER])).toMatchObject({
        ok: true,
        contact_count: 2,
      });
    });
  });

  it("is re-runnable", async () => {
    await db.exec(rawSql(FILE));
    expect(await r("select _email_import_address_ok('ok@example.com') r")).toBe(true);
  });
});
