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
const ADMIN = randomUUID();
const sha = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number, html = `<p>version ${n}</p>`) => ({ content: { subject: `Subject ${n}` }, html, text: `version ${n}`, render_sha: sha(html, `version ${n}`) });
const body = () => ({ tool: "sendgrid", audience_id: "list-1", variants: [v(1), v(2)], template_snapshot: { brand_color: "#2e7d32" }, renderer_version: "email-r1" });
const REFUSED = /email_card_approve_required/;

describe.skipIf(!PG_URL)("20261031190900 email card retry and lanes, live", () => {
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
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'viewer'), ($1, $4, 'admin')", [T, OWNER, VIEWER, ADMIN]);
    for (const s of SQL) await db.query(s);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  const failedCard = async (result: Record<string, unknown>) => {
    const id = await card();
    expect(await approveViaCard(id)).toMatchObject({ ok: true });
    await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [id]);
    await db.query("update channel_actions set exec_status = 'failed', exec_result = $2 where id = $1", [id, JSON.stringify(result)]);
    return id;
  };
  const retry = (id: string, user = ADMIN, count: number | null = 260) =>
    r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, user, randomUUID(), count]);

  describe("channel_actions lanes", () => {
    it("failed only from queued or dispatching; the payload is frozen once exec_status is set", async () => {
      const fresh = await card();
      expect(await attempt("update channel_actions set exec_status = 'failed' where id = $1", [fresh])).toMatch(REFUSED);
      const id = await failedCard({ code: "email_tool_not_connected", error: "SendGrid is not connected." });
      expect(await attempt("update channel_actions set exec_payload = exec_payload || '{\"approved_count\":1}' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set exec_status = 'dispatching' where id = $1", [id])).toMatch(REFUSED);
      const done = await card();
      expect(await approveViaCard(done)).toMatchObject({ ok: true });
      await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [done]);
      await db.query("update channel_actions set exec_status = 'executed' where id = $1", [done]);
      expect(await attempt("update channel_actions set exec_status = 'failed' where id = $1", [done])).toMatch(REFUSED);
    });
  });

  describe("Try again", () => {
    it("keeps the original approver, records who retried, restamps only the count", async () => {
      const id = await failedCard({ code: "email_tool_not_connected", error: "SendGrid is not connected." });
      const view = await r("select email_card_view_state($1, 'channel_actions', $2, $3) r", [T, id, ADMIN]);
      expect(view).toMatchObject({ open: false, status: "failed", retryable: true, failure_reason: "SendGrid is not connected." });
      expect(await retry(id)).toMatchObject({ ok: true, replayed: false });
      expect(await one("select exec_status, approved_by, exec_payload->'approved_count' ac, exec_payload->'chosen_variant' cv from channel_actions where id = $1", [id])).toEqual({
        exec_status: "queued",
        approved_by: OWNER,
        ac: 260,
        cv: 1,
      });
      expect(await one("select actor_user_id from channel_action_events where action_id = $1 and event = 'approved' order by at desc, id desc limit 1", [id])).toEqual({ actor_user_id: ADMIN });
    });

    it("an approval is never rewritten, not even under the flag", async () => {
      const id = await failedCard({ code: "email_tool_not_connected" });
      await db.query("savepoint s");
      await db.query("set local zavi.email_card_approve = 'on'");
      const err = await db.query("update channel_actions set approved_by = $2 where id = $1", [id, ADMIN]).then(() => null, (e: Error) => e.message);
      await db.query("rollback to savepoint s");
      expect(err).toMatch(REFUSED);
    });

    it("no count, a send that may have gone out, or a card nobody approved: refused", async () => {
      const id = await failedCard({ code: "email_tool_not_connected" });
      expect(await retry(id, ADMIN, null)).toEqual({ ok: false, code: "count_required" });
      expect(await one("select exec_status from channel_actions where id = $1", [id])).toEqual({ exec_status: "failed" });
      for (const result of [{ code: "exec_partial" }, { code: "exec_outcome_unknown" }, { bucket: "blocked_on_us" }, { bucket: "partial_risk" }]) {
        const stuck = await failedCard(result);
        expect(await r("select email_card_view_state($1, 'channel_actions', $2, $3) r", [T, stuck, ADMIN])).toMatchObject({ retryable: false });
        expect(await retry(stuck)).toEqual({ ok: false, code: "exec_partial_no_retry" });
      }
      const rejected = await card();
      await db.query("update channel_actions set status = 'rejected' where id = $1", [rejected]);
      expect(await retry(rejected)).toMatchObject({ ok: false, code: "not_open" });
    });

    it("a failed card that later went stale or was rejected shows no Try again, and Try again is refused", async () => {
      for (const status of ["stale", "rejected"]) {
        const id = await failedCard({ code: "email_tool_not_connected" });
        expect(await r("select email_card_view_state($1, 'channel_actions', $2, $3) r", [T, id, ADMIN])).toMatchObject({ retryable: true });
        await db.query("update channel_actions set status = $2 where id = $1", [id, status]);
        expect(await r("select email_card_view_state($1, 'channel_actions', $2, $3) r", [T, id, ADMIN])).toMatchObject({ retryable: false });
        expect(await retry(id)).toMatchObject({ ok: false, code: "not_open" });
      }
    });
  });

  describe("decision lanes", () => {
    it("into a go status only approved -> dispatching, a released claim -> dispatching, dispatching -> acted", async () => {
      for (const [from, to] of [["acted", "dispatching"], ["acted", "approved"], ["dispatch_failed", "approved"], ["dispatch_failed", "dispatching"], ["approved", "acted"], ["dispatching", "approved"]]) {
        const id = await decision(from, OWNER);
        expect(await attempt("update decisions set status = $2 where id = $1", [id, to])).toMatch(REFUSED);
      }
      const ok = await decision("approved", OWNER);
      for (const to of ["dispatching", "proposed", "dispatching", "acted"]) {
        expect(await attempt("update decisions set status = $2 where id = $1", [ok, to])).toBeNull();
      }
    });

    it("once approved, back to proposed only as a released claim", async () => {
      for (const from of ["approved", "acted", "dispatch_failed"]) {
        const id = await decision(from, OWNER);
        expect(await attempt("update decisions set status = 'proposed' where id = $1", [id])).toMatch(REFUSED);
      }
    });
  });
});
