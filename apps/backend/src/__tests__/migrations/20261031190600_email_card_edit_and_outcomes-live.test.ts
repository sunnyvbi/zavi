import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_SQL } from "./email-card-live-migrations";

const SQL = EMAIL_CARD_SQL;

const BOOTSTRAP = EMAIL_CARD_BOOTSTRAP;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const OTHER_T = randomUUID();
const OWNER = randomUUID();
const MEMBER = randomUUID();

const seal = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number, html = `<p>version ${n}</p>`) => ({
  content: { subject: `Subject ${n}` },
  html,
  text: `version ${n}`,
  render_sha: seal(html, `version ${n}`),
});
const body = () => ({
  tool: "sendgrid",
  audience_id: "list-1",
  from_email: "hello@northwind.test",
  variants: [v(1), v(2)],
  template_snapshot: { brand_color: "#2e7d32" },
  renderer_version: "email-r1",
});

describe.skipIf(!PG_URL)("20261031190600 email card edit + outcomes, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => (await db.query(sql, params)).rows[0] as R;
  const r = (sql: string, params: unknown[]) => one<{ r: Record<string, unknown> }>(sql, params).then((x) => x.r);
  const card = async (tenant = T): Promise<string> =>
    (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [tenant, JSON.stringify(body())])).id;
  const decision = async (): Promise<string> =>
    (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', $2) returning id", [T, JSON.stringify(body())])).id;
  const sha = async (rail: string, id: string, n: number) =>
    (await one<{ s: string }>(`select email_card_test_sha(${rail === "decisions" ? "body" : "exec_payload"}, $2) s from ${rail} where id = $1`, [id, n])).s;
  const approve = async (id: string) => {
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER]);
    await r("select record_email_test_send($1, 'channel_actions', $2, 1, $3, $4) r", [T, id, OWNER, pre.test_sha]);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 100) r", [T, id, OWNER, randomUUID()])).toMatchObject({ ok: true });
  };

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER_T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'member')", [T, OWNER, MEMBER]);
    for (const s of SQL) await db.query(s);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("a redraft closes an open card with a pointer, and leaves a decided one alone", async () => {
    const old = await card();
    const fresh = await card();
    expect(await r("select replace_email_card($1, 'channel_actions', $2, 'channel_actions', $3) r", [T, old, fresh])).toEqual({ ok: true, replaced: true });
    expect(await one("select status, note, exec_payload->'replaced_by' p from channel_actions where id = $1", [old])).toEqual({
      status: "rejected",
      note: "replaced_by_newer_draft",
      p: { rail: "channel_actions", id: fresh },
    });
    const sent = await card();
    await approve(sent);
    expect(await r("select replace_email_card($1, 'channel_actions', $2, 'channel_actions', $3) r", [T, sent, fresh])).toMatchObject({ ok: true, replaced: false });
    expect(await one("select status, approved_by from channel_actions where id = $1", [sent])).toEqual({ status: "pending", approved_by: OWNER });
    const d = await decision();
    expect(await r("select replace_email_card($1, 'decisions', $2, 'decisions', $3) r", [T, d, await decision()])).toEqual({ ok: true, replaced: true });
    expect(await one("select status, body->>'rejected_reason' why from decisions where id = $1", [d])).toEqual({ status: "rejected", why: "replaced_by_newer_draft" });
    expect(await r("select replace_email_card($1, 'channel_actions', $2, 'channel_actions', $3) r", [T, await card(OTHER_T), fresh])).toEqual({ ok: false, code: "not_found" });
  });

  it("an edit re-seals one version, voids its old test, and is refused on a stale read or a decided card", async () => {
    const id = await card();
    const before = await sha("channel_actions", id, 1);
    const read = (await one<{ b: unknown }>("select exec_payload b from channel_actions where id = $1", [id])).b;
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER]);
    await r("select record_email_test_send($1, 'channel_actions', $2, 1, $3, $4) r", [T, id, OWNER, pre.test_sha]);
    const edited = v(1, "<p>edited</p>");
    const out = await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, MEMBER, JSON.stringify(read), JSON.stringify(edited)]);
    expect(out.ok).toBe(true);
    expect(out.test_sha).not.toBe(before);
    expect(await one("select exec_payload->'variants'->0->>'html' h, exec_payload->>'edited_by' by from channel_actions where id = $1", [id])).toEqual({ h: "<p>edited</p>", by: MEMBER });
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 100) r", [T, id, OWNER, randomUUID()])).toEqual({ ok: false, code: "test_required" });
    expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, MEMBER, JSON.stringify(read), JSON.stringify(edited)])).toEqual({ ok: false, code: "card_changed" });
    const now = (await one<{ b: unknown }>("select exec_payload b from channel_actions where id = $1", [id])).b;
    await approve(id);
    expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, MEMBER, JSON.stringify(now), JSON.stringify(edited)])).toMatchObject({ ok: false, code: "not_open" });
    expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [OTHER_T, id, MEMBER, JSON.stringify(now), JSON.stringify(edited)])).toEqual({ ok: false, code: "not_found" });
  });

  it("an outcome is claimed once per card", async () => {
    const id = await card();
    expect((await one<{ c: boolean }>("select claim_email_send_outcome($1, 'channel_actions', $2, 'sent', 'Sent') c", [T, id])).c).toBe(true);
    expect((await one<{ c: boolean }>("select claim_email_send_outcome($1, 'channel_actions', $2, 'sent', 'Sent') c", [T, id])).c).toBe(false);
    expect((await one<{ c: boolean }>("select claim_email_send_outcome($1, 'channel_actions', $2, 'sent', 'Sent') c", [OTHER_T, id])).c).toBe(false);
  });

  it("20261031191500: the kind is part of the claim, so a different-list email and a plain failure never suppress each other", async () => {
    const id = await card();
    const claim = async (kind: string | null) =>
      (await one<{ c: boolean }>(
        kind === null
          ? "select claim_email_send_outcome($1, 'channel_actions', $2, 'failed', 'Not sent') c"
          : "select claim_email_send_outcome(p_tenant_id => $1, p_rail => 'channel_actions', p_card_id => $2, p_outcome => 'failed', p_line => 'Different list', p_kind => $3) c",
        kind === null ? [T, id] : [T, id, kind],
      )).c;
    expect(await claim("audience_mismatch")).toBe(true);
    expect(await claim(null)).toBe(true);
    expect(await claim("audience_mismatch")).toBe(false);
    expect(await claim(null)).toBe(false);
    await db.query("savepoint k");
    await expect(claim("something_else")).rejects.toThrow(/check/);
    await db.query("rollback to savepoint k");
    expect((await one<{ n: number }>("select count(*)::int n from email_send_outcomes where card_id = $1", [id])).n).toBe(2);
  });
});
