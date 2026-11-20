import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_SQL } from "./email-card-live-migrations";

const BOOTSTRAP = EMAIL_CARD_BOOTSTRAP;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const OTHER_T = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const OUTSIDER = randomUUID();

const v = (n: number, html = `<p>version ${n}</p>`) => ({
  content: { subject: `Subject ${n}`, preview_text: "", title: `T${n}`, paragraphs: ["p"], button: { label: "Go", url: "https://example.test" } },
  html,
  text: `version ${n}`,
  render_sha: "a".repeat(64),
});
const body = (over: Record<string, unknown> = {}) => ({
  tool: "sendgrid",
  credential: { kind: "sendgrid_key", key_digest: "b".repeat(64) },
  audience_id: "list-1",
  audience_name: "Members",
  audience_count: 200,
  from_name: "Brightloop",
  from_email: "hello@brightloop.test",
  reply_to: null,
  sendgrid_sender_id: "41",
  sendgrid_suppression_group_id: "7",
  variants: [v(1), v(2), v(3)],
  template_snapshot: { brand_color: "#1a73e8" },
  renderer_version: "email-r1",
  ...over,
});

describe.skipIf(!PG_URL)("20261031190500 email card approve, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> =>
    (await db.query(sql, params)).rows[0] as R;
  const r = (sql: string, params: unknown[]) => one<{ r: Record<string, unknown> }>(sql, params).then((x) => x.r);

  const card = async (tenant = T, payload: unknown = body()): Promise<string> =>
    (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [tenant, JSON.stringify(payload)],
    )).id;
  const decisionCard = async (cls = "bulk_outbound.send", payload: unknown = body({ tool: undefined, list_id: randomUUID(), list_version_id: randomUUID() })): Promise<string> =>
    (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, $2, $3) returning id", [T, cls, JSON.stringify(payload)])).id;

  const test = async (rail: string, id: string, variant: number, user = OWNER) => {
    const pre = await r("select email_card_for_test($1, $2, $3, $4, $5) r", [T, rail, id, variant, user]);
    if (!pre.ok) return pre;
    return r("select record_email_test_send($1, $2, $3, $4, $5, $6) r", [T, rail, id, variant, user, pre.test_sha]);
  };
  const approve = (rail: string, id: string, variant: number, user = OWNER, count: number | null = 200, tenant = T) =>
    r("select approve_email_card($1, $2, $3, $4, $5, $6, $7) r", [tenant, rail, id, variant, user, randomUUID(), count]);

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database (channel_actions already exists)");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER_T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($5, $6, 'owner')", [T, OWNER, ADMIN, MEMBER, OTHER_T, OUTSIDER]);
    for (const sql of EMAIL_CARD_SQL) await db.query(sql);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("no test: test_required, nothing approved", async () => {
    const id = await card();
    expect(await approve("channel_actions", id, 1)).toEqual({ ok: false, code: "test_required" });
    expect(await one("select exec_status from channel_actions where id = $1", [id])).toEqual({ exec_status: null });
  });

  it("a test of version 1 unlocks version 1 only; approve stamps the version and the count and queues it", async () => {
    const id = await card();
    expect(await test("channel_actions", id, 1)).toEqual({ ok: true });
    expect(await approve("channel_actions", id, 2)).toEqual({ ok: false, code: "test_required" });
    expect(await approve("channel_actions", id, 1, OWNER, 205)).toMatchObject({ ok: true, replayed: false });
    expect(
      await one("select exec_status, approved_by, exec_payload->'chosen_variant' cv, exec_payload->'approved_count' ac from channel_actions where id = $1", [id]),
    ).toEqual({ exec_status: "queued", approved_by: OWNER, cv: 1, ac: 205 });
  });

  it("a member can test but not approve, and a member's test does not unlock Approve", async () => {
    const id = await card();
    expect(await test("channel_actions", id, 2, MEMBER)).toEqual({ ok: true });
    expect(await approve("channel_actions", id, 2, MEMBER)).toEqual({ ok: false, code: "not_authorized" });
    expect(await approve("channel_actions", id, 2, ADMIN)).toEqual({ ok: false, code: "test_required" });
    expect(await test("channel_actions", id, 2, ADMIN)).toEqual({ ok: true });
    expect(await approve("channel_actions", id, 2, OWNER)).toMatchObject({ ok: true });
  });

  it("a content change after the test voids it", async () => {
    const id = await card();
    expect(await test("channel_actions", id, 1)).toEqual({ ok: true });
    await db.query("update channel_actions set exec_payload = jsonb_set(exec_payload, '{variants,0,html}', '\"<p>edited</p>\"') where id = $1", [id]);
    expect(await approve("channel_actions", id, 1)).toEqual({ ok: false, code: "test_required" });
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, 2, $3) r", [T, id, OWNER]);
    await db.query("update channel_actions set exec_payload = exec_payload || '{\"from_name\":\"Someone else\"}' where id = $1", [id]);
    expect(await r("select record_email_test_send($1, 'channel_actions', $2, 2, $3, $4) r", [T, id, OWNER, pre.test_sha])).toEqual({ ok: false, code: "card_changed" });
  });

  it("another workspace's card reads as not found, for tests and approves", async () => {
    const id = await card(OTHER_T);
    expect(await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER])).toEqual({ ok: false, code: "not_found" });
    expect(await approve("channel_actions", id, 1)).toEqual({ ok: false, code: "not_found" });
    const mine = await card();
    expect(await approve("channel_actions", mine, 1, OUTSIDER)).toEqual({ ok: false, code: "not_found" });
  });

  it("an approved card refuses a test; a text card asks for a redraft", async () => {
    const id = await card();
    expect(await test("channel_actions", id, 1)).toEqual({ ok: true });
    expect(await approve("channel_actions", id, 1)).toMatchObject({ ok: true });
    expect(await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER])).toMatchObject({ ok: false, code: "not_open" });
    const text = await card(T, { tool: "sendgrid", audience_id: "x", subject: "s", body_text: "b", preview_text: null });
    expect(await approve("channel_actions", text, 1)).toEqual({ ok: false, code: "redraft_required" });
  });

  it("5 tests per person per card per hour", async () => {
    const id = await card();
    for (let i = 0; i < 5; i++) expect(await test("channel_actions", id, 1)).toEqual({ ok: true });
    expect(await test("channel_actions", id, 1)).toEqual({ ok: false, code: "rate_limited" });
    expect(await test("channel_actions", id, 1, ADMIN)).toEqual({ ok: true });
  });

  it("a Zavi-list decision is approved on the decisions rail with the version stamped", async () => {
    const id = await decisionCard();
    expect(await approve("decisions", id, 3)).toEqual({ ok: false, code: "test_required" });
    expect(await test("decisions", id, 3)).toEqual({ ok: true });
    expect(await approve("decisions", id, 3, OWNER, 120)).toMatchObject({ ok: true, changed: true, status: "approved" });
    expect(await one("select status, approved_by, body->'chosen_variant' cv, body->'approved_count' ac from decisions where id = $1", [id])).toEqual({
      status: "approved",
      approved_by: OWNER,
      cv: 3,
      ac: 120,
    });
    expect(await approve("decisions", id, 3)).toMatchObject({ ok: true, changed: false });
    expect(await approve("decisions", id, 1)).toMatchObject({ ok: false, code: "not_open" });
  });

  it("the card view shows each version's test status for the viewer", async () => {
    const id = await card();
    await test("channel_actions", id, 2, MEMBER);
    const view = await r("select email_card_view_state($1, 'channel_actions', $2, $3) r", [T, id, MEMBER]);
    expect(view).toMatchObject({ ok: true, open: true, role: "member", versions: 3 });
    expect(view.tests).toEqual([
      { variant: 1, tested_by_me: false, tested_by_approver: false },
      { variant: 2, tested_by_me: true, tested_by_approver: false },
      { variant: 3, tested_by_me: false, tested_by_approver: false },
    ]);
    expect(await r("select email_card_view_state($1, 'channel_actions', $2, $3) r", [T, id, OUTSIDER])).toEqual({ ok: false, code: "not_found" });
  });

  it("Autopilot stamps version 1 and its count, needs no test, and stops above 1,000", async () => {
    const id = await card(T, body({ audience_id: "list-autopilot" }));
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, $5) r", [T, id, `cgo:${id}`, OWNER, 1001])).toEqual({ ok: false, code: "audience_over_limit" });
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4) r", [T, id, `cgo:${id}`, OWNER])).toEqual({ ok: false, code: "count_required" });
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, $5) r", [T, id, `cgo:${id}`, OWNER, 240])).toMatchObject({ ok: true, replayed: false });
    expect(await one("select exec_status, approved_by_source, exec_payload->'chosen_variant' cv, exec_payload->'approved_count' ac from channel_actions where id = $1", [id])).toEqual({
      exec_status: "queued",
      approved_by_source: "cgo",
      cv: 1,
      ac: 240,
    });
  });

  it("the generic doors still refuse a versions card", async () => {
    const id = await card();
    await test("channel_actions", id, 1);
    expect(await r("select approve_channel_action($1, $2, $3, $4) r", [T, id, randomUUID(), OWNER])).toEqual({ ok: false, code: "email_card_approve_required" });
  });
});
