import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_SQL } from "./email-card-live-migrations";

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const OTHER_T = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();

const seal = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number) => ({ content: { subject: `Subject ${n}` }, html: `<p>${n}</p>`, text: `${n}`, render_sha: seal(`<p>${n}</p>`, `${n}`) });
const toolBody = (audience = "list-1") => ({
  tool: "mailchimp",
  audience_id: audience,
  from_email: "hello@brightloop.test",
  variants: [v(1)],
  template_snapshot: { brand_color: "#2e7d32" },
  renderer_version: "email-r1",
});

describe.skipIf(!PG_URL)("20261031191300 email test list marks, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => (await db.query(sql, params)).rows[0] as R;
  const r = (sql: string, params: unknown[] = []) => one<{ r: Record<string, unknown> }>(sql, params).then((x) => x.r);
  const mark = (key: string, marked: boolean, actor = OWNER, tenant = T) => r("select set_email_test_list($1, $2, $3, $4) r", [tenant, actor, key, marked]);
  const items = async () => (await db.query("select item, status from channel_settings where tenant_id = $1 and field_id = 'email_test_lists' order by item", [T])).rows;
  const card = async (audience = "list-1"): Promise<string> =>
    (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [T, JSON.stringify(toolBody(audience))])).id;
  const tested = async (id: string) => {
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER]);
    await r("select record_email_test_send($1, 'channel_actions', $2, 1, $3, $4) r", [T, id, OWNER, pre.test_sha]);
  };
  const approve = (id: string) => r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 100) r", [T, id, OWNER, randomUUID()]);

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(EMAIL_CARD_BOOTSTRAP);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER_T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')", [T, OWNER, ADMIN, MEMBER]);
    await db.query("insert into tenant_channels values ($1, 'email_marketing'), ($2, 'email_marketing')", [T, OTHER_T]);
    for (const s of EMAIL_CARD_SQL) await db.query(s);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("owners and admins mark and unmark one list at a time; a member cannot; repeats change nothing", async () => {
    expect(await mark("mailchimp:list-a", true, MEMBER)).toEqual({ ok: false, code: "not_authorized" });
    expect(await mark("mailchimp:list-a", true)).toEqual({ ok: true, changed: true, marked: true });
    expect(await mark("mailchimp:list-a", true, ADMIN)).toEqual({ ok: true, changed: false, marked: true });
    expect(await mark("klaviyo:K9", true, ADMIN)).toMatchObject({ ok: true, changed: true });
    expect((await items()).map((x) => x.item)).toEqual(["klaviyo:K9", "mailchimp:list-a"]);
    expect(await mark("mailchimp:list-a", false)).toEqual({ ok: true, changed: true, marked: false });
    expect(await mark("mailchimp:list-a", false)).toEqual({ ok: true, changed: false, marked: false });
    expect((await items()).map((x) => x.item)).toEqual(["klaviyo:K9"]);
    expect(await mark("mailchimp:x", true, OWNER, OTHER_T)).toEqual({ ok: false, code: "not_authorized" });
    expect(await mark("gmail:x", true)).toEqual({ ok: false, code: "bad_list" });
    expect(await mark("mailchimp:a b", true)).toEqual({ ok: false, code: "bad_list" });
  });

  it("a Zavi list must be this workspace's live list to be marked; an archived or unknown one can still be unmarked", async () => {
    const live = (await one<{ id: string }>("insert into email_lists (tenant_id) values ($1) returning id", [T])).id;
    const archived = (await one<{ id: string }>("insert into email_lists (tenant_id, archived_at) values ($1, now()) returning id", [T])).id;
    const foreign = (await one<{ id: string }>("insert into email_lists (tenant_id) values ($1) returning id", [OTHER_T])).id;
    expect(await mark(`zavi_list:${live}`, true)).toMatchObject({ ok: true, changed: true });
    expect(await mark(`zavi_list:${archived}`, true)).toEqual({ ok: false, code: "list_not_found" });
    expect(await mark(`zavi_list:${foreign}`, true)).toEqual({ ok: false, code: "list_not_found" });
    await db.query("update email_lists set archived_at = now() where id = $1", [live]);
    expect(await mark(`zavi_list:${live}`, false)).toMatchObject({ ok: true, changed: true });
    expect(await mark(`zavi_list:${randomUUID()}`, false)).toMatchObject({ ok: true, changed: false });
  });

  it("a Zavi list id is kept lowercase (the card's key is), and anything not a UUID is refused", async () => {
    const live = (await one<{ id: string }>("insert into email_lists (tenant_id) values ($1) returning id", [T])).id;
    expect(await mark(`zavi_list:${live.toUpperCase()}`, true)).toMatchObject({ ok: true, changed: true });
    expect((await db.query("select item from channel_settings where item like 'zavi_list:%' and item ilike $1", [`%${live}`])).rows.map((x) => x.item)).toEqual([`zavi_list:${live}`]);
    expect((await one<{ k: string }>("select _email_test_list_key('bulk_outbound.send', $1) k", [JSON.stringify({ list_id: live.toUpperCase() })])).k).toBe(`zavi_list:${live}`);
    expect((await one<{ m: boolean }>("select _email_test_list_marked($1, $2) m", [T, `zavi_list:${live}`])).m).toBe(true);
    expect(await mark("zavi_list:not-a-uuid", false)).toEqual({ ok: false, code: "bad_list" });
    expect(await mark(`zavi_list:${live.toUpperCase()}`, false)).toMatchObject({ ok: true, changed: true });
  });

  it("a paused mark still counts; a dismissed one does not and is re-marked in place", async () => {
    await mark("sendgrid:777", true);
    await db.query("update channel_settings set status = 'paused' where item = 'sendgrid:777'");
    expect((await one<{ m: boolean }>("select _email_test_list_marked($1, 'sendgrid:777') m", [T])).m).toBe(true);
    await db.query("update channel_settings set status = 'dismissed' where item = 'sendgrid:777'");
    expect((await one<{ m: boolean }>("select _email_test_list_marked($1, 'sendgrid:777') m", [T])).m).toBe(false);
    expect(await mark("sendgrid:777", true)).toMatchObject({ ok: true, changed: true });
    expect((await one<{ s: string | null }>("select status s from channel_settings where item = 'sendgrid:777'")).s).toBeNull();
  });

  it("approve refuses a card whose list is marked; unmarked, the same card approves", async () => {
    const id = await card("list-z");
    await tested(id);
    await mark("mailchimp:list-z", true);
    expect(await approve(id)).toEqual({ ok: false, code: "test_list" });
    expect((await one<{ s: string }>("select status s from channel_actions where id = $1", [id])).s).toBe("pending");
    await mark("mailchimp:list-z", false);
    expect(await approve(id)).toMatchObject({ ok: true });
  });

  it("Autopilot's approve refuses a marked list: the card stays pending", async () => {
    const id = await card("list-auto");
    await mark("mailchimp:list-auto", true);
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, 50) r", [T, id, randomUUID(), OWNER])).toEqual({ ok: false, code: "test_list" });
    expect((await one<{ s: string; a: string | null }>("select status s, approved_by_source a from channel_actions where id = $1", [id]))).toEqual({ s: "pending", a: null });
  });

  it("the card's list key, for both rails", async () => {
    const k = (cls: string, body: unknown) => one<{ k: string | null }>("select _email_test_list_key($1, $2) k", [cls, JSON.stringify(body)]).then((x) => x.k);
    expect(await k("email_campaign.create_and_send", { tool: "klaviyo", audience_id: "K1" })).toBe("klaviyo:K1");
    expect(await k("bulk_outbound.send", { list_id: "11111111-1111-4111-8111-111111111111" })).toBe("zavi_list:11111111-1111-4111-8111-111111111111");
    expect(await k("email.send", {})).toBeNull();
  });
});
