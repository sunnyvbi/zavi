import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_SQL } from "./email-card-live-migrations";
import { EMAIL_CARD_APPROVE_REQUIRED, EMAIL_CARD_CLASSES } from "@/services/email-cards/approve-gate";

const BOOTSTRAP = EMAIL_CARD_BOOTSTRAP;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const OWNER = randomUUID();

describe.skipIf(!PG_URL)("20261031190300 email card choke point, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> =>
    (await db.query(sql, params)).rows[0] as R;
  const card = async (exec_class: string, audience = randomUUID()): Promise<string> =>
    (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, $2, $3) returning id",
      [T, exec_class, JSON.stringify({ tool: "sendgrid", audience_id: audience })],
    )).id;
  const approve = (id: string) =>
    one<{ r: Record<string, unknown> }>("select approve_channel_action($1, $2, $3, $4) r", [T, id, randomUUID(), OWNER]).then((x) => x.r);
  const cgoApprove = (id: string) =>
    one<{ r: Record<string, unknown> }>("select approve_email_campaign_send_as_cgo($1, $2, $3, $4) r", [T, id, `cgo:${id}`, OWNER]).then((x) => x.r);
  const decision = async (decision_class: string, status = "proposed"): Promise<string> =>
    (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, status) values ($1, $2, $3) returning id", [T, decision_class, status])).id;
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

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database (channel_actions already exists)");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
    for (const sql of EMAIL_CARD_SQL) await db.query(sql);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  describe("channel actions rail", () => {
    for (const cls of EMAIL_CARD_CLASSES) {
      it(`a direct approve of a ${cls} card is refused and writes nothing`, async () => {
        const id = await card(cls);
        expect(await approve(id)).toEqual({ ok: false, code: EMAIL_CARD_APPROVE_REQUIRED });
        const r = await one<{ exec_status: string | null; n: string }>(
          "select exec_status, (select count(*) from channel_action_events where action_id = $1) n from channel_actions where id = $1",
          [id],
        );
        expect(r).toEqual({ exec_status: null, n: "0" });
      });
    }

    it("the Autopilot email door still queues the card, stamped cgo", async () => {
      const id = await card("email_campaign.create_and_send");
      expect(await cgoApprove(id)).toMatchObject({ ok: true, replayed: false, attempt: 1 });
      expect(await one("select exec_status, approved_by_source from channel_actions where id = $1", [id])).toEqual({
        exec_status: "queued",
        approved_by_source: "cgo",
      });
    });

    it("the flag does not outlive the cgo call in the same transaction", async () => {
      const a = await card("email_campaign.create_and_send");
      const b = await card("email_campaign.create_and_send");
      await cgoApprove(a);
      expect(await approve(b)).toEqual({ ok: false, code: EMAIL_CARD_APPROVE_REQUIRED });
    });

    it("an ad card approves exactly as before", async () => {
      const id = await card("meta_ads.set_status");
      expect(await approve(id)).toMatchObject({ ok: true, replayed: false });
    });
  });

  describe("decisions rail (trigger)", () => {
    const approveSql = "update decisions set status = 'approved', approved_by = $2, approved_at = now() where id = $1";
    for (const cls of EMAIL_CARD_CLASSES) {
      it(`approving a ${cls} decision without the flag is refused`, async () => {
        const id = await decision(cls);
        expect(await attempt(approveSql, [id, OWNER])).toMatch(/^email_card_approve_required/);
        expect(await attempt("update decisions set status = 'dispatching' where id = $1", [id])).toMatch(/^email_card_approve_required/);
        expect(await attempt("update decisions set approved_by = $2 where id = $1", [id, OWNER])).toMatch(/^email_card_approve_required/);
        expect((await one<{ status: string }>("select status from decisions where id = $1", [id])).status).toBe("proposed");
      });
      it(`an approved ${cls} insert is refused; a proposed one is fine`, async () => {
        expect(await attempt("insert into decisions (tenant_id, decision_class, status) values ($1, $2, 'approved')", [T, cls])).toMatch(/^email_card_approve_required/);
        expect(await attempt("insert into decisions (tenant_id, decision_class, status) values ($1, $2, 'proposed')", [T, cls])).toBeNull();
      });
      it(`a ${cls} decision can still be rejected, superseded and expired`, async () => {
        for (const s of ["rejected", "superseded", "expired"]) {
          const id = await decision(cls);
          expect(await attempt("update decisions set status = $2 where id = $1", [id, s])).toBeNull();
        }
      });
    }

    it("the class cannot be changed into or out of an email send class", async () => {
      const a = await decision("support-lead.reply");
      expect(await attempt("update decisions set decision_class = 'bulk_outbound.send' where id = $1", [a])).toMatch(/^email_card_approve_required/);
      const b = await decision("bulk_outbound.send");
      expect(await attempt("update decisions set decision_class = 'support-lead.reply' where id = $1", [b])).toMatch(/^email_card_approve_required/);
    });

    it("under the flag the approve goes through, and a released claim can be re-claimed", async () => {
      const id = await decision("bulk_outbound.send");
      await db.query("savepoint f");
      await db.query("select set_config('zavi.email_card_approve', 'on', true)");
      expect(await attempt(approveSql, [id, OWNER])).toBeNull();
      await db.query("select set_config('zavi.email_card_approve', '', true)");
      await db.query("release savepoint f");
      expect(await attempt("update decisions set status = 'dispatching' where id = $1 and status in ('approved','proposed')", [id])).toBeNull();
      expect(await attempt("update decisions set status = 'proposed' where id = $1", [id])).toBeNull();
      expect(await attempt("update decisions set status = 'dispatching' where id = $1 and status in ('approved','proposed')", [id])).toBeNull();
      expect(await attempt("update decisions set status = 'acted' where id = $1", [id])).toBeNull();
    });

    it("other classes are untouched (a null class too)", async () => {
      const id = await decision("support-lead.reply");
      expect(await attempt(approveSql, [id, OWNER])).toBeNull();
      const n = await one<{ id: string }>("insert into decisions (tenant_id, decision_class) values ($1, null) returning id", [T]);
      expect(await attempt(approveSql, [n.id, OWNER])).toBeNull();
    });
  });
});
