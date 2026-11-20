import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const MEMBER = randomUUID();
const sha = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number) => ({ content: { subject: `S${n}` }, html: `<p>${n}</p>`, text: `${n}`, render_sha: sha(`<p>${n}</p>`, `${n}`) });
const body = () => ({ tool: "sendgrid", audience_id: randomUUID(), variants: [v(1), v(2)], template_snapshot: {}, renderer_version: "email-r1" });

const MINE = ["20261108100000_email_send_pause.sql", "20261108100100_email_card_takeover_and_redispatch.sql", "20261108100150_email_card_tests_atomic.sql"];

describe.skipIf(!PGLITE_MODULES)("20261108100150 the 5-tests-an-hour limit is taken before the email goes out (pglite)", () => {
  let db: Db;
  const r = async (sql: string, p: unknown[] = []) => (await db.query<{ r: Record<string, any> }>(sql, p)).rows[0].r;
  const card = async () => (await db.query<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [T, JSON.stringify(body())])).rows[0].id;
  const pre = (id: string, user = MEMBER) => r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, user]);

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [T, OWNER, MEMBER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("ten test sends started together before any is recorded: only five are let through", async () => {
    const id = await card();
    const outs = await Promise.all(Array.from({ length: 10 }, () => pre(id)));
    expect(outs.filter((o) => o.ok === true)).toHaveLength(5);
    expect(outs.filter((o) => o.code === "rate_limited")).toHaveLength(5);
  });

  it("the limit is per person and per card", async () => {
    const id = await card();
    for (let i = 0; i < 5; i++) expect(await pre(id)).toMatchObject({ ok: true });
    expect(await pre(id)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await pre(id, OWNER)).toMatchObject({ ok: true });
    expect(await pre(await card())).toMatchObject({ ok: true });
  });

  it("a test whose send failed after the check still counts: the provider was asked", async () => {
    const id = await card();
    for (let i = 0; i < 5; i++) await pre(id);
    const recorded = await db.query("select count(*)::int n from email_test_sends where card_id = $1", [id]);
    expect(recorded.rows[0].n).toBe(0);
    expect(await pre(id)).toMatchObject({ ok: false, code: "rate_limited" });
  });
});
