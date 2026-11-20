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
const VIEWER = randomUUID();
const sha = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number, html = `<p>version ${n}</p>`) => ({ content: { subject: `Subject ${n}` }, html, text: `version ${n}`, render_sha: sha(html, `version ${n}`) });
const body = () => ({ tool: "sendgrid", audience_id: "list-1", variants: [v(1), v(2)], template_snapshot: { brand_color: "#2e7d32" }, renderer_version: "email-r1" });
const REFUSED = /email_card_approve_required/;

describe.skipIf(!PG_URL)("20261031190800 email send freeze, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => (await db.query(sql, params)).rows[0] as R;
  const r = (sql: string, params: unknown[]) => one<{ r: Record<string, unknown> }>(sql, params).then((x) => x.r);
  const attempt = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    await db.query("savepoint s");
    try {
      await db.query(sql, params);
      await db.query("release savepoint s");
      return null;
    } catch (e) {
      await db.query("rollback to savepoint s");
      return (e as Error).message;
    }
  };
  const card = async (tenant = T): Promise<string> =>
    (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [tenant, JSON.stringify(body())])).id;
  const decision = async (status = "proposed", approved_by: string | null = null): Promise<string> => {
    await db.query("set local zavi.email_card_approve = 'on'");
    const id = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', $2, $3, $4) returning id", [T, JSON.stringify(body()), status, approved_by])).id;
    await db.query("set local zavi.email_card_approve = ''");
    return id;
  };
  const approveViaCard = async (id: string) => {
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER]);
    await r("select record_email_test_send($1, 'channel_actions', $2, 1, $3, $4) r", [T, id, OWNER, pre.test_sha]);
    return r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 100) r", [T, id, OWNER, randomUUID()]);
  };

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER_T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'viewer')", [T, OWNER, VIEWER]);
    for (const s of SQL) await db.query(s);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  describe("decisions", () => {
    it("an approved body never changes, nor its approver or source, on any status", async () => {
      for (const status of ["approved", "dispatching", "acted", "dispatch_failed", "proposed"]) {
        const id = await decision(status, OWNER);
        expect(await attempt("update decisions set body = body || '{\"chosen_variant\":2}' where id = $1", [id])).toMatch(REFUSED);
        expect(await attempt("update decisions set approved_by = null where id = $1", [id])).toMatch(REFUSED);
        expect(await attempt("update decisions set approved_by_source = 'cgo' where id = $1", [id])).toMatch(REFUSED);
      }
    });

    it("a released claim (proposed, approver kept) is not open: no test, edit or redraft", async () => {
      const id = await decision("proposed", OWNER);
      expect(await r("select email_card_for_test($1, 'decisions', $2, 1, $3) r", [T, id, OWNER])).toMatchObject({ ok: false, code: "not_open" });
      const read = (await one<{ b: unknown }>("select body b from decisions where id = $1", [id])).b;
      expect(await r("select edit_email_card_variant($1, 'decisions', $2, 1, $3, $4, $5) r", [T, id, OWNER, JSON.stringify(read), JSON.stringify(v(1, "<p>x</p>"))])).toMatchObject({ ok: false, code: "not_open" });
      const fresh = await decision();
      expect(await r("select replace_email_card($1, 'decisions', $2, 'decisions', $3) r", [T, id, fresh])).toMatchObject({ ok: true, replaced: false });
      expect(await one("select status from decisions where id = $1", [id])).toEqual({ status: "proposed" });
    });
  });

  describe("channel_actions", () => {
    it("a queued or approved card cannot be reset to never-approved, and Autopilot cannot re-approve it as fresh", async () => {
      const id = await card();
      expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, $5) r", [T, id, `cgo:${id}`, OWNER, 240])).toMatchObject({ ok: true, replayed: false });
      expect(await attempt("update channel_actions set exec_status = null where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set approved_by = null where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set approved_by_source = null where id = $1", [id])).toMatch(REFUSED);
      expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, $5) r", [T, id, `cgo:${id}`, OWNER, 240])).toMatchObject({ ok: true, replayed: true });
    });

    it("a failed attempt keeps its approval: payload frozen, no reset, not open; Try again goes through the email card", async () => {
      const id = await card();
      expect(await approveViaCard(id)).toMatchObject({ ok: true });
      await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [id]);
      await db.query("update channel_actions set exec_status = 'failed', exec_result = '{\"code\":\"email_tool_not_connected\"}' where id = $1", [id]);
      expect(await attempt("update channel_actions set exec_payload = exec_payload || '{\"chosen_variant\":2}' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set exec_status = null where id = $1", [id])).toMatch(REFUSED);
      expect(await r("select email_card_for_test($1, 'channel_actions', $2, 1, $3) r", [T, id, OWNER])).toMatchObject({ ok: false, code: "not_open" });
      expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 100) r", [T, id, OWNER, randomUUID()])).toMatchObject({ ok: true });
      expect(await one("select exec_status from channel_actions where id = $1", [id])).toEqual({ exec_status: "queued" });
    });
  });
});
