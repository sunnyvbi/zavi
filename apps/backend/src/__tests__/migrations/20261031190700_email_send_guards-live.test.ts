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

describe.skipIf(!PG_URL)("20261031190700 email send guards, live", () => {
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
    for (const from of ["expired", "superseded", "rejected", "archived"]) {
      it(`a ${from} email decision cannot be moved to a go status`, async () => {
        const id = await decision(from);
        for (const to of ["approved", "dispatching", "acted"]) {
          expect(await attempt("update decisions set status = $2 where id = $1", [id, to])).toMatch(REFUSED);
        }
      });
    }

    it("a never-approved proposed row cannot be claimed or approved, and no approver can be set", async () => {
      const id = await decision();
      expect(await attempt("update decisions set status = 'dispatching' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update decisions set status = 'approved' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update decisions set approved_by = $2 where id = $1", [id, OWNER])).toMatch(REFUSED);
    });

    it("a row approved under the flag still moves through dispatch, and a released claim can be re-claimed", async () => {
      const id = await decision("approved", OWNER);
      expect(await attempt("update decisions set status = 'dispatching' where id = $1", [id])).toBeNull();
      expect(await attempt("update decisions set status = 'proposed' where id = $1", [id])).toBeNull();
      expect(await attempt("update decisions set status = 'dispatching' where id = $1", [id])).toBeNull();
      expect(await attempt("update decisions set status = 'acted' where id = $1", [id])).toBeNull();
      const released = await decision("proposed", OWNER);
      expect(await attempt("update decisions set status = 'approved' where id = $1", [released])).toMatch(REFUSED);
    });
  });

  describe("channel_actions", () => {
    it("no writer can queue, claim, approve or execute an email card without the flag", async () => {
      const id = await card();
      expect(await attempt("update channel_actions set exec_status = 'queued' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set exec_status = 'dispatching' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set exec_status = 'executed' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set approved_by = $2 where id = $1", [id, OWNER])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set approved_by_source = 'cgo' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set exec_class = 'meta_ads.set_status' where id = $1", [id])).toMatch(REFUSED);
      expect(
        await attempt("insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, approved_by) values ($1, 'email_campaign.create_and_send', '{}', 'queued', $2)", [T, OWNER]),
      ).toMatch(REFUSED);
      expect(await attempt("update channel_actions set exec_status = 'failed' where id = $1", [id])).toMatch(REFUSED);
    });

    it("after a real approve: the worker's moves pass, the sealed payload is frozen", async () => {
      const id = await card();
      expect(await approveViaCard(id)).toMatchObject({ ok: true });
      expect(await one("select exec_status, exec_payload->'chosen_variant' cv from channel_actions where id = $1", [id])).toEqual({ exec_status: "queued", cv: 1 });
      expect(await attempt("update channel_actions set exec_payload = exec_payload || '{\"chosen_variant\":2}' where id = $1", [id])).toMatch(REFUSED);
      expect(await attempt("update channel_actions set exec_status = 'dispatching' where id = $1", [id])).toBeNull();
      expect(await attempt("update channel_actions set exec_status = 'queued' where id = $1", [id])).toBeNull();
      expect(await attempt("update channel_actions set exec_status = 'dispatching' where id = $1", [id])).toBeNull();
      expect(await attempt("update channel_actions set exec_status = 'executed' where id = $1", [id])).toBeNull();
    });

    it("Autopilot still approves and stamps version 1 and its count", async () => {
      const id = (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [T, JSON.stringify({ ...body(), audience_id: "list-autopilot" })])).id;
      expect(await r("select approve_email_campaign_send_as_cgo($1, $2, $3, $4, $5) r", [T, id, `cgo:${id}`, OWNER, 240])).toMatchObject({ ok: true });
      expect(await one("select exec_status, exec_payload->'chosen_variant' cv, exec_payload->'approved_count' ac from channel_actions where id = $1", [id])).toEqual({ exec_status: "queued", cv: 1, ac: 240 });
    });
  });

  describe("edit and replace", () => {
    it("a viewer cannot edit; bytes that do not hash to their seal are refused; good bytes land", async () => {
      const id = await card();
      const read = (await one<{ b: unknown }>("select exec_payload b from channel_actions where id = $1", [id])).b;
      const good = v(1, "<p>edited</p>");
      expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, VIEWER, JSON.stringify(read), JSON.stringify(good)])).toEqual({ ok: false, code: "not_authorized" });
      expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, OWNER, JSON.stringify(read), JSON.stringify({ ...good, html: "<p>swapped</p>" })])).toEqual({ ok: false, code: "bad_variant" });
      expect(await r("select edit_email_card_variant($1, 'channel_actions', $2, 1, $3, $4, $5) r", [T, id, OWNER, JSON.stringify(read), JSON.stringify(good)])).toMatchObject({ ok: true });
    });

    it("a redraft must point at an email card of the same workspace", async () => {
      const old = await card();
      expect(await r("select replace_email_card($1, 'channel_actions', $2, 'channel_actions', $3) r", [T, old, randomUUID()])).toEqual({ ok: false, code: "not_found" });
      expect(await r("select replace_email_card($1, 'channel_actions', $2, 'channel_actions', $3) r", [T, old, await card(OTHER_T)])).toEqual({ ok: false, code: "not_found" });
      expect(await r("select replace_email_card($1, 'channel_actions', $2, 'channel_actions', $3) r", [T, old, await card()])).toEqual({ ok: true, replaced: true });
    });
  });
});
